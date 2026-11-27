import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { COMMAND_HELP } from "./help.ts";
import { isRemoteHost, ollamaUrl, unloadModels } from "./ollama/api.ts";
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

const downloadArgv = (repo: string) => [
  "uvx",
  "--python",
  PYTHON,
  "--from",
  "huggingface_hub",
  "hf",
  "download",
  repo,
];

async function downloadRepo(repo: string, run: Runner = spawnRunner): Promise<number> {
  return run(downloadArgv(repo));
}

type MlxServer = { exited: Promise<number>; stop: () => void; pid?: number };

type MlxDependencies = {
  run: Runner;
  startServer: (argv: string[], logPath: string) => MlxServer;
  unload: () => Promise<string[]>;
  servedModels: () => Promise<string[] | null>;
  isOmlxInstalled: () => boolean;
  isSplashInstalled: () => boolean;
  isRepoCached: (repo: string) => boolean;
  writeModelSettings: (path: string, document: unknown) => void;
  awaitShutdown: (server: MlxServer) => Promise<number>;
  sessionsDir: string;
  pollDelayMs: number;
  listeningPids: () => number[];
};

export function spawnServer(argv: string[], logPath: string, env = process.env): MlxServer {
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "w");
  let server: ReturnType<typeof Bun.spawn>;
  try {
    server = Bun.spawn(argv, { stdin: "ignore", stdout: logFd, stderr: logFd, env });
  } finally {
    closeSync(logFd);
  }
  return { exited: server.exited, stop: () => server.kill(), pid: server.pid };
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

function managedServerMarkerPath(sessionsDir: string, pid: number) {
  return join(sessionsDir, "managed", `${pid}.json`);
}

function hasMatchingManagedServer(deps: MlxDependencies, plan: ServerPlan): boolean {
  const dir = join(deps.sessionsDir, "managed");
  if (!existsSync(dir)) return false;
  const listening = new Set(deps.listeningPids());
  return readdirSync(dir).some((file) => {
    if (!file.endsWith(".json")) return false;
    const pid = Number(file.slice(0, -5));
    if (!Number.isInteger(pid) || !isProcessAlive(pid) || !listening.has(pid)) return false;
    try {
      const marker = JSON.parse(readFileSync(join(dir, file), "utf8"));
      return (
        marker.pid === pid &&
        marker.port === mlxPort() &&
        marker.model === plan.model &&
        marker.engine === plan.engine
      );
    } catch {
      return false;
    }
  });
}

function recordManagedServer(deps: MlxDependencies, plan: ServerPlan, server: MlxServer) {
  if (server.pid === undefined) return;
  const markerPath = managedServerMarkerPath(deps.sessionsDir, server.pid);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    JSON.stringify({
      pid: server.pid,
      port: mlxPort(),
      model: plan.model,
      engine: plan.engine,
    }),
  );
}

