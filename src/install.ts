import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const START = "# >>> claude-lite >>>";
const END = "# <<< claude-lite <<<";
const BLOCK = new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`);

const claudeMdBlock = (home: string) => `${START}\n@${join(home, "config", "PREFERENCES.md")}\n${END}\n`;
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

export function install(userHome: string, home: string) {
  for (const [path, block] of targets(userHome, home)) {
    rewrite(path, (text) => {
      const stripped = text.replace(BLOCK, "");
      return `${stripped}${stripped && !stripped.endsWith("\n") ? "\n" : ""}\n${block}`.replace(/^\n+/, "");
    });
  }
}

export function uninstall(userHome: string, home: string) {
  for (const [path] of targets(userHome, home)) {
    if (existsSync(path)) rewrite(path, (text) => text.replace(BLOCK, ""));
  }
}
