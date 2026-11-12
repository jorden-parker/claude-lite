import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRemoteHost, unloadModels } from "./ollama/api.ts";
import { renderLaunchSettings, type Runner, runClaude, spawnRunner } from "./ollama/launch.ts";
import { resolveSize, type Size } from "./ollama/sizes.ts";

export const MLX_URL = "http://127.0.0.1:11435";
const MLX_PORT = new URL(MLX_URL).port;
const STOP_HINT = "pkill -f 'vllm-mlx.* serve'";
const VLLM_MLX = "vllm-mlx@0.6.0";
const PYTHON = "3.12";
const QWEN_TOOL_PARSER = "qwen3_xml";
const QWEN_REASONING_PARSER = "qwen3";
const SAMPLING = ["temperature", "top_p", "top_k", "min_p", "presence_penalty"];

type MlxServer = { exited: Promise<number>; stop: () => void };

type MlxDependencies = {
  run: Runner;
  startServer: (argv: string[], logPath: string) => MlxServer;
  unload: () => Promise<string[]>;
  servedModels: () => Promise<string[] | null>;
  pollDelayMs: number;
};

function spawnServer(argv: string[], logPath: string): MlxServer {
  mkdirSync(dirname(logPath), { recursive: true });
  const server = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
  });
  return { exited: server.exited, stop: () => server.kill() };
}

async function fetchServedModels(): Promise<string[] | null> {
  let response: Response;
  try {
    response = await fetch(`${MLX_URL}/v1/models`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return null;
  }
  try {
    const listing = (await response.json()) as { data?: { id: string }[] };
    return (listing.data ?? []).map((model) => model.id);
  } catch {
    return [];
  }
}

const DEFAULTS: MlxDependencies = {
  run: spawnRunner,
  startServer: spawnServer,
  unload: unloadModels,
  servedModels: fetchServedModels,
  pollDelayMs: 1000,
};

const logPath = () => join(homedir(), ".cache", "claude-lite", "mlx-server.log");

function samplingFlags(parameters: Record<string, number> = {}): string[] {
  return Object.entries(parameters)
    .filter(([name]) => SAMPLING.includes(name))
    .flatMap(([name, amount]) => [`--default-${name.replaceAll("_", "-")}`, String(amount)]);
}

function serverCommand(size: Size, model: string): string[] {
  return [
    "uvx",
    "--python",
    PYTHON,
    VLLM_MLX,
    "serve",
    model,
    "--host",
    "127.0.0.1",
    "--port",
    MLX_PORT,
    "--enable-auto-tool-choice",
    "--tool-call-parser",
    QWEN_TOOL_PARSER,
    "--reasoning-parser",
    QWEN_REASONING_PARSER,
    "--prefix-trie-cache",
    ...(size.thinking
      ? []
      : ["--default-chat-template-kwargs", JSON.stringify({ enable_thinking: false })]),
    ...samplingFlags(size.parameters),
  ];
}

async function waitUntilReady(
  server: MlxServer,
  servedModels: MlxDependencies["servedModels"],
  pollDelayMs: number,
) {
  let hasExited = false;
  void server.exited.then(() => {
    hasExited = true;
  });
  for (;;) {
    await Bun.sleep(pollDelayMs);
    if (hasExited) return false;
    if ((await servedModels()) !== null) return true;
  }
}

export async function launchMlx(
  home: string,
  args: string[],
  overrides: Partial<MlxDependencies> = {},
): Promise<number> {
  const { run, startServer, unload, servedModels, pollDelayMs } = { ...DEFAULTS, ...overrides };
  const isPrintOnly = args.includes("--print-config");
  const { name, size, claudeArgs } = resolveSize(
    home,
    args.filter((arg) => arg !== "--print-config"),
  );
  const model = size.mlx;
  if (!model) {
    console.error(`size ${name} has no mlx model; add "mlx" to it in config/sizes.json`);
    return 1;
  }
  const settings = renderLaunchSettings(home, { ...size, model }, MLX_URL);
  const command = serverCommand(size, model);
  if (isPrintOnly) {
    console.log(command.join(" "));
    console.log(JSON.stringify(settings, null, 2));
    return 0;
  }
  const alreadyServed = await servedModels();
  if (alreadyServed?.includes(model)) {
    console.log(
      `reusing the vllm-mlx already serving ${model} on ${MLX_URL}; it keeps running after claude exits (stop it: ${STOP_HINT})`,
    );
    await unloadOllama(unload);
    return await runClaudeIn(home, model, settings, claudeArgs, run);
  }
  if (alreadyServed !== null) {
    console.error(
      `${MLX_URL} already serves ${alreadyServed.join(", ") || "something that is not vllm-mlx"}, not ${model}; free port ${MLX_PORT} (stop a leftover vllm-mlx: ${STOP_HINT})`,
    );
    await run(["lsof", "-nP", `-iTCP:${MLX_PORT}`, "-sTCP:LISTEN"]);
    return 1;
  }
  if (
    (await run([
      "uvx",
      "--python",
      PYTHON,
      "--from",
      "huggingface_hub",
      "hf",
      "download",
      model,
    ])) !== 0
  )
    return 1;
  await unloadOllama(unload);
  console.log(`starting vllm-mlx for ${model}; log: ${logPath()}`);
  const server = startServer(command, logPath());
  try {
    if (!(await waitUntilReady(server, servedModels, pollDelayMs))) {
      console.error(`vllm-mlx exited before it was ready; see ${logPath()}`);
      return 1;
    }
    return await runClaudeIn(home, model, settings, claudeArgs, run);
  } finally {
    server.stop();
  }
}

async function unloadOllama(unload: MlxDependencies["unload"]) {
  if (isRemoteHost()) return;
  const unloaded = await unload();
  if (unloaded.length) console.log(`unloaded Ollama models: ${unloaded.join(", ")}`);
}

async function runClaudeIn(
  home: string,
  model: string,
  settings: Record<string, any>,
  claudeArgs: string[],
  run: Runner,
) {
  const dir = mkdtempSync(join(tmpdir(), "claude-lite-mlx-"));
  try {
    return await runClaude({ dir, home, model, settings, claudeArgs, url: MLX_URL }, run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
