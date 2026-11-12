import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRemoteHost, unloadModels } from "./ollama/api.ts";
import { renderLaunchSettings, type Runner, runClaude, spawnRunner } from "./ollama/launch.ts";
import { loadSizes, resolveSize, type Size } from "./ollama/sizes.ts";
import { runQwen } from "./qwen.ts";

const DEFAULT_MLX_PORT = "8435";

export function mlxUrl(env: Record<string, string | undefined> = process.env): string {
  const port = env.CLAUDE_LITE_MLX_PORT?.trim() || DEFAULT_MLX_PORT;
  if (!/^\d{1,5}$/.test(port))
    throw new Error(`CLAUDE_LITE_MLX_PORT must be a port number, not ${port}`);
  return `http://127.0.0.1:${port}`;
}

const mlxPort = () => new URL(mlxUrl()).port;
export const MLX_SERVER_PATTERN = "omlx-server|omlx.* serve";
const STOP_HINT = "cl stop";
const PYTHON = "3.12";
const OMLX_INSTALL_HINT =
  "brew tap jundot/omlx https://github.com/jundot/omlx && brew install jundot/omlx/omlx --with-custom-kernel (needs full Xcode; without it: brew install jundot/omlx/omlx)";
const SERVER_SSD_CACHE = "20GB";
const SAMPLING = ["temperature", "top_p", "top_k", "min_p", "presence_penalty"];
const CACHE_STORED = "Using boundary cache snapshot for";
const CACHE_SKIP_REASON = /Skipping cache store.*reason=(\w+)/;

type MlxServer = { exited: Promise<number>; stop: () => void };

type MlxDependencies = {
  run: Runner;
  startServer: (argv: string[], logPath: string) => MlxServer;
  unload: () => Promise<string[]>;
  servedModels: () => Promise<string[] | null>;
  isOmlxInstalled: () => boolean;
  writeModelSettings: (path: string, document: unknown) => void;
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
    response = await fetch(`${mlxUrl()}/v1/models`, { signal: AbortSignal.timeout(2000) });
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

function writeModelSettingsFile(path: string, document: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(document, null, 2));
}

const DEFAULTS: MlxDependencies = {
  run: spawnRunner,
  startServer: spawnServer,
  unload: unloadModels,
  servedModels: fetchServedModels,
  isOmlxInstalled: () => Bun.which("omlx") !== null,
  writeModelSettings: writeModelSettingsFile,
  pollDelayMs: 1000,
};

export const mlxLogPath = (userHome: string) =>
  join(userHome, ".cache", "claude-lite", "mlx-server.log");

export const omlxDataDir = (userHome: string) => join(userHome, ".cache", "claude-lite", "omlx");

export const servedModelId = (repo: string) => repo.replaceAll("/", "--");

export type MlxLogHealth = { cacheStores: number; cacheSkipReasons: string[] };

export function readMlxLogHealth(logText: string): MlxLogHealth {
  const reasons = new Set<string>();
  let cacheStores = 0;
  for (const line of logText.split("\n")) {
    if (line.includes(CACHE_STORED)) cacheStores += 1;
    const reason = line.match(CACHE_SKIP_REASON)?.[1];
    if (reason) reasons.add(reason);
  }
  return { cacheStores, cacheSkipReasons: [...reasons] };
}
const logPath = () => mlxLogPath(homedir());

type ModelSettings = Record<string, number | boolean>;

function modelSettings(size: Size): ModelSettings {
  const parameters = size.parameters ?? {};
  const sampling = Object.fromEntries(
    Object.entries(parameters).filter(([name]) => SAMPLING.includes(name)),
  );
  return {
    max_context_window: size.context,
    max_tokens: size.output_tokens,
    ...sampling,
    force_sampling: true,
    enable_thinking: size.thinking,
    preserve_thinking: true,
  };
}

export function modelSettingsDocument(sizes: Record<string, Size>, launched: Size) {
  const models: Record<string, ModelSettings> = {};
  for (const size of [...Object.values(sizes), launched])
    if (size.mlx) models[servedModelId(size.mlx)] = modelSettings(size);
  return { version: 1, models };
}

