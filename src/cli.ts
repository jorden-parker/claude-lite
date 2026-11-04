#!/usr/bin/env bun
import { homedir } from "node:os";
import { liteHome } from "./home.ts";
import { HOOK_NAMES, runHook } from "./hooks/run-hook.ts";
import { doctor, fixServers, install, logs, servers, uninstall, update } from "./install.ts";
import { launch } from "./ollama/launch.ts";

const LIFECYCLE = { install, uninstall, update, doctor, logs, servers, "fix-servers": fixServers };

const USAGE =
  "usage: claude-lite hook <name> | ollama [27b|35b] [--print-config] [claude args] | install | update | uninstall | doctor | logs | servers | fix-servers";

const COMMAND_HELP: Record<string, string> = {
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

const isHelpFlag = (arg: string | undefined) => arg === "-h" || arg === "--help";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const home = liteHome();
  if (isHelpFlag(command) || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (command && command in COMMAND_HELP && isHelpFlag(rest[0])) {
    console.log(COMMAND_HELP[command]);
    return 0;
  }
  if (command === "hook" && rest[0]) return await runHook(rest[0]);
  if (command === "ollama") return await launch(home, rest);
  if (command && command in LIFECYCLE) {
    const name = command as keyof typeof LIFECYCLE;
    const code = await LIFECYCLE[name](process.env.HOME ?? homedir(), home);
    console.log(
      code === 0 ? `claude-lite: ${name} done` : `claude-lite: ${name} failed (exit ${code})`,
    );
    return code;
  }
  console.error(USAGE);
  return 2;
}

process.exit(await main(process.argv.slice(2)));