function removeManagedServerMarker(sessionsDir: string, server: MlxServer) {
  if (server.pid !== undefined)
    rmSync(managedServerMarkerPath(sessionsDir, server.pid), { force: true });
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

export const servedModelId = (repo: string) => repo.replaceAll("/", "--");

export const hubCacheDir = (
  env: Record<string, string | undefined> = process.env,
  userHome = homedir(),
) => env.HF_HUB_CACHE || join(env.HF_HOME || join(userHome, ".cache", "huggingface"), "hub");

export function isRepoInHubCache(cacheDir: string, repo: string): boolean {
  const repoDir = join(cacheDir, `models--${servedModelId(repo)}`);
  const listFolder = (folder: string) =>
    existsSync(join(repoDir, folder)) ? readdirSync(join(repoDir, folder)) : [];
  return (
    listFolder("snapshots").length > 0 &&
    !listFolder("blobs").some((blob) => blob.endsWith(".incomplete"))
  );
}

const DEFAULTS: MlxDependencies = {
  run: spawnRunner,
  startServer: spawnServer,
  unload: unloadModels,
  servedModels: fetchServedModels,
  isOmlxInstalled: () => Bun.which("omlx") !== null,
  isSplashInstalled: () => Bun.which(SPLASH_ENGINE) !== null,
  isRepoCached: (repo) => isRepoInHubCache(hubCacheDir(), repo),
  writeModelSettings: writeModelSettingsFile,
  awaitShutdown: waitForShutdown,
  sessionsDir: join(omlxDataDir(homedir()), "sessions"),
  pollDelayMs: 1000,
  listeningPids: () => {
    const result = Bun.spawnSync(["lsof", "-nP", "-t", `-iTCP:${mlxPort()}`, "-sTCP:LISTEN"]);
    return result.exitCode === 0
      ? new TextDecoder()
          .decode(result.stdout)
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter(Number.isFinite)
      : [];
  },
};

export const mlxLogPath = (userHome: string) =>
  join(userHome, ".cache", "claude-lite", "mlx-server.log");

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

export type MlxEngine = "auto" | "splash" | "dflash" | "mtp";

function engineFor(
  size: Size,
  hasSplash: boolean,
  strict = true,
): Exclude<MlxEngine, "auto"> | undefined {
  const selected = size.mlx_engine ?? "auto";
  if (!["auto", "splash", "dflash", "mtp"].includes(selected))
    if (strict)
      throw new Error(`invalid mlx_engine ${selected}; choose auto, splash, dflash, or mtp`);
    else return autoEngine(size, hasSplash);
  const available =
    selected === "auto" ||
    (selected === "splash" && hasSplash && Boolean(size.mlx_dflash)) ||
    (selected === "dflash" && Boolean(size.mlx_dflash)) ||
    (selected === "mtp" && Boolean(size.mlx_draft));
  if (!available) {
    if (strict) {
      if (selected === "splash" && !hasSplash)
        throw new Error("mlx_engine splash selected but splash is not installed");
      throw new Error(`mlx_engine ${selected} selected but its required draft repo is unavailable`);
    }
    return autoEngine(size, hasSplash);
  }
  return selected === "auto" ? autoEngine(size, hasSplash) : selected;
}

function autoEngine(size: Size, hasSplash: boolean): Exclude<MlxEngine, "auto"> | undefined {
  if (size.mlx_dflash && hasSplash) return "splash";
  if (size.mlx_draft) return "mtp";
  return undefined;
}

const speculativeDecoding = (size: Size, engine?: Exclude<MlxEngine, "auto">): ModelSettings => {
  if (engine === "splash")
    return { external_engine: SPLASH_ENGINE, dflash_draft_model: servedModelId(size.mlx_dflash!) };
  if (engine === "dflash")
    return {
      dflash_enabled: true,
      dflash_draft_model: servedModelId(size.mlx_dflash!),
      dflash_draft_quant_enabled: true,
      dflash_draft_quant_weight_bits: 4,
      dflash_draft_quant_group_size: 64,
      dflash_block_size: 5,
      dflash_verify_mode: "dflash",
    };
  if (engine === "mtp") return { vlm_mtp_enabled: true, vlm_mtp_draft_model: size.mlx_draft! };
  return {};
};

function modelSettings(size: Size, engine?: Exclude<MlxEngine, "auto">): ModelSettings {
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
    ...speculativeDecoding(size, engine),
  };
}

export function modelSettingsDocument(
  sizes: Record<string, Size>,
  launched: Size,
  hasSplash = false,
) {
  const models: Record<string, ModelSettings> = {};
  for (const size of [...Object.values(sizes), launched])
    if (size.mlx)
      models[servedModelId(size.mlx)] = modelSettings(
        size,
        engineFor(size, hasSplash, size === launched),
      );
  return { version: 1, models };
}

