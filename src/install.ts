import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { completionPath, completionScript, END, type Shell, START } from "./completion.ts";
import { summarizeHookLog } from "./hook-stats.ts";
import { HOOK_NAMES, hookLogPath } from "./hooks/run-hook.ts";
import {
  isSupportedVersion,
  MINIMUM_OLLAMA,
  type Runner,
  serverResponds,
  serverStatus,
  spawnRunner,
} from "./ollama/launch.ts";
import {
  loadConfigState,
  renderConfig,
  runConfigScreen,
  saveConfigState,
} from "./config-screen.ts";
import { withJsonOverlay } from "./json-overlay.ts";
import { withSharedSecrets } from "./sandbox-secrets.ts";

const BLOCK = new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`);

const claudeMdBlock = (home: string) =>
  `${START}\n@${join(home, "config", "PREFERENCES.md")}\n${END}\n`;
const claudeFunction = (home: string) =>
  `claude() { if [ "\${CLAUDE_LITE_WRAP:-1}" = 0 ]; then command claude "$@"; else env CLAUDE_LITE_HOME="${home}" command claude --settings "$("${home}/dist/claude-lite" settings)" "$@"; fi; }`;
const zshBlock = (userHome: string, home: string) =>
  `${START}\n${claudeFunction(home)}\nfpath+=(${dirname(completionPath(userHome, "zsh"))})\n_cl_register() {\n  add-zsh-hook -d precmd _cl_register\n  unfunction _cl_register\n  (( $+functions[compdef] )) || { autoload -Uz compinit; compinit; }\n  autoload -Uz _cl\n  compdef _cl cl\n}\nautoload -Uz add-zsh-hook\nadd-zsh-hook precmd _cl_register\n${END}\n`;
const bashBlock = (userHome: string, home: string) =>
  `${START}\n${claudeFunction(home)}\n[ -f ${completionPath(userHome, "bash")} ] && . ${completionPath(userHome, "bash")}\n${END}\n`;
const fishBlock = (home: string) =>
  `${START}\nfunction claude\n  if test "$CLAUDE_LITE_WRAP" = 0\n    command claude $argv\n  else\n    env CLAUDE_LITE_HOME="${home}" command claude --settings ("${home}/dist/claude-lite" settings) $argv\n  end\nend\n${END}\n`;

const WRAP_OFF_START = "# >>> claude-lite wrap off >>>";
const WRAP_OFF_END = "# <<< claude-lite wrap off <<<";
const WRAP_OFF_BLOCK = new RegExp(`\\n?${WRAP_OFF_START}[\\s\\S]*?${WRAP_OFF_END}\\n?`);
const WRAP_OFF_LINES: Record<Shell, string> = {
  zsh: "export CLAUDE_LITE_WRAP=0",
  bash: "export CLAUDE_LITE_WRAP=0",
  fish: "set -gx CLAUDE_LITE_WRAP 0",
};
const wrapOffBlock = (shell: Shell) =>
  `${WRAP_OFF_START}\n${WRAP_OFF_LINES[shell]}\n${WRAP_OFF_END}\n`;

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

function writeCompletions(userHome: string) {
  for (const shell of presentShells(userHome)) {
    const path = completionPath(userHome, shell);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, completionScript(shell));
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

const presentShellRcs = (userHome: string): [Shell, string][] =>
  SHELL_RCS.map(([shell, rc]): [Shell, string] => [shell, join(userHome, ...rc)]).filter(
    ([, path]) => existsSync(path),
  );

function appendBlock(text: string, blockPattern: RegExp, block: string) {
  const stripped = text.replace(blockPattern, "");
  return `${stripped}${stripped && !stripped.endsWith("\n") ? "\n" : ""}\n${block}`.replace(
    /^\n+/,
    "",
  );
}

export async function install(userHome: string, home: string): Promise<number> {
  for (const [path, block] of targets(userHome, home)) {
    rewrite(path, (text) => appendBlock(text, BLOCK, block));
  }
  writeCompletions(userHome);
  linkCl(userHome, home);
  return 0;
}

export async function uninstall(userHome: string, home: string): Promise<number> {
  for (const [path] of targets(userHome, home)) {
    if (existsSync(path)) rewrite(path, (text) => text.replace(BLOCK, ""));
  }
  removeWrapOff(userHome);
  removeCompletions(userHome);
  unlinkCl(userHome, home);
  rmSync(serverEnvAgentPath(userHome), { force: true });
  return 0;
}

function removeWrapOff(userHome: string) {
  for (const [, path] of presentShellRcs(userHome)) {
    rewrite(path, (text) => text.replace(WRAP_OFF_BLOCK, ""));
  }
}

export async function disable(userHome: string, _home: string): Promise<number> {
  for (const [shell, path] of presentShellRcs(userHome)) {
    rewrite(path, (text) => appendBlock(text, WRAP_OFF_BLOCK, wrapOffBlock(shell)));
  }
  console.log("claude-lite: open a new shell; claude now runs without claude-lite");
  return 0;
}

export async function enable(userHome: string, _home: string): Promise<number> {
  removeWrapOff(userHome);
  console.log("claude-lite: open a new shell; claude now runs with claude-lite");
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
    ["bun", "install", "--cwd", home, "--frozen-lockfile"],
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
    const texts = ["claude.json", "hooks.json"].map((name) =>
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

const CRASH_WINDOW_MS = 24 * 60 * 60 * 1000;

function crashTime(logLine: string): number {
  try {
    const entry = JSON.parse(logLine);
    return entry.crashed ? Date.parse(entry.time) : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

export function recentHookCrashes(userHome: string, now = Date.now()): number {
  const logPath = hookLogPath(userHome);
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((logLine) => now - crashTime(logLine) < CRASH_WINDOW_MS).length;
}

export async function doctor(
  userHome: string,
  home: string,
  run: Runner = spawnRunner,
  systemRoot = "/",
): Promise<number> {
  const binaryBuilt = existsSync(binaryPath(home));
  const [settingsValid, hooksKnown] = configsParseWithKnownHooks(home);
  const server = await serverStatus(run);
  const checks: [string, boolean][] = [
    ["binary built", binaryBuilt],
    ["binary runs", binaryBuilt && (await run([binaryPath(home), "--help"])) === 0],
    ["blocks installed", blocksInstalled(userHome, home)],
    ["cl link", readLink(clLinkPath(userHome)) === binaryPath(home)],
    ["settings valid", settingsValid],
    ["hooks known", hooksKnown],
    ["no hook crashes in the last day", recentHookCrashes(userHome) === 0],
    ["ollama server responds", server.isResponding],
    [`ollama ${MINIMUM_OLLAMA} or newer`, isSupportedVersion(server.version)],
    ["one ollama startup source", ollamaStartupSources(userHome, systemRoot).length <= 1],
    ["ollama server env set", (await run(["sh", "-c", serverEnvCheck()])) === 0],
    [
      "agent-browser runs",
      (await run(["sh", "-c", "agent-browser --version >/dev/null 2>&1"])) === 0,
    ],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  for (const line of securityPosture(home)) console.log(line);
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

const SERVER_ENV_AGENT = "com.claude-lite.server-env";

const serverEnvAgentPath = (userHome: string) =>
  join(userHome, "Library/LaunchAgents", `${SERVER_ENV_AGENT}.plist`);

function serverEnvAgent(): string {
  const setAll = OLLAMA_SERVER_ENV.map(([name, value]) => `launchctl setenv ${name} ${value}`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${SERVER_ENV_AGENT}</string>`,
    "<key>ProgramArguments</key><array>",
    `<string>/bin/sh</string><string>-c</string><string>${setAll.join("; ")}</string>`,
    "</array>",
    "<key>RunAtLoad</key><true/>",
    "</dict></plist>",
    "",
  ].join("\n");
}

