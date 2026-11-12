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
import {
  loadConfigState,
  renderConfig,
  runConfigScreen,
  saveConfigState,
} from "./config-screen.ts";
import {
  isSupportedVersion,
  MINIMUM_OLLAMA,
  ollamaBaseSettings,
  type Runner,
  serverResponds,
  serverStatus,
  spawnRunner,
} from "./ollama/launch.ts";
import { loadSizes } from "./ollama/sizes.ts";

const BLOCK = new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`);

const zshBlock = (userHome: string) =>
  `${START}\nfpath+=(${dirname(completionPath(userHome, "zsh"))})\n_cl_register() {\n  add-zsh-hook -d precmd _cl_register\n  unfunction _cl_register\n  (( $+functions[compdef] )) || { autoload -Uz compinit; compinit; }\n  autoload -Uz _cl\n  compdef _cl cl\n}\nautoload -Uz add-zsh-hook\nadd-zsh-hook precmd _cl_register\n${END}\n`;
const bashBlock = (userHome: string) =>
  `${START}\n[ -f ${completionPath(userHome, "bash")} ] && . ${completionPath(userHome, "bash")}\n${END}\n`;

const SHELL_RCS: [Shell, string[]][] = [
  ["zsh", [".zshrc"]],
  ["bash", [".bashrc"]],
  ["fish", [".config", "fish", "config.fish"]],
];

const RC_BLOCKS: Partial<Record<Shell, (userHome: string) => string>> = {
  zsh: zshBlock,
  bash: bashBlock,
};

const rcPath = (userHome: string, rc: string[]) => join(userHome, ...rc);

function rcTargets(userHome: string): [string, string][] {
  return SHELL_RCS.flatMap(([shell, rc]): [string, string][] => {
    const makeBlock = RC_BLOCKS[shell];
    const path = rcPath(userHome, rc);
    return makeBlock && existsSync(path) ? [[path, makeBlock(userHome)]] : [];
  });
}

const blockFiles = (userHome: string) => [
  join(userHome, ".claude", "CLAUDE.md"),
  ...SHELL_RCS.map(([, rc]) => rcPath(userHome, rc)),
];

const presentShells = (userHome: string) =>
  SHELL_RCS.filter(([, rc]) => existsSync(rcPath(userHome, rc))).map(([shell]) => shell);

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

function completionInstalled(userHome: string): boolean {
  const blocksWritten = rcTargets(userHome).every(([path, block]) =>
    readFileSync(path, "utf8").includes(block),
  );
  const filesWritten = presentShells(userHome).every((shell) =>
    existsSync(completionPath(userHome, shell)),
  );
  return blocksWritten && filesWritten;
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

function appendBlock(text: string, blockPattern: RegExp, block: string) {
  const stripped = text.replace(blockPattern, "");
  return `${stripped}${stripped && !stripped.endsWith("\n") ? "\n" : ""}\n${block}`.replace(
    /^\n+/,
    "",
  );
}

export async function install(userHome: string, home: string): Promise<number> {
  for (const [path, block] of rcTargets(userHome)) {
    rewrite(path, (text) => appendBlock(text, BLOCK, block));
  }
  writeCompletions(userHome);
  linkCl(userHome, home);
  return 0;
}

export async function uninstall(userHome: string, home: string): Promise<number> {
  for (const path of blockFiles(userHome)) {
    if (existsSync(path)) rewrite(path, (text) => text.replace(BLOCK, ""));
  }
  removeCompletions(userHome);
  unlinkCl(userHome, home);
  rmSync(serverEnvAgentPath(userHome), { force: true });
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
  const paths = ollamaLogPaths(userHome, systemRoot);
  if (paths.length === 0) {
    console.error("claude-lite: no Ollama log file found");
    return 1;
  }
  return await run(["tail", "-F", "-n", "20", ...paths]);
}

function configFilesParse(home: string): boolean {
  try {
    ollamaBaseSettings(home);
    loadSizes(home);
    return true;
  } catch {
    return false;
  }
}

export async function doctor(
  userHome: string,
  home: string,
  run: Runner = spawnRunner,
  systemRoot = "/",
): Promise<number> {
  const binaryBuilt = existsSync(binaryPath(home));
  const server = await serverStatus(run);
  const checks: [string, boolean][] = [
    ["binary built", binaryBuilt],
    ["binary runs", binaryBuilt && (await run([binaryPath(home), "--help"])) === 0],
    ["shell completion installed", completionInstalled(userHome)],
    ["cl link", readLink(clLinkPath(userHome)) === binaryPath(home)],
    ["config files parse", configFilesParse(home)],
    ["ollama server responds", server.isResponding],
    [`ollama ${MINIMUM_OLLAMA} or newer`, isSupportedVersion(server.version)],
    ["one ollama startup source", ollamaStartupSources(userHome, systemRoot).length <= 1],
    ["ollama server env set", (await run(["sh", "-c", serverEnvCheck()])) === 0],
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

function securityPosture(home: string): string[] {
  try {
    const effective = ollamaBaseSettings(home);
    return [
      `info sandbox ${effective.sandbox?.enabled === true ? "on" : "off"}`,
      `info permission mode ${effective.permissions?.defaultMode ?? "default"}`,
    ];
  } catch {
    return [];
  }
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
