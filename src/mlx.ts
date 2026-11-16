import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { COMMAND_HELP } from "./help.ts";
import { isRemoteHost, unloadModels } from "./ollama/api.ts";
import { renderLaunchSettings, type Runner, runClaude, spawnRunner } from "./ollama/launch.ts";
import { loadSizes, resolveSize, type Size } from "./ollama/sizes.ts";
import { runOpenCode } from "./opencode.ts";
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
const SPLASH_ENGINE = "splash";
const SPLASH_INSTALL_HINT = "brew install incoai/tap/splash";
const SERVER_SSD_CACHE = "20GB";
const MEMORY_GUARD_TIER = "aggressive";
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
  isSplashInstalled: () => boolean;
  writeModelSettings: (path: string, document: unknown) => void;
  awaitShutdown: (server: MlxServer) => Promise<number>;
  sessionsDir: string;
  pollDelayMs: number;
};

export function spawnServer(argv: string[], logPath: string): MlxServer {
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "w");
  const server = Bun.spawn(argv, { stdin: "ignore", stdout: logFd, stderr: logFd });
  closeSync(logFd);
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function countOtherLiveSessions(sessionsDir: string): number {
  if (!existsSync(sessionsDir)) return 0;
  return readdirSync(sessionsDir)
    .map(Number)
    .filter((pid) => pid !== process.pid && isProcessAlive(pid)).length;
}

async function withSessionRecorded(sessionsDir: string, runSession: () => Promise<number>) {
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, String(process.pid));
  writeFileSync(sessionFile, "");
  try {
    return await runSession();
  } finally {
    rmSync(sessionFile, { force: true });
  }
}

export const omlxDataDir = (userHome: string) => join(userHome, ".cache", "claude-lite", "omlx");

const DEFAULTS: MlxDependencies = {
  run: spawnRunner,
  startServer: spawnServer,
  unload: unloadModels,
  servedModels: fetchServedModels,
  isOmlxInstalled: () => Bun.which("omlx") !== null,
  isSplashInstalled: () => Bun.which(SPLASH_ENGINE) !== null,
  writeModelSettings: writeModelSettingsFile,
  awaitShutdown: waitForShutdown,
  sessionsDir: join(omlxDataDir(homedir()), "sessions"),
  pollDelayMs: 1000,
};

export const mlxLogPath = (userHome: string) =>
  join(userHome, ".cache", "claude-lite", "mlx-server.log");

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

type ModelSettings = Record<string, number | boolean | string>;

const speculativeDecoding = (size: Size, hasSplash: boolean): ModelSettings => {
  if (hasSplash && size.mlx_dflash)
    return { external_engine: SPLASH_ENGINE, dflash_draft_model: servedModelId(size.mlx_dflash) };
  if (size.mlx_draft) return { vlm_mtp_enabled: true, vlm_mtp_draft_model: size.mlx_draft };
  return {};
};

function modelSettings(size: Size, hasSplash: boolean): ModelSettings {
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
    ...speculativeDecoding(size, hasSplash),
  };
}

