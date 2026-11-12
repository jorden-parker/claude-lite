import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRemoteHost, unloadModels } from "./ollama/api.ts";
import { renderLaunchSettings, type Runner, runClaude, spawnRunner } from "./ollama/launch.ts";
import { resolveSize, type Size } from "./ollama/sizes.ts";

export const MLX_URL = "http://127.0.0.1:11435";
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

const DEFAULTS: MlxDependencies = {
  run: spawnRunner,
  startServer: spawnServer,
  unload: unloadModels,
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
    new URL(MLX_URL).port,
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

const isServing = async (run: Runner) =>
  (await run(["curl", "-sf", "-o", "/dev/null", "--max-time", "2", `${MLX_URL}/v1/models`])) === 0;

async function waitUntilReady(server: MlxServer, run: Runner, pollDelayMs: number) {
  let hasExited = false;
  void server.exited.then(() => {
    hasExited = true;
  });
  for (;;) {
    await Bun.sleep(pollDelayMs);
    if (hasExited) return false;
    if (await isServing(run)) return true;
  }
}

export async function launchMlx(
  home: string,
  args: string[],
  overrides: Partial<MlxDependencies> = {},
): Promise<number> {
  const { run, startServer, unload, pollDelayMs } = { ...DEFAULTS, ...overrides };
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
  if (await isServing(run)) {
    console.error(`something already serves on ${MLX_URL}; stop it (pkill -f vllm-mlx) and retry`);
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
  if (!isRemoteHost()) {
    const unloaded = await unload();
    if (unloaded.length) console.log(`unloaded Ollama models: ${unloaded.join(", ")}`);
  }
  console.log(`starting vllm-mlx for ${model}; log: ${logPath()}`);
  const server = startServer(command, logPath());
  const dir = mkdtempSync(join(tmpdir(), "claude-lite-mlx-"));
  try {
    if (!(await waitUntilReady(server, run, pollDelayMs))) {
      console.error(`vllm-mlx exited before it was ready; see ${logPath()}`);
      return 1;
    }
    return await runClaude({ dir, home, model, settings, claudeArgs, url: MLX_URL }, run);
  } finally {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
