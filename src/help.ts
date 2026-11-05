import { HOOK_NAMES } from "./hooks/run-hook.ts";

export const COMMAND_HELP = {
  hook: `usage: claude-lite hook <name>\n  runs one guard hook on the event in stdin; names: ${HOOK_NAMES.join(", ")}`,
  ollama:
    "usage: claude-lite ollama [27b|35b] [--print-config] [--think|--no-think] [--permissions|--no-permissions] [--sandbox|--no-sandbox] [claude args]\n  launches claude on a local Ollama model; --print-config prints the Modelfile and settings without launching\n  thinking, effort, permissions and sandbox are set per size in config/sizes.json, then config/local-sizes.json, then env, then flags (later wins)\n  env: CLAUDE_LITE_THINKING=on|off, CLAUDE_LITE_EFFORT=<level>, CLAUDE_LITE_NO_PERMISSIONS=ollama (omits claude-lite's permissions block; ~/.claude/settings.json permissions still apply), CLAUDE_LITE_NO_SANDBOX=ollama; flags: the ones above and claude's --effort <level>",
  install:
    "usage: claude-lite install\n  adds the CLAUDE.md @-import, the `claude` rc function, the ~/.local/bin/cl link and shell completion for zsh, bash and fish, backing up each file",
  build: "usage: claude-lite build\n  compiles src/cli.ts to dist/claude-lite in the lite home",
  update: "usage: claude-lite update\n  git pull --ff-only, bun install, build, then install",
  uninstall: "usage: claude-lite uninstall\n  removes only what install added",
  doctor:
    "usage: claude-lite doctor\n  checks the build, blocks, link, hook config, that Ollama responds and has one startup source",
  logs: "usage: claude-lite logs\n  follows hook decisions and the Ollama logs named in its launchd plists and Ollama.app",
  servers:
    "usage: claude-lite servers\n  lists Ollama startup sources and the port 11434 listener; fails when more than one source would start a server or the server does not respond",
  settings:
    "usage: claude-lite settings\n  prints config/personal-settings.json with config/local-settings.json merged over it, as one line of JSON for claude --settings\n  CLAUDE_LITE_NO_PERMISSIONS=anthropic omits claude-lite's permissions block (~/.claude/settings.json permissions still apply); CLAUDE_LITE_NO_SANDBOX=anthropic omits the sandbox block",
  "fix-servers":
    "usage: claude-lite fix-servers\n  keeps Ollama.app: boots out and moves Ollama LaunchAgents in ~/Library/LaunchAgents to ~/.Trash, then opens Ollama; reports plists that need sudo",
} as const satisfies Record<string, string>;

const firstLineWithoutPrefix = (help: string) =>
  help.split("\n")[0].replace("usage: claude-lite ", "");

export const USAGE = `usage: claude-lite ${Object.values(COMMAND_HELP).map(firstLineWithoutPrefix).join(" | ")}`;
