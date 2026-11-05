import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { completionPath, completionScript, END, type Shell, START } from "./completion.ts";
import { COMMAND_HELP } from "./help.ts";
import { HOOK_NAMES, hookLogPath } from "./hooks/run-hook.ts";
import { type Runner, serverResponds, spawnRunner } from "./ollama/launch.ts";
import { withOptOutsFor } from "./permissions-opt-out.ts";
import { loadSizes } from "./ollama/sizes.ts";

const BLOCK = new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`);

const claudeMdBlock = (home: string) =>
  `${START}\n@${join(home, "config", "PREFERENCES.md")}\n${END}\n`;
const claudeFunction = (home: string) =>
  `claude() { env CLAUDE_LITE_HOME="${home}" command claude --settings "$("${home}/dist/claude-lite" settings)" "$@"; }`;
const zshBlock = (userHome: string, home: string) =>
  `${START}\n${claudeFunction(home)}\nfpath+=(${dirname(completionPath(userHome, "zsh"))})\n_cl_register() {\n  add-zsh-hook -d precmd _cl_register\n  unfunction _cl_register\n  (( $+functions[compdef] )) || { autoload -Uz compinit; compinit; }\n  autoload -Uz _cl\n  compdef _cl cl\n}\nautoload -Uz add-zsh-hook\nadd-zsh-hook precmd _cl_register\n${END}\n`;
const bashBlock = (userHome: string, home: string) =>
  `${START}\n${claudeFunction(home)}\n[ -f ${completionPath(userHome, "bash")} ] && . ${completionPath(userHome, "bash")}\n${END}\n`;
const fishBlock = (home: string) =>
  `${START}\nfunction claude\n  env CLAUDE_LITE_HOME="${home}" command claude --settings ("${home}/dist/claude-lite" settings) $argv\nend\n${END}\n`;

const SHELL_RCS: [Shell, string[]][] = [
  ["zsh", [".zshrc"]],
  ["bash", [".bashrc"]],
  ["fish", [".config", "fish", "config.fish"]],
];

function targets(userHome: string, home: string): [string, string][] {
  const claudeMd = join(userHome, ".claude", "CLAUDE.md");
  const blocks: Record<Shell, string> = {
    zsh: zshBlock(userHome, home),
    bash: bashBlock(userHome, home),
    fish: fishBlock(home),
  };
  const rcs = SHELL_RCS.map(([shell, rc]): [string, string] => [
    join(userHome, ...rc),
    blocks[shell],
  ]);
  return [[claudeMd, claudeMdBlock(home)], ...rcs.filter(([path]) => existsSync(path))];
}

const presentShells = (userHome: string) =>
  SHELL_RCS.filter(([, rc]) => existsSync(join(userHome, ...rc))).map(([shell]) => shell);

function completionWords(home: string) {
  let sizes: string[] = [];
  try {
    sizes = Object.keys(loadSizes(home));
  } catch {}
  return { commands: Object.keys(COMMAND_HELP), hooks: HOOK_NAMES, sizes };
}

function writeCompletions(userHome: string, home: string) {
  const words = completionWords(home);
  for (const shell of presentShells(userHome)) {
    const path = completionPath(userHome, shell);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, completionScript(shell, words));
  }
}

function removeCompletions(userHome: string) {
  for (const shell of presentShells(userHome)) {
    const path = completionPath(userHome, shell);
    if (existsSync(path) && BLOCK.test(readFileSync(path, "utf8"))) unlinkSync(path);
  }
}

function rewrite(path: string, update: (text: string) => string) {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = update(before);
  if (after === before) return;
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after);
}

const clLinkPath = (userHome: string) => join(userHome, ".local", "bin", "cl");
const binaryPath = (home: string) => join(home, "dist", "claude-lite");

function readLink(path: string): string | null | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return undefined;
  }
}

function linkCl(userHome: string, home: string) {
  const link = clLinkPath(userHome);
  const target = readLink(link);
  if (target === null || (target !== undefined && !target.endsWith("/dist/claude-lite"))) {
    console.error(`claude-lite: ${link} is not a claude-lite link, left alone`);
    return;
  }
  mkdirSync(dirname(link), { recursive: true });
  if (target !== undefined) unlinkSync(link);
  symlinkSync(binaryPath(home), link);
  if (!(process.env.PATH ?? "").split(":").includes(dirname(link))) {
    console.error(`claude-lite: add ${dirname(link)} to PATH to use cl`);
  }
}

function unlinkCl(userHome: string, home: string) {
  const link = clLinkPath(userHome);
  if (readLink(link) === binaryPath(home)) unlinkSync(link);
}

export async function install(userHome: string, home: string): Promise<number> {
  for (const [path, block] of targets(userHome, home)) {
    rewrite(path, (text) => {
      const stripped = text.replace(BLOCK, "");
      return `${stripped}${stripped && !stripped.endsWith("\n") ? "\n" : ""}\n${block}`.replace(
        /^\n+/,
        "",
      );
    });
  }
  writeCompletions(userHome, home);
  linkCl(userHome, home);
  return 0;
}

export async function uninstall(userHome: string, home: string): Promise<number> {
  for (const [path] of targets(userHome, home)) {
    if (existsSync(path)) rewrite(path, (text) => text.replace(BLOCK, ""));
  }
  removeCompletions(userHome);
  unlinkCl(userHome, home);
  return 0;
}

const buildCommand = (home: string) => ["bun", "run", "--cwd", home, "build"];

export async function build(
  _userHome: string,
  home: string,
  run: Runner = spawnRunner,
): Promise<number> {
  return await run(buildCommand(home));
}

export async function update(
  _userHome: string,
  home: string,
  run: Runner = spawnRunner,
): Promise<number> {
  const steps = [
    ["git", "-C", home, "pull", "--ff-only"],
    ["bun", "install", "--cwd", home],
    buildCommand(home),
    [binaryPath(home), "install"],
  ];
  for (const step of steps) {
    const code = await run(step);
    if (code !== 0) return code;
  }
  return 0;
}

export async function logs(
  userHome: string,
  _home: string,
  run: Runner = spawnRunner,
  systemRoot = "/",
): Promise<number> {
  return await run([
    "tail",
    "-F",
    "-n",
    "20",
    hookLogPath(userHome),
    ...ollamaLogPaths(userHome, systemRoot),
  ]);
}

function configsParseWithKnownHooks(home: string): [boolean, boolean] {
  try {
    const texts = ["personal-settings.json", "hooks.json"].map((name) =>
      readFileSync(join(home, "config", name), "utf8"),
    );
    texts.forEach((text) => JSON.parse(text));
    const names = texts.flatMap((text) => [...text.matchAll(/ hook ([\w-]+)/g)].map((m) => m[1]));
    return [true, names.every((name) => HOOK_NAMES.includes(name))];
  } catch {
    return [false, false];
  }
}

function blocksInstalled(userHome: string, home: string): boolean {
  return targets(userHome, home).every(
    ([path, block]) => existsSync(path) && readFileSync(path, "utf8").includes(block),
  );
}

export async function doctor(
  userHome: string,
  home: string,
  run: Runner = spawnRunner,
  systemRoot = "/",
): Promise<number> {
  const binaryBuilt = existsSync(binaryPath(home));
  const [settingsValid, hooksKnown] = configsParseWithKnownHooks(home);
  const checks: [string, boolean][] = [
    ["binary built", binaryBuilt],
    ["binary runs", binaryBuilt && (await run([binaryPath(home), "--help"])) === 0],
    ["blocks installed", blocksInstalled(userHome, home)],
    ["cl link", readLink(clLinkPath(userHome)) === binaryPath(home)],
    ["settings valid", settingsValid],
    ["hooks known", hooksKnown],
    ["ollama server responds", await serverResponds(run)],
    ["one ollama startup source", ollamaStartupSources(userHome, systemRoot).length <= 1],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

const OLLAMA_PLIST_DIRS = ["Library/LaunchAgents", "Library/LaunchDaemons"];

function ollamaPlists(root: string): string[] {
  return OLLAMA_PLIST_DIRS.flatMap((dir) => {
    const path = join(root, dir);
    if (!existsSync(path)) return [];
    return readdirSync(path)
      .filter((name) => /ollama/i.test(name))
      .map((name) => join(path, name));
  });
}

const ollamaApps = (userHome: string, systemRoot: string) =>
  [systemRoot, userHome].map((root) => join(root, "Applications/Ollama.app")).filter(existsSync);

const allOllamaPlists = (userHome: string, systemRoot: string) => [
  ...ollamaPlists(userHome),
  ...ollamaPlists(systemRoot),
];

export function ollamaStartupSources(userHome: string, systemRoot = "/"): string[] {
  return [...allOllamaPlists(userHome, systemRoot), ...ollamaApps(userHome, systemRoot)];
}

const PLIST_LOG_PATH = /<key>Standard(?:Out|Error)Path<\/key>\s*<string>([^<]+)<\/string>/g;

export function ollamaLogPaths(userHome: string, systemRoot = "/"): string[] {
  const plistLogs = allOllamaPlists(userHome, systemRoot).flatMap((plist) =>
    [...readFileSync(plist, "utf8").matchAll(PLIST_LOG_PATH)].map((match) => match[1]),
  );
  const appLog = ollamaApps(userHome, systemRoot).length
    ? [join(userHome, ".ollama/logs/server.log")]
    : [];
  return [...new Set([...plistLogs, ...appLog])].filter(existsSync);
}

const OLLAMA_SERVER_ENV: [string, string][] = [
  ["OLLAMA_KEEP_ALIVE", "-1"],
  ["OLLAMA_NUM_PARALLEL", "1"],
  ["OLLAMA_FLASH_ATTENTION", "1"],
  ["OLLAMA_KV_CACHE_TYPE", "q8_0"],
  ["OLLAMA_MAX_LOADED_MODELS", "1"],
];

export async function servers(
  userHome: string,
  _home: string,
  run: Runner = spawnRunner,
  systemRoot = "/",
): Promise<number> {
  const sources = ollamaStartupSources(userHome, systemRoot);
  for (const source of sources) console.log(`source ${source}`);
  console.log("listening on 11434:");
  await run(["lsof", "-nP", "-iTCP:11434", "-sTCP:LISTEN"]);
  const responds = await serverResponds(run);
  console.log(`${responds ? "ok  " : "FAIL"} server responds`);
  for (const [name, value] of OLLAMA_SERVER_ENV) await run(["launchctl", "setenv", name, value]);
  console.log("restart Ollama.app to apply server env");
  const oneSource = sources.length <= 1;
  if (!oneSource)
    console.log(
      "FAIL more than one Ollama startup source; they fight over port 11434. Run cl fix-servers.",
    );
  return responds && oneSource ? 0 : 1;
}

function trashPath(userHome: string, file: string): string {
  const trashed = join(userHome, ".Trash", basename(file));
  return existsSync(trashed) ? `${trashed}.${Date.now()}` : trashed;
}

async function retireUserAgent(userHome: string, plist: string, run: Runner): Promise<void> {
  await run(["launchctl", "bootout", `gui/${process.getuid?.()}`, plist]);
  mkdirSync(join(userHome, ".Trash"), { recursive: true });
  renameSync(plist, trashPath(userHome, plist));
  console.log(`removed ${plist} (in ~/.Trash)`);
}

export async function fixServers(
  userHome: string,
  _home: string,
  run: Runner = spawnRunner,
  systemRoot = "/",
): Promise<number> {
  if (ollamaStartupSources(userHome, systemRoot).length <= 1) {
    console.log("ok   one Ollama startup source");
    return 0;
  }
  if (!ollamaApps(userHome, systemRoot).length) {
    console.log("FAIL no Ollama.app to keep; remove all but one source by hand");
    return 1;
  }
  const userAgentDir = join(userHome, "Library/LaunchAgents");
  const plists = allOllamaPlists(userHome, systemRoot);
  const userAgents = plists.filter((plist) => dirname(plist) === userAgentDir);
  const needSudo = plists.filter((plist) => !userAgents.includes(plist));
  for (const plist of userAgents) await retireUserAgent(userHome, plist, run);
  for (const plist of needSudo) console.log(`FAIL needs sudo: ${plist}`);
  await run(["open", "-a", "Ollama"]);
  return needSudo.length ? 1 : 0;
}

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function mergeSettings(base: JsonObject, overlay: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = merged[key];
    merged[key] =
      isJsonObject(baseValue) && isJsonObject(overlayValue)
        ? mergeSettings(baseValue, overlayValue)
        : overlayValue;
  }
  return merged;
}

export async function settings(_userHome: string, home: string): Promise<number> {
  const base = JSON.parse(readFileSync(join(home, "config", "personal-settings.json"), "utf8"));
  const overlayPath = join(home, "config", "local-settings.json");
  let effective = base;
  if (existsSync(overlayPath)) {
    try {
      effective = mergeSettings(base, JSON.parse(readFileSync(overlayPath, "utf8")));
    } catch (error) {
      console.error(`claude-lite: ignoring invalid ${overlayPath}: ${(error as Error).message}`);
    }
  }
  console.log(JSON.stringify(withOptOutsFor("anthropic", effective)));
  return 0;
}
