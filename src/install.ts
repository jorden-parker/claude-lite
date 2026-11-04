import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { HOOK_NAMES, hookLogPath } from "./hooks/run-hook.ts";
import { type Runner, serverResponds, spawnRunner } from "./ollama/launch.ts";

const START = "# >>> claude-lite >>>";
const END = "# <<< claude-lite <<<";
const BLOCK = new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`);

const claudeMdBlock = (home: string) =>
  `${START}\n@${join(home, "config", "PREFERENCES.md")}\n${END}\n`;
const posixBlock = (home: string) =>
  `${START}\nclaude() { env CLAUDE_LITE_HOME="${home}" command claude --settings "${home}/config/personal-settings.json" "$@"; }\n${END}\n`;
const fishBlock = (home: string) =>
  `${START}\nfunction claude\n  env CLAUDE_LITE_HOME="${home}" command claude --settings "${home}/config/personal-settings.json" $argv\nend\n${END}\n`;

function targets(userHome: string, home: string): [string, string][] {
  const claudeMd = join(userHome, ".claude", "CLAUDE.md");
  const rcs: [string, string][] = [
    [join(userHome, ".zshrc"), posixBlock(home)],
    [join(userHome, ".bashrc"), posixBlock(home)],
    [join(userHome, ".config", "fish", "config.fish"), fishBlock(home)],
  ];
  return [[claudeMd, claudeMdBlock(home)], ...rcs.filter(([path]) => existsSync(path))];
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
  linkCl(userHome, home);
  return 0;
}

export async function uninstall(userHome: string, home: string): Promise<number> {
  for (const [path] of targets(userHome, home)) {
    if (existsSync(path)) rewrite(path, (text) => text.replace(BLOCK, ""));
  }
  unlinkCl(userHome, home);
  return 0;
}

export async function update(
  _userHome: string,
  home: string,
  run: Runner = spawnRunner,
): Promise<number> {
  const steps = [
    ["git", "-C", home, "pull", "--ff-only"],
    ["bun", "install", "--cwd", home],
    ["bun", "run", "--cwd", home, "build"],
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
  const oneSource = sources.length <= 1;
  if (!oneSource)
    console.log("FAIL more than one Ollama startup source; they fight over port 11434. Keep one.");
  return responds && oneSource ? 0 : 1;
}
