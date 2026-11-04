import { HOOK_NAMES } from "./hooks/run-hook.ts";

export const USAGE =
  "usage: claude-lite hook <name> | ollama [27b|35b] [--print-config] [claude args] | install | update | uninstall | doctor | logs | servers | fix-servers";

export const COMMAND_HELP: Record<string, string> = {
  hook: `usage: claude-lite hook <name>\n  runs one guard hook on the event in stdin; names: ${HOOK_NAMES.join(", ")}`,
  ollama:
    "usage: claude-lite ollama [27b|35b] [--print-config] [claude args]\n  launches claude on a local Ollama model; --print-config prints the Modelfile and settings without launching",
  install:
    "usage: claude-lite install\n  adds the CLAUDE.md @-import, the `claude` rc function and the ~/.local/bin/cl link, backing up each file",
  update: "usage: claude-lite update\n  git pull --ff-only, bun install, build, then install",
  uninstall: "usage: claude-lite uninstall\n  removes only what install added",
  doctor:
    "usage: claude-lite doctor\n  checks the build, blocks, link, hook config, that Ollama responds and has one startup source",
  logs: "usage: claude-lite logs\n  follows hook decisions and the Ollama logs named in its launchd plists and Ollama.app",
  servers:
    "usage: claude-lite servers\n  lists Ollama startup sources and the port 11434 listener; fails when more than one source would start a server or the server does not respond",
  "fix-servers":
    "usage: claude-lite fix-servers\n  keeps Ollama.app: boots out and moves Ollama LaunchAgents in ~/Library/LaunchAgents to ~/.Trash, then opens Ollama; reports plists that need sudo",
};