function serverCommand(dataDir: string, port = mlxPort()): string[] {
  return [
    "omlx",
    "serve",
    "--base-path",
    dataDir,
    "--host",
    "127.0.0.1",
    "--port",
    port,
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

export const draftRepoOf = (drafted: Size, hasSplash: boolean, strict = true) => {
  const engine = engineFor(drafted, hasSplash, strict);
  return engine === "splash" || engine === "dflash"
    ? drafted.mlx_dflash
    : engine === "mtp"
      ? drafted.mlx_draft
      : undefined;
};

const reposToDownload = (served: (Size | undefined)[], hasSplash: boolean) =>
  served
    .filter((size): size is Size => size !== undefined)
    .flatMap((size) => [size.mlx, draftRepoOf(size, hasSplash, false)])
    .filter((repo): repo is string => repo !== undefined);

function warnWithoutSplash(name: string, size: Size, hasSplash: boolean) {
  if (
    (size.mlx_engine === undefined || size.mlx_engine === "auto") &&
    size.mlx_dflash &&
    size.mlx_draft &&
    !hasSplash
  )
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
  engine?: Exclude<MlxEngine, "auto">;
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
    engine: engineFor(size, hasSplash),
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
    if (plan.size.mlx_engine && plan.size.mlx_engine !== "auto") {
      if (!hasMatchingManagedServer(deps, plan)) {
        console.error(
          `oMLX already serves ${plan.model}, but its engine cannot be verified for explicit mlx_engine=${plan.size.mlx_engine}; stop it before launching`,
        );
        return { kind: "failed" };
      }
    }
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
  for (const repo of reposToDownload([plan.size, plan.visionSize], plan.hasSplash).filter(
    (repo) => !deps.isRepoCached(repo),
  ))
    if ((await downloadRepo(repo, deps.run)) !== 0) return { kind: "failed" };
  await unloadOllama(deps.unload);
  deps.writeModelSettings(plan.settingsPath, plan.document);
  console.log(`starting oMLX for ${plan.model}; log: ${logPath()}`);
  const server = deps.startServer(plan.command, logPath());
  const listing = await waitUntilReady(server, deps.servedModels, deps.pollDelayMs);
  if (listing?.includes(plan.model)) {
    recordManagedServer(deps, plan, server);
    return { kind: "started", server };
  }
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
  if (otherSessions === 0) {
    server.stop();
    removeManagedServerMarker(sessionsDir, server);
  } else
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
  let plan: ServerPlan | undefined;
  try {
    plan = planServer(home, args, deps.isSplashInstalled());
  } catch (error) {
    console.error(String(error));
    return 1;
  }
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
  let plan: ServerPlan | undefined;
  try {
    plan = planServer(home, args, deps.isSplashInstalled());
  } catch (error) {
    console.error(String(error));
    return 1;
  }
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
  removeManagedServerMarker(deps.sessionsDir, start.server);
  console.log("stopped oMLX");
  return code;
}

export type MlxBenchDependencies = {
  isOmlxInstalled: () => boolean;
  isSplashInstalled: () => boolean;
  ollamaModels: (url: string) => Promise<string[]>;
  loadedOmlxModels: (url: string) => Promise<number | undefined>;
  isRepoCached: (repo: string) => boolean;
  download: (repo: string, signal?: AbortSignal) => Promise<number>;
  allocatePort: () => Promise<number>;
  start: (argv: string[], log: string, env: Record<string, string | undefined>) => MlxServer;
  wait: (url: string, model: string, server: MlxServer, log: string) => Promise<void>;
  sessionsDir: string;
};

const defaultBenchDependencies = (): MlxBenchDependencies => ({
  isOmlxInstalled: () => Bun.which("omlx") !== null,
  isSplashInstalled: () => Bun.which(SPLASH_ENGINE) !== null,
  ollamaModels: async (url) => {
    try {
      const response = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(700) });
      if (!response.ok) return [];
      const body = (await response.json()) as { models?: { name: string }[] };
      return (body.models ?? []).map(({ name }) => name);
    } catch {
      return [];
    }
  },
  loadedOmlxModels: async (url) => {
    try {
      const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(700) });
      if (!response.ok) return undefined;
      const body = (await response.json()) as {
        models_loaded?: number;
        loaded_models?: number | unknown[];
      };
      if (typeof body.models_loaded === "number") return body.models_loaded;
      if (typeof body.loaded_models === "number") return body.loaded_models;
      if (Array.isArray(body.loaded_models)) return body.loaded_models.length;
      return undefined;
    } catch {
      return undefined;
    }
  },
  isRepoCached: (repo) => isRepoInHubCache(hubCacheDir(process.env, homedir()), repo),
  download: async (repo, signal) =>
    await Bun.spawn(downloadArgv(repo), {
      stdin: "ignore",
      stdout: 2,
      stderr: 2,
      signal,
    }).exited,
  allocatePort: async () => {
    const listener = createNetServer();
    const port = await new Promise<number>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolve((listener.address() as AddressInfo).port));
    });
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    return port;
  },
  start: spawnServer,
  wait: async (url, model, server, log) => {
    let hasExited = false;
    void server.exited.then(() => {
      hasExited = true;
    });
    for (let i = 0; i < 240; i++) {
      if (hasExited) {
        const tail = await Bun.file(log)
          .slice(-2048)
          .text()
          .catch(() => "");
        throw new Error(`benchmark oMLX exited before serving ${model}\n${tail.trim()}`.trim());
      }
      try {
        const response = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(700) });
        if (response.ok) {
          const body = (await response.json()) as { data?: { id: string }[] };
          if (body.data?.some(({ id }) => id === model)) return;
        }
      } catch {}
      await Bun.sleep(250);
    }
    throw new Error(`benchmark oMLX did not serve ${model}`);
  },
  sessionsDir: DEFAULTS.sessionsDir,
});