function serverCommand(dataDir: string): string[] {
  return [
    "omlx",
    "serve",
    "--base-path",
    dataDir,
    "--host",
    "127.0.0.1",
    "--port",
    mlxPort(),
    "--paged-ssd-cache-max-size",
    SERVER_SSD_CACHE,
  ];
}

async function waitUntilReady(
  server: MlxServer,
  servedModels: MlxDependencies["servedModels"],
  pollDelayMs: number,
): Promise<string[] | null> {
  let hasExited = false;
  void server.exited.then(() => {
    hasExited = true;
  });
  for (;;) {
    await Bun.sleep(pollDelayMs);
    if (hasExited) return null;
    const listing = await servedModels();
    if (listing !== null) return listing;
  }
}

export async function launchMlx(
  home: string,
  args: string[],
  overrides: Partial<MlxDependencies> = {},
): Promise<number> {
  const {
    run,
    startServer,
    unload,
    servedModels,
    isOmlxInstalled,
    writeModelSettings,
    pollDelayMs,
  } = { ...DEFAULTS, ...overrides };
  const isPrintOnly = args.includes("--print-config");
  const { name, size, claudeArgs } = resolveSize(
    home,
    args.filter((arg) => arg !== "--print-config"),
  );
  const repo = size.mlx;
  if (!repo) {
    console.error(`size ${name} has no mlx model; add "mlx" to it in config/sizes.json`);
    return 1;
  }
  const model = servedModelId(repo);
  const dataDir = omlxDataDir(homedir());
  const settingsPath = join(dataDir, "model_settings.json");
  const document = modelSettingsDocument(loadSizes(home), size);
  const settings = renderLaunchSettings(home, { ...size, model }, mlxUrl());
  const command = serverCommand(dataDir);
  if (isPrintOnly) {
    console.log(command.join(" "));
    console.log(`model settings: ${settingsPath}`);
    console.log(JSON.stringify(document, null, 2));
    console.log(JSON.stringify(settings, null, 2));
    return 0;
  }
  if (!isOmlxInstalled()) {
    console.error(`oMLX is not installed; install it with ${OMLX_INSTALL_HINT}`);
    return 1;
  }
  const alreadyServed = await servedModels();
  if (alreadyServed?.includes(model)) {
    console.log(
      `reusing the oMLX already serving ${model} on ${mlxUrl()}; it keeps running after claude exits (stop it: ${STOP_HINT})`,
    );
    await unloadOllama(unload);
    return await runClaudeIn(home, size, model, settings, claudeArgs, run);
  }
  if (alreadyServed !== null) {
    console.error(
      `${mlxUrl()} already serves ${alreadyServed.join(", ") || "something that is not oMLX"}, not ${model}; free port ${mlxPort()} (stop a leftover oMLX: ${STOP_HINT})`,
    );
    await run(["lsof", "-nP", `-iTCP:${mlxPort()}`, "-sTCP:LISTEN"]);
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
      repo,
    ])) !== 0
  )
    return 1;
  await unloadOllama(unload);
  writeModelSettings(settingsPath, document);
  console.log(`starting oMLX for ${model}; log: ${logPath()}`);
  const server = startServer(command, logPath());
  try {
    const listing = await waitUntilReady(server, servedModels, pollDelayMs);
    if (listing === null) {
      console.error(`oMLX exited before it was ready; see ${logPath()}`);
      return 1;
    }
    if (!listing.includes(model)) {
      console.error(
        `oMLX does not list ${model}; the model is not in the Hugging Face cache as an MLX model; see ${logPath()}`,
      );
      return 1;
    }
    return await runClaudeIn(home, size, model, settings, claudeArgs, run);
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
  size: Size,
  model: string,
  settings: Record<string, any>,
  claudeArgs: string[],
  run: Runner,
) {
  if (size.qwen) return await runQwen({ model, url: mlxUrl(), args: claudeArgs }, run);
  const dir = mkdtempSync(join(tmpdir(), "claude-lite-mlx-"));
  try {
    return await runClaude({ dir, home, model, settings, claudeArgs, url: mlxUrl() }, run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
