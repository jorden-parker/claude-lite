#!/usr/bin/env bun
import { homedir } from "node:os";
import { liteHome } from "./home.ts";
import { runHook } from "./hooks/run-hook.ts";
import { install, uninstall } from "./install.ts";
import { launch } from "./ollama/launch.ts";

const USAGE =
  "usage: claude-lite hook <name> | ollama [27b|35b] [--print-config] [claude args] | install | uninstall";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const home = liteHome();
  if (command === "hook" && rest[0]) return await runHook(rest[0]);
  if (command === "ollama") return await launch(home, rest);
  if (command === "install" || command === "uninstall") {
    (command === "install" ? install : uninstall)(process.env.HOME ?? homedir(), home);
    console.log(`claude-lite: ${command} done`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

process.exit(await main(process.argv.slice(2)));