/** Runs one benchmark against an isolated oMLX server, leaving stdout to the callback. */
export async function withMlxBenchServer(
  sizeName: string,
  size: Size,
  run: (url: string, model: string, engine: string, logPath: string) => Promise<number>,
  overrides: Partial<MlxBenchDependencies> = {},
): Promise<number> {
  const deps = { ...defaultBenchDependencies(), ...overrides };
  const loadedOmlx = await deps.loadedOmlxModels(mlxUrl());
  if (loadedOmlx !== undefined && loadedOmlx > 0)
    throw new Error(
      `benchmark refused: ${loadedOmlx} model(s) are loaded in the standard oMLX server`,
    );
  const ollamaModels = isRemoteHost() ? [] : await deps.ollamaModels(ollamaUrl());
  if (ollamaModels.length)
    throw new Error(
      `benchmark refused: local Ollama models are active (${ollamaModels.join(", ")})`,
    );
  if (countOtherLiveSessions(deps.sessionsDir) > 0)
    throw new Error("benchmark refused: a standard claude-lite oMLX session is active");
  if (!deps.isOmlxInstalled())
    throw new Error("oMLX is not installed; install it before benchmarking");
  const repo = size.mlx;
  if (!repo) throw new Error(`size ${sizeName} has no mlx model`);
  const hasSplash = deps.isSplashInstalled();
  const engine = engineFor(size, hasSplash) ?? "none";
  const model = servedModelId(repo);
  const draft = draftRepoOf(size, hasSplash);
  const root = mkdtempSync(join(tmpdir(), "claude-lite-mlx-bench-"));
  const log = join(root, "server.log");
  let server: MlxServer | undefined;
  let signalHandler: (() => void) | undefined;
  let signalReject: ((reason: Error) => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    signalReject = reject;
  });
  const downloadController = new AbortController();
  let activeDownload: Promise<number> | undefined;
  signalHandler = () => {
    downloadController.abort();
    server?.stop();
    signalReject?.(new Error("benchmark interrupted"));
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  const guarded = <T>(promise: Promise<T>) => Promise.race([promise, interrupted]);
  try {
    const fetchRepo = async (id: string) => {
      if (deps.isRepoCached(id)) return;
      const download = deps.download(id, downloadController.signal);
      activeDownload = download;
      try {
        if ((await guarded(download)) !== 0) throw new Error(`failed to download ${id}`);
      } finally {
        if (!downloadController.signal.aborted) activeDownload = undefined;
      }
    };
    await fetchRepo(repo);
    if (draft) await fetchRepo(draft);
    const port = await guarded(deps.allocatePort());
    const url = `http://127.0.0.1:${port}`;
    const document = modelSettingsDocument({ [sizeName]: size }, size, hasSplash);
    writeModelSettingsFile(join(root, "model_settings.json"), document);
    const argv = [
      ...serverCommand(root, String(port)),
      "--paged-ssd-cache-dir",
      join(root, "cache"),
    ];
    const cacheDir = hubCacheDir(process.env, homedir());
    const env = {
      ...process.env,
      HF_HOME: process.env.HF_HOME || join(homedir(), ".cache", "huggingface"),
      HF_HUB_CACHE: cacheDir,
    };
    server = deps.start(argv, log, env);
    await guarded(deps.wait(url, model, server, log));
    return await guarded(run(url, model, engine, log));
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
    if (server) {
      server.stop();
      await server.exited.catch(() => -1);
    }
    if (activeDownload) await activeDownload.catch(() => -1);
    rmSync(root, { recursive: true, force: true });
  }
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
