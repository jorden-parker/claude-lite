import { HOOK_NAMES } from "./hooks/run-hook.ts";

export const COMMAND_HELP = {
  hook: `usage: claude-lite hook <name>\n  runs one guard hook on the event in stdin; names: ${HOOK_NAMES.join(", ")}`,
  ollama:
    "usage: claude-lite ollama [27b|35b|9b] [--print-config] [--think|--no-think] [--effort <level>] [claude args]\n  launches claude on a local Ollama model; --print-config prints the Modelfile and settings without launching\n  thinking and effort are set per size in config/sizes.json, then config/local-sizes.json, then env, then flags (later wins); sandbox and permissions come from config/ollama.json with config/local-ollama.json merged over it\n  env: CLAUDE_LITE_THINKING=on|off, CLAUDE_LITE_EFFORT=<level>; flags: the ones above and claude's --effort <level>",
  bench:
    "usage: claude-lite bench [27b|35b|9b] [--think|--no-think] [--effort <level>] [--runs <n>] [--compare] [--json]\n  measures a size's model on Ollama: tool-use quality on fixed tasks, generation and prompt tokens per second, and load time; --json prints the raw results\n  --runs <n> repeats every task n times and shows pass counts; every run is saved under ~/.cache/claude-lite/bench and --compare prints the change from the previous run of that model\n  takes the same size layers as ollama (config, env, flags)",
  install:
    "usage: claude-lite install\n  adds the CLAUDE.md @-import, the `claude` rc function, the ~/.local/bin/cl link and shell completion for zsh, bash and fish, backing up each file\n  CLAUDE_LITE_WRAP=0 makes the `claude` function run plain claude, without claude-lite settings and hooks",
  build: "usage: claude-lite build\n  compiles src/cli.ts to dist/claude-lite in the lite home",
  update: "usage: claude-lite update\n  git pull --ff-only, bun install, build, then install",
  uninstall: "usage: claude-lite uninstall\n  removes only what install added",
  disable:
    "usage: claude-lite disable\n  sets CLAUDE_LITE_WRAP=0 in each shell rc so `claude` runs plain Claude Code without claude-lite settings and hooks; takes effect in new shells",
  enable:
    "usage: claude-lite enable\n  removes what disable added so `claude` runs with claude-lite again; takes effect in new shells",
  doctor:
    "usage: claude-lite doctor\n  checks the build, blocks, link, hook config, that Ollama responds and has one startup source, and that agent-browser runs",
  logs: "usage: claude-lite logs\n  follows hook decisions and the Ollama logs named in its launchd plists and Ollama.app",
  servers:
    "usage: claude-lite servers\n  lists Ollama startup sources and the port 11434 listener, and sets the server env (keep-alive, flash attention, q8 KV cache, one loaded model) with launchctl setenv; fails when more than one source would start a server or the server does not respond",
  stats:
    "usage: claude-lite stats\n  summarizes ~/.cache/claude-lite/hooks.log: decisions, blocks, crashes and hidden lines per hook, and the most frequent block reasons",
  settings:
    "usage: claude-lite settings\n  prints config/claude.json with config/local-claude.json merged over it, as one line of JSON for claude --settings",
  config:
    "usage: claude-lite config\n  opens a screen for every setting: Claude model, effort, sandbox and permission mode (written to config/local-claude.json); the Ollama default size (auto picks one that fits memory) and that size's thinking, effort and output tokens (written to config/local-sizes.json), and Ollama sandbox and permission mode (written to config/local-ollama.json); Enter on Preferences or System prompt opens config/PREFERENCES.md or config/system-prompt.md in $VISUAL or $EDITOR\n  ↑↓ move, ←→ change, q saves, ctrl-c cancels; other keys in the local files are kept; without a terminal it prints the current values",
  "fix-servers":
    "usage: claude-lite fix-servers\n  keeps Ollama.app: boots out and moves Ollama LaunchAgents in ~/Library/LaunchAgents to ~/.Trash, then opens Ollama; reports plists that need sudo",
} as const satisfies Record<string, string>;

const firstLineWithoutPrefix = (help: string) =>
  help.split("\n")[0].replace("usage: claude-lite ", "");

export const USAGE = `usage: claude-lite ${Object.values(COMMAND_HELP).map(firstLineWithoutPrefix).join(" | ")}`;
