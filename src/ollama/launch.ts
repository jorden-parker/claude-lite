import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fetchApi, type LauncherApi, ollamaUrl } from "./api.ts";
import { hasParameters, renderModelfile } from "./modelfile.ts";
import { renderSettings } from "./settings.ts";
import { fittingSizes, loadSizes, resolveSize, type Size } from "./sizes.ts";
import { withJsonOverlay } from "../json-overlay.ts";
import { withSharedSecrets } from "../sandbox-secrets.ts";

export type Runner = (argv: string[], env?: Record<string, string | undefined>) => Promise<number>;

export const spawnRunner: Runner = async (argv, env) =>
  await Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env: env ?? process.env })
    .exited;

const TOOLS = "Bash,Read,Edit,Write,Skill";

export const MINIMUM_OLLAMA = "0.40.12";

type ServerStatus = { isResponding: boolean; version: string | null };

function readVersion(replyPath: string): string | null {
  try {
    return JSON.parse(readFileSync(replyPath, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

export async function serverStatus(run: Runner): Promise<ServerStatus> {
  const dir = mkdtempSync(join(tmpdir(), "claude-lite-version-"));
  const replyPath = join(dir, "version.json");
  const versionUrl = `${ollamaUrl()}/api/version`;
  try {
    const code = await run(["curl", "-sf", "-o", replyPath, "--max-time", "2", versionUrl]);
    return { isResponding: code === 0, version: code === 0 ? readVersion(replyPath) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const serverResponds = async (run: Runner) => (await serverStatus(run)).isResponding;

const numericParts = (version: string) =>
  version.split(".").map((part) => Number.parseInt(part, 10) || 0);

export function isSupportedVersion(version: string | null): boolean {
  if (version === null) return true;
  const actual = numericParts(version);
  const minimum = numericParts(MINIMUM_OLLAMA);
  const differing = minimum.findIndex((part, i) => (actual[i] ?? 0) !== part);
  return differing < 0 || (actual[differing] ?? 0) > minimum[differing];
}

function withServerUrl<Settings extends Record<string, any>>(settings: Settings, url: string) {
  const network = settings.sandbox?.network;
  const allowedDomains = [...new Set([...(network?.allowedDomains ?? []), new URL(url).hostname])];
  return {
    ...settings,
    env: { ...settings.env, ANTHROPIC_BASE_URL: url },
    ...(network && { sandbox: { ...settings.sandbox, network: { ...network, allowedDomains } } }),
  };
}

export function ollamaBaseSettings(home: string): Record<string, any> {
  const base = JSON.parse(readFileSync(join(home, "config", "ollama.json"), "utf8"));
  const overlaid = withJsonOverlay(base, join(home, "config", "local-ollama.json"));
  return withSharedSecrets(overlaid, home);
}

export function renderLaunchSettings(home: string, size: Size, serverUrl?: string) {
  const rendered = {
    ...renderSettings(ollamaBaseSettings(home), size),
    enabledPlugins: disabledBuiltinPlugins(),
  };
  return serverUrl ? withServerUrl(rendered, serverUrl) : rendered;
}

function buildPlan(home: string, args: string[]) {
  const { name, size, claudeArgs } = resolveSize(home, args);
  const settings = renderLaunchSettings(
    home,
    size,
    process.env.OLLAMA_HOST ? ollamaUrl() : undefined,
  );
  return { name, size, settings, modelfile: renderModelfile(size), claudeArgs };
}

function disabledBuiltinPlugins(): Record<string, false> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  try {
    const { enabledPlugins } = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    return Object.fromEntries(
      Object.keys(enabledPlugins ?? {})
        .filter((name) => name.endsWith("@builtin"))
        .map((name) => [name, false]),
    );
  } catch {
    return {};
  }
}

export function loadFailureHint(
  home: string,
  sizeName: string,
  memoryBytes = totalmem(),
  wiredLimitMb?: number,
): string {
  const smaller = fittingSizes(loadSizes(home), memoryBytes, wiredLimitMb).filter(
    (name) => name !== sizeName,
  );
  return smaller.length
    ? `sizes that fit this machine: ${smaller.map((name) => `cl ollama ${name}`).join(", ")}`
    : "no configured size fits this machine; add a smaller one to config/local-sizes.json";
}

async function isCurrentModel(size: Size, api: LauncherApi): Promise<boolean> {
  const reported = await api.parameters(size.model);
  return reported === null || hasParameters(reported, size);
}

async function ensureModel(
  size: Size,
  modelfile: string,
  dir: string,
  run: Runner,
  api: LauncherApi,
) {
  const isCreated = (await run(["ollama", "show", size.model])) === 0;
  if (isCreated && (await isCurrentModel(size, api))) return true;
  if (!isCreated && (await run(["ollama", "pull", size.base])) !== 0) return false;
  const modelfilePath = join(dir, "Modelfile");
  writeFileSync(modelfilePath, modelfile);
  return (await run(["ollama", "create", size.model, "-f", modelfilePath])) === 0;
}

export async function launch(
  home: string,
  args: string[],
  run: Runner = spawnRunner,
  api: LauncherApi = fetchApi,
): Promise<number> {
  if (args.includes("--print-config")) {
    const { settings, modelfile } = buildPlan(
      home,
      args.filter((arg) => arg !== "--print-config"),
    );
    console.log(modelfile);
    console.log(JSON.stringify(settings, null, 2));
    return 0;
  }
  const plan = buildPlan(home, args);
  const server = await serverStatus(run);
  if (!server.isResponding) {
    console.error(`Ollama is not responding on ${ollamaUrl()}; run cl servers`);
    return 1;
  }
  if (!isSupportedVersion(server.version)) {
    console.error(`Ollama ${server.version} is older than ${MINIMUM_OLLAMA}; update Ollama`);
    return 1;
  }
  const dir = mkdtempSync(join(tmpdir(), "claude-lite-"));
  try {
    return await launchFrom(dir, home, plan, run, api);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type LaunchPlan = ReturnType<typeof buildPlan>;

async function launchFrom(
  dir: string,
  home: string,
  { name, size, settings, modelfile, claudeArgs }: LaunchPlan,
  run: Runner,
  api: LauncherApi,
): Promise<number> {
  if (!(await ensureModel(size, modelfile, dir, run, api))) return 1;
  const loadError = await api.load(size.model);
  if (loadError !== null) {
    console.error(`${size.model} failed to load: ${loadError}`);
    console.error(loadFailureHint(home, name));
    return 1;
  }
  return await runClaude(
    { dir, home, model: size.model, settings, claudeArgs, url: ollamaUrl() },
    run,
  );
}

type ClaudeLaunch = {
  dir: string;
  home: string;
  model: string;
  settings: Record<string, any>;
  claudeArgs: string[];
  url: string;
};

export async function runClaude(
  { dir, home, model, settings, claudeArgs, url }: ClaudeLaunch,
  run: Runner,
): Promise<number> {
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_BASE_URL: url };
  delete env.ANTHROPIC_API_KEY;
  return await run(
    [
      "claude",
      "--settings",
      settingsPath,
      "--system-prompt-file",
      join(home, "config", "system-prompt.md"),
      "--model",
      model,
      "--tools",
      TOOLS,
      "--strict-mcp-config",
      ...claudeArgs,
    ],
    env,
  );
}
