import { join } from "node:path";
import { COMMAND_HELP } from "./help.ts";
import { FLAGS } from "./ollama/size-overrides.ts";
import { loadSizes } from "./ollama/sizes.ts";

export type Shell = "zsh" | "bash" | "fish";
type CompletionWords = { commands: string[]; sizes: string[] };

export const START = "# >>> claude-lite >>>";
export const END = "# <<< claude-lite <<<";

const SHIMS: Record<Shell, string> = {
  zsh: 'compadd -- ${(f)"$(cl __complete ${words[2,CURRENT-1]})"}',
  bash: `_cl() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  COMPREPLY=($(compgen -W "$(cl __complete "\${COMP_WORDS[@]:1:COMP_CWORD-1}")" -- "$cur"))
}
complete -F _cl cl`,
  fish: "complete -c cl -f -a '(cl __complete (commandline -opc)[2..-1])'",
};

export function completionScript(shell: Shell): string {
  const header = shell === "zsh" ? "#compdef cl\n" : "";
  return `${header}${START}\n${SHIMS[shell]}\n${END}\n`;
}

export function completionWords(home: string): CompletionWords {
  let sizes: string[] = [];
  try {
    sizes = Object.keys(loadSizes(home));
  } catch {}
  return { commands: Object.keys(COMMAND_HELP), sizes };
}

export const EFFORT_LEVELS = ["low", "medium", "xhigh"];

const switchOf = (flag: string) => FLAGS[flag][0];

function unusedFlags(typed: string[]): string[] {
  const used = typed.filter((word) => Object.hasOwn(FLAGS, word));
  const usedSwitches = new Set(used.map(switchOf));
  const flags = Object.keys(FLAGS).filter((flag) => !usedSwitches.has(switchOf(flag)));
  if (!typed.includes("--effort")) flags.push("--effort");
  return flags;
}

function sizeCommandNext(typed: string[], sizes: string[], extraFlag: string): string[] {
  if (typed.length === 0) return [...sizes, "--help"];
  if (typed.at(-1) === "--effort") return EFFORT_LEVELS;
  if (typed.includes("--help")) return [];
  const flags = unusedFlags(typed);
  return typed.includes(extraFlag) ? flags : [extraFlag, ...flags];
}

const BENCH_FLAGS = new Set(["--think", "--no-think", "--effort"]);
const BENCH_ONLY_FLAGS = ["--runs", "--compare"];

const ollamaNext = (typed: string[], sizes: string[]) =>
  sizeCommandNext(typed, sizes, "--print-config");

function benchNext(typed: string[], sizes: string[]): string[] {
  if (typed.at(-1) === "--runs") return [];
  const words = sizeCommandNext(typed, sizes, "--json").filter(
    (word) =>
      !word.startsWith("--") || word === "--json" || word === "--help" || BENCH_FLAGS.has(word),
  );
  if (typed.length === 0 || typed.includes("--help") || typed.at(-1) === "--effort") return words;
  return [...words, ...BENCH_ONLY_FLAGS.filter((flag) => !typed.includes(flag))];
}

export function nextWords(typed: string[], { commands, sizes }: CompletionWords): string[] {
  const [command, ...rest] = typed;
  if (command === undefined) return [...commands, "help"];
  if (command === "help") return rest.length === 0 ? commands : [];
  if (command === "ollama" || command === "mlx") return ollamaNext(rest, sizes);
  if (command === "bench") return benchNext(rest, sizes);
  if (!commands.includes(command) || rest.length > 0) return [];
  return ["--help"];
}

export function completionPath(userHome: string, shell: Shell): string {
  const paths = {
    zsh: join(userHome, ".local", "share", "zsh", "site-functions", "_cl"),
    bash: join(userHome, ".local", "share", "bash-completion", "completions", "cl"),
    fish: join(userHome, ".config", "fish", "completions", "cl.fish"),
  };
  return paths[shell];
}
