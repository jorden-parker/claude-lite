import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type Runner, spawnRunner } from "./ollama/launch.ts";

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
