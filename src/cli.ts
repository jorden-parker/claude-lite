#!/usr/bin/env bun
import { homedir } from "node:os";
import { completionWords, nextWords } from "./completion.ts";
import { liteHome } from "./home.ts";
import { COMMAND_HELP, USAGE } from "./help.ts";
import { runHook } from "./hooks/run-hook.ts";
import {
  config,
  disable,
  doctor,
  enable,
  fixServers,
  install,
  logs,
  servers,
  settings,
  stats,
  uninstall,
  update,
  build,
} from "./install.ts";
import { bench } from "./ollama/bench.ts";
import { launch } from "./ollama/launch.ts";

const LIFECYCLE: Record<
  Exclude<keyof typeof COMMAND_HELP, "hook" | "ollama" | "bench">,
  (userHome: string, home: string) => Promise<number>
> = {
  install,
  uninstall,
  update,
  build,
  disable,
  enable,
  doctor,
  logs,
  servers,
  settings,
  stats,
  config,
  "fix-servers": fixServers,
};

const isHelpFlag = (arg: string | undefined) => arg === "-h" || arg === "--help";

type CommandName = keyof typeof COMMAND_HELP;

const isCommand = (word: string | undefined): word is CommandName =>
  word !== undefined && Object.hasOwn(COMMAND_HELP, word);

async function runLifecycle(name: keyof typeof LIFECYCLE, extraArgs: string[], home: string) {
  if (extraArgs.length > 0) {
    console.error(COMMAND_HELP[name]);
    return 2;
  }
  const code = await LIFECYCLE[name](process.env.HOME ?? homedir(), home);
  if (name === "settings" || name === "config") return code;
  console.log(
    code === 0 ? `claude-lite: ${name} done` : `claude-lite: ${name} failed (exit ${code})`,
  );
  return code;
}

function runHookCommand(hookName: string | undefined) {
  if (hookName) return runHook(hookName);
  console.error(COMMAND_HELP.hook);
  return 2;
}

function printHelp(topic: string | undefined) {
  console.log(isCommand(topic) ? COMMAND_HELP[topic] : USAGE);
  return 0;
}

type ArgumentCommand = (home: string, commandArgs: string[]) => Promise<number>;

const ARGUMENT_COMMANDS: Record<"hook" | "ollama" | "bench", ArgumentCommand> = {
  hook: async (_home, commandArgs) => runHookCommand(commandArgs[0]),
  ollama: launch,
  bench,
};

async function runCommand(command: string | undefined, rest: string[], home: string) {
  if (Object.hasOwn(ARGUMENT_COMMANDS, command ?? "")) {
    return await ARGUMENT_COMMANDS[command as keyof typeof ARGUMENT_COMMANDS](home, rest);
  }
  if (Object.hasOwn(LIFECYCLE, command ?? "")) {
    return await runLifecycle(command as keyof typeof LIFECYCLE, rest, home);
  }
  console.error(USAGE);
  return 2;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const home = liteHome();
  if (command === "__complete") {
    console.log(nextWords(rest, completionWords(home)).join("\n"));
    return 0;
  }
  if (command === "help") return printHelp(rest[0]);
  if (isHelpFlag(command)) return printHelp(undefined);
  if (isCommand(command) && isHelpFlag(rest[0])) return printHelp(command);
  return await runCommand(command, rest, home);
}

process.exit(await main(process.argv.slice(2)));
