export const COMMAND_HELP = {
  ollama:
    "usage: claude-lite ollama [27b|35b|9b] [--print-config] [--think|--no-think] [--qwen] [--effort <level>] [claude args]\n  launches claude on a local Ollama model; --print-config prints the Modelfile and settings without launching\n  --qwen runs Qwen Code (qwen, npm i -g @qwen-code/qwen-code) instead of claude, against the server's /v1 endpoint; it skips claude-lite's permissions, sandbox, secret denies and system prompt, so configure ~/.qwen/settings.json\n  thinking and effort are set per size in config/sizes.json, then config/local-sizes.json, then env, then flags (later wins); sandbox and permissions come from config/ollama.json with config/local-ollama.json merged over it\n  env: CLAUDE_LITE_THINKING=on|off, CLAUDE_LITE_EFFORT=<level>; flags: the ones above and claude's --effort <level>",
  mlx: "usage: claude-lite mlx [27b|35b|9b] [--print-config] [--think|--no-think] [--qwen] [--effort <level>] [claude args]\n  launches claude on the size's mlx model served by vllm-mlx (uvx, port 8435 or CLAUDE_LITE_MLX_PORT) instead of Ollama; unloads loaded Ollama models first and stops the server when claude exits\n  --print-config prints the server command and settings without launching; thinking, effort and sampling come from the size as for ollama; the server log is ~/.cache/claude-lite/mlx-server.log\n  --qwen runs Qwen Code (qwen, npm i -g @qwen-code/qwen-code) instead of claude, against the server's /v1 endpoint; it skips claude-lite's permissions, sandbox, secret denies and system prompt, so configure ~/.qwen/settings.json",
  bench:
    "usage: claude-lite bench [27b|35b|9b] [--think|--no-think] [--effort <level>] [--runs <n>] [--compare] [--json]\n  measures a size's model on Ollama: tool-use quality on fixed tasks, generation and prompt tokens per second, and load time; --json prints the raw results\n  --runs <n> repeats every task n times and shows pass counts; every run is saved under ~/.cache/claude-lite/bench and --compare prints the change from the previous run of that model\n  takes the same size layers as ollama (config, env, flags)",
  install:
    "usage: claude-lite install\n  links ~/.local/bin/cl to dist/claude-lite and installs shell completion for zsh, bash and fish, backing up each rc file it changes",
  build: "usage: claude-lite build\n  compiles src/cli.ts to dist/claude-lite in the lite home",
  update: "usage: claude-lite update\n  git pull --ff-only, bun install, build, then install",
  uninstall:
    "usage: claude-lite uninstall\n  removes what install added and the server env login agent that cl servers writes",
  doctor:
    "usage: claude-lite doctor\n  checks the build, shell completion, the cl link, config files, that Ollama responds with one startup source and the server env, and prints the Ollama sandbox and permission mode",
  logs: "usage: claude-lite logs\n  follows the Ollama logs named in its launchd plists and Ollama.app, plus the cl mlx server log",
  servers:
    "usage: claude-lite servers\n  lists Ollama startup sources and the port 11434 listener, and sets the server env (keep-alive, flash attention, q8 KV cache, one loaded model) with launchctl setenv; fails when more than one source would start a server or the server does not respond",
  config:
    "usage: claude-lite config\n  opens a screen for the Ollama settings: the default size (auto picks one that fits memory) and that size's thinking, effort and output tokens (written to config/local-sizes.json), and Ollama sandbox and permission mode (written to config/local-ollama.json); Enter on System prompt opens config/system-prompt.md in $VISUAL or $EDITOR\n  ↑↓ move, ←→ change, q or Esc saves, ctrl-c cancels; other keys in the local files are kept; without a terminal it prints the current values",
  "fix-servers":
    "usage: claude-lite fix-servers\n  keeps Ollama.app: boots out and moves Ollama LaunchAgents in ~/Library/LaunchAgents to ~/.Trash, then opens Ollama; reports plists that need sudo",
} as const satisfies Record<string, string>;

const firstLineWithoutPrefix = (help: string) =>
  help.split("\n")[0].replace("usage: claude-lite ", "");

export const USAGE = `usage: claude-lite ${Object.values(COMMAND_HELP).map(firstLineWithoutPrefix).join(" | ")}`;
