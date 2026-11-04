import { join } from "node:path";

export type Shell = "zsh" | "bash" | "fish";
export type CompletionWords = { commands: string[]; hooks: string[]; sizes: string[] };

export const START = "# >>> claude-lite >>>";
export const END = "# <<< claude-lite <<<";

const list = (items: string[]) => items.join(" ");

const zshBody = ({ commands, hooks, sizes }: CompletionWords) => `_cl() {
  if (( CURRENT == 2 )); then
    compadd -- ${list(commands)}
  elif (( CURRENT == 3 )); then
    case $words[2] in
      hook) compadd -- ${list(hooks)} --help ;;
      ollama) compadd -- ${list(sizes)} --print-config --help ;;
      *) compadd -- --help ;;
    esac
  fi
}`;

const bashBody = ({ commands, hooks, sizes }: CompletionWords) => `_cl() {
  local current=\${COMP_WORDS[COMP_CWORD]}
  if (( COMP_CWORD == 1 )); then
    COMPREPLY=($(compgen -W "${list(commands)}" -- "$current"))
  elif (( COMP_CWORD == 2 )); then
    case \${COMP_WORDS[1]} in
      hook) COMPREPLY=($(compgen -W "${list(hooks)} --help" -- "$current")) ;;
      ollama) COMPREPLY=($(compgen -W "${list(sizes)} --print-config --help" -- "$current")) ;;
      *) COMPREPLY=($(compgen -W "--help" -- "$current")) ;;
    esac
  fi
}
complete -F _cl cl`;

const fishBody = ({ commands, hooks, sizes }: CompletionWords) =>
  [
    "complete -c cl -f",
    `complete -c cl -n '__fish_use_subcommand' -a '${list(commands)}'`,
    `complete -c cl -n '__fish_seen_subcommand_from ${list(commands)}' -a '--help'`,
    `complete -c cl -n '__fish_seen_subcommand_from hook' -a '${list(hooks)}'`,
    `complete -c cl -n '__fish_seen_subcommand_from ollama' -a '${list(sizes)} --print-config'`,
  ].join("\n");

export function completionScript(shell: Shell, words: CompletionWords): string {
  const bodies = { zsh: zshBody, bash: bashBody, fish: fishBody };
  const header = shell === "zsh" ? "#compdef cl\n" : "";
  return `${header}${START}\n${bodies[shell](words)}\n${END}\n`;
}

export function completionPath(userHome: string, shell: Shell): string {
  const paths = {
    zsh: join(userHome, ".local", "share", "zsh", "site-functions", "_cl"),
    bash: join(userHome, ".local", "share", "bash-completion", "completions", "cl"),
    fish: join(userHome, ".config", "fish", "completions", "cl.fish"),
  };
  return paths[shell];
}
