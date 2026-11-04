#!/usr/bin/env bun
import { homedir } from "node:os";
import { liteHome } from "./home.ts";
import { COMMAND_HELP, USAGE } from "./help.ts";
import { runHook } from "./hooks/run-hook.ts";
import {
  doctor,
  fixServers,
  install,
  logs,
  servers,
  settings,
  uninstall,
  update,
} from "./install.ts";
import { launch } from "./ollama/launch.ts";

const LIFECYCLE: Record<
  Exclude<keyof typeof COMMAND_HELP, "hook" | "ollama">,
  (userHome: string, home: string) => Promise<number>
> = { install, uninstall, update, doctor, logs, servers, settings, "fix-servers": fixServers };

const isHelpFlag = (arg: string | undefined) => arg === "-h" || arg === "--help";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const home = liteHome();
  if (isHelpFlag(command) || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (command && Object.hasOwn(COMMAND_HELP, command) && isHelpFlag(rest[0])) {
    console.log(COMMAND_HELP[command as keyof typeof COMMAND_HELP]);
    return 0;
  }
  if (command === "hook" && rest[0]) return await runHook(rest[0]);
  if (command === "ollama") return await launch(home, rest);
  if (command && Object.hasOwn(LIFECYCLE, command)) {
    const name = command as keyof typeof LIFECYCLE;
    const code = await LIFECYCLE[name](process.env.HOME ?? homedir(), home);
    if (name === "settings") return code;
    console.log(
      code === 0 ? `claude-lite: ${name} done` : `claude-lite: ${name} failed (exit ${code})`,
    );
    return code;
  }
  console.error(USAGE);
  return 2;
}

process.exit(await main(process.argv.slice(2)));
