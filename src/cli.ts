#!/usr/bin/env bun
import { homedir } from "node:os";
import { completionWords, nextWords } from "./completion.ts";
import { report } from "./report.ts";
import { liteHome } from "./home.ts";
import { COMMAND_HELP, USAGE } from "./help.ts";
import {
  build,
  config,
  doctor,
  fixServers,
  install,
  list,
  logs,
  servers,
  stop,
  uninstall,
  update,
} from "./install.ts";
import { launchMlx, serveMlx } from "./mlx.ts";
import { bench } from "./ollama/bench.ts";
import { launch } from "./ollama/launch.ts";

const LIFECYCLE: Record<
  Exclude<keyof typeof COMMAND_HELP, "ollama" | "mlx" | "serve" | "bench" | "report">,
  (userHome: string, home: string) => Promise<number>
> = {
  install,
  uninstall,
  update,
  build,
  doctor,
  logs,
  servers,
  stop,
  config,
  list,
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
  if (name === "config" || name === "list") return code;
  console.log(
    code === 0 ? `claude-lite: ${name} done` : `claude-lite: ${name} failed (exit ${code})`,
  );
  return code;
}

function printHelp(topic: string | undefined) {
  console.log(isCommand(topic) ? COMMAND_HELP[topic] : USAGE);
  return 0;
}

type ArgumentCommand = (home: string, commandArgs: string[]) => Promise<number>;

const ARGUMENT_COMMANDS: Record<"ollama" | "mlx" | "serve" | "bench" | "report", ArgumentCommand> =
  {
    report: async (home, args) => {
      const live = args.includes("--live");
      const snapshot = args.includes("--snapshot");
      if (
        (live && snapshot) ||
        args.some((flag) => !["--live", "--snapshot", "--all-models"].includes(flag))
      ) {
        console.error(COMMAND_HELP.report);
        return 2;
      }
      return report(
        process.env.HOME ?? homedir(),
        home,
        args.includes("--all-models"),
        live || (!snapshot && Boolean(process.stdout.isTTY)),
      );
    },
    ollama: launch,
    mlx: (home, commandArgs) => launchMlx(home, commandArgs),
    serve: (home, commandArgs) => serveMlx(home, commandArgs),
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