export function modelSettingsDocument(
  sizes: Record<string, Size>,
  launched: Size,
  hasSplash = false,
) {
  const models: Record<string, ModelSettings> = {};
  for (const size of [...Object.values(sizes), launched])
    if (size.mlx) models[servedModelId(size.mlx)] = modelSettings(size, hasSplash);
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
    "--memory-guard",
    MEMORY_GUARD_TIER,
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

export const draftRepoOf = (drafted: Size, hasSplash: boolean) =>
  hasSplash && drafted.mlx_dflash ? drafted.mlx_dflash : drafted.mlx_draft;

const reposToDownload = (served: (Size | undefined)[], hasSplash: boolean) =>
  served
    .filter((size): size is Size => size !== undefined)
    .flatMap((size) => [size.mlx, draftRepoOf(size, hasSplash)])
    .filter((repo): repo is string => repo !== undefined);

function warnWithoutSplash(name: string, size: Size, hasSplash: boolean) {
  if (size.mlx_dflash && !hasSplash)
    console.error(
      `claude-lite: splash is not installed, so ${name} runs on oMLX's slower MTP engine; install it with ${SPLASH_INSTALL_HINT}`,
    );
}

type ServerPlan = {
  name: string;
  size: Size;
  claudeArgs: string[];
  model: string;
  visionSize?: Size;
  hasSplash: boolean;
  document: ReturnType<typeof modelSettingsDocument>;
  settingsPath: string;
  command: string[];
};

function planServer(home: string, args: string[], hasSplash: boolean): ServerPlan | undefined {
  const { name, size, claudeArgs } = resolveSize(
    home,
    args.filter((arg) => arg !== "--print-config"),
  );
  if (!size.mlx) {
    console.error(`size ${name} has no mlx model; add "mlx" to it in config/sizes.json`);
    return undefined;
  }
  const sizes = loadSizes(home);
  const dataDir = omlxDataDir(homedir());
  warnWithoutSplash(name, size, hasSplash);
  return {
    name,
    size,
    claudeArgs,
    model: servedModelId(size.mlx),
    visionSize: size.vision_size ? sizes[size.vision_size] : undefined,
    hasSplash,
    document: modelSettingsDocument(sizes, size, hasSplash),
    settingsPath: join(dataDir, "model_settings.json"),
    command: serverCommand(dataDir),
  };
}

function printServerConfig(plan: ServerPlan) {
  console.log(plan.command.join(" "));
  console.log(`model settings: ${plan.settingsPath}`);
  console.log(JSON.stringify(plan.document, null, 2));
}

type ServerStart = { kind: "failed" } | { kind: "reused" } | { kind: "started"; server: MlxServer };

async function ensureServer(deps: MlxDependencies, plan: ServerPlan): Promise<ServerStart> {
  if (!deps.isOmlxInstalled()) {
    console.error(`oMLX is not installed; install it with ${OMLX_INSTALL_HINT}`);
    return { kind: "failed" };
  }
  const alreadyServed = await deps.servedModels();
  if (alreadyServed?.includes(plan.model)) {
    await unloadOllama(deps.unload);
    return { kind: "reused" };
  }
  if (alreadyServed !== null) {
    console.error(
      `${mlxUrl()} already serves ${alreadyServed.join(", ") || "something that is not oMLX"}, not ${plan.model}; free port ${mlxPort()} (stop a leftover oMLX: ${STOP_HINT})`,
    );
    await deps.run(["lsof", "-nP", `-iTCP:${mlxPort()}`, "-sTCP:LISTEN"]);
    return { kind: "failed" };
  }
  for (const downloadRepo of reposToDownload([plan.size, plan.visionSize], plan.hasSplash))
    if (
      (await deps.run([
        "uvx",
        "--python",
        PYTHON,
        "--from",
        "huggingface_hub",
        "hf",
        "download",
        downloadRepo,
      ])) !== 0
    )
      return { kind: "failed" };
  await unloadOllama(deps.unload);
  deps.writeModelSettings(plan.settingsPath, plan.document);
  console.log(`starting oMLX for ${plan.model}; log: ${logPath()}`);
  const server = deps.startServer(plan.command, logPath());
  const listing = await waitUntilReady(server, deps.servedModels, deps.pollDelayMs);
  if (listing?.includes(plan.model)) return { kind: "started", server };
  if (listing === null) console.error(`oMLX exited before it was ready; see ${logPath()}`);
  else
    console.error(
      `oMLX does not list ${plan.model}; the model is not in the Hugging Face cache as an MLX model; see ${logPath()}`,
    );
  server.stop();
  return { kind: "failed" };
}

function stopUnlessShared(server: MlxServer, sessionsDir: string) {
  const otherSessions = countOtherLiveSessions(sessionsDir);
  if (otherSessions === 0) server.stop();
  else
    console.log(
      `leaving oMLX running for ${otherSessions} other cl mlx session(s) (stop it: ${STOP_HINT})`,
    );
}

export async function launchMlx(
  home: string,
  args: string[],
  overrides: Partial<MlxDependencies> = {},
): Promise<number> {
  const deps = { ...DEFAULTS, ...overrides };
  const plan = planServer(home, args, deps.isSplashInstalled());
  if (!plan) return 1;
  const settings = renderLaunchSettings(home, { ...plan.size, model: plan.model }, mlxUrl());
  if (args.includes("--print-config")) {
    printServerConfig(plan);
    console.log(JSON.stringify(settings, null, 2));
    return 0;
  }
  const start = await ensureServer(deps, plan);
  if (start.kind === "failed") return 1;
  if (start.kind === "reused")
    console.log(
      `reusing the oMLX already serving ${plan.model} on ${mlxUrl()}; it keeps running after claude exits (stop it: ${STOP_HINT})`,
    );
  try {
    return await withSessionRecorded(deps.sessionsDir, () =>
      runClaudeIn(
        home,
        plan.size,
        plan.model,
        settings,
        plan.claudeArgs,
        deps.run,
        plan.visionSize?.mlx,
      ),
    );
  } finally {
    if (start.kind === "started") stopUnlessShared(start.server, deps.sessionsDir);
  }
}

export async function serveMlx(
  home: string,
  args: string[],
  overrides: Partial<MlxDependencies> = {},
): Promise<number> {
  const deps = { ...DEFAULTS, ...overrides };
  const sizes = loadSizes(home);
  if (!args.every((arg) => arg === "--print-config" || Object.hasOwn(sizes, arg))) {
    console.error(COMMAND_HELP.serve);
    return 2;
  }
  const plan = planServer(home, args, deps.isSplashInstalled());
  if (!plan) return 1;
  if (args.includes("--print-config")) {
    printServerConfig(plan);
    return 0;
  }
  const start = await ensureServer(deps, plan);
  if (start.kind === "failed") return 1;
  if (start.kind === "reused") {
    console.log(`oMLX is already serving ${plan.model} on ${mlxUrl()}; nothing started`);
    return 0;
  }
  console.log(`oMLX ready at ${mlxUrl()}, serving ${plan.model}; Ctrl-C stops it`);
  const code = await deps.awaitShutdown(start.server);
  start.server.stop();
  console.log("stopped oMLX");
  return code;
}

function waitForShutdown(server: MlxServer): Promise<number> {
  return new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve(0));
    void server.exited.then(resolve);
  });
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
  visionRepo?: string,
) {
  const visionModel = visionRepo && servedModelId(visionRepo);
  const client = { model, url: mlxUrl(), args: claudeArgs, visionModel };
  if (size.qwen) return await runQwen(client, run);
  if (size.opencode) return await runOpenCode(client, run);
  const dir = mkdtempSync(join(tmpdir(), "claude-lite-mlx-"));
  try {
    return await runClaude(
      { dir, home, model, settings, claudeArgs, url: mlxUrl(), visionModel },
      run,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