function writeServerEnvAgent(userHome: string) {
  mkdirSync(dirname(serverEnvAgentPath(userHome)), { recursive: true });
  writeFileSync(serverEnvAgentPath(userHome), serverEnvAgent());
}

const serverEnvCheck = () =>
  OLLAMA_SERVER_ENV.map(([name, value]) => `test "$(launchctl getenv ${name})" = "${value}"`).join(
    " && ",
  );

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
  writeServerEnvAgent(userHome);
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

function sharedHooks(home: string): { hooks?: unknown } {
  const hooksPath = join(home, "config", "hooks.json");
  return existsSync(hooksPath) ? { hooks: JSON.parse(readFileSync(hooksPath, "utf8")) } : {};
}

function effectiveSettings(home: string): Record<string, any> {
  const claudeSettings = JSON.parse(readFileSync(join(home, "config", "claude.json"), "utf8"));
  const base = { ...claudeSettings, ...sharedHooks(home) };
  const overlaid = withJsonOverlay(base, join(home, "config", "local-claude.json"));
  return withSharedSecrets(overlaid, home);
}

function securityPosture(home: string): string[] {
  try {
    const effective = effectiveSettings(home);
    return [
      `info sandbox ${effective.sandbox?.enabled === true ? "on" : "off"}`,
      `info permission mode ${effective.permissions?.defaultMode ?? "default"}`,
    ];
  } catch {
    return [];
  }
}

export async function stats(userHome: string, _home: string): Promise<number> {
  const logPath = hookLogPath(userHome);
  console.log(summarizeHookLog(existsSync(logPath) ? readFileSync(logPath, "utf8") : ""));
  return 0;
}

export async function settings(_userHome: string, home: string): Promise<number> {
  console.log(JSON.stringify(effectiveSettings(home)));
  return 0;
}

export async function config(_userHome: string, home: string): Promise<number> {
  const state = loadConfigState(home);
  if (!process.stdin.isTTY) {
    console.log(renderConfig(state));
    return 0;
  }
  const savedState = await runConfigScreen(state, home);
  if (savedState) saveConfigState(home, savedState);
  return 0;
}
