#!/usr/bin/env bun
import { homedir } from "node:os";
import { liteHome } from "./home.ts";
import { runHook } from "./hooks/run-hook.ts";
import { doctor, install, uninstall, update } from "./install.ts";
import { launch } from "./ollama/launch.ts";

const LIFECYCLE = { install, uninstall, update, doctor };

const USAGE =
  "usage: claude-lite hook <name> | ollama [27b|35b] [--print-config] [claude args] | install | update | uninstall | doctor";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const home = liteHome();
  if (command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
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
