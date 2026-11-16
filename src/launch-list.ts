import { draftRepoOf } from "./mlx.ts";
import { FLAGS } from "./ollama/size-overrides.ts";
import type { Size } from "./ollama/sizes.ts";

type Machine = { defaultName: string; fitting: string[]; hasSplash: boolean };

const flagNames = Object.keys(FLAGS);
const clientFlags = flagNames.filter((flag) => FLAGS[flag][0] !== "thinking");
const thinkingFlags = flagNames.filter((flag) => FLAGS[flag][0] === "thinking");

function sizeHeading(name: string, size: Size, machine: Machine): string {
  const configuredClient = clientFlags.map((flag) => FLAGS[flag][0]).find((key) => size[key]);
  return [
    name,
    size.base,
    size.memory_gb !== undefined && `${size.memory_gb} GB`,
    `thinking ${size.thinking ? "on" : "off"}`,
    size.effort && `effort ${size.effort}`,
    configuredClient && `client ${configuredClient}`,
    name === machine.defaultName && "default",
    !machine.fitting.includes(name) && "does not fit memory",
    size.vision_size && `images via ${size.vision_size}`,
  ]
    .filter(Boolean)
    .join("  ");
}

function startCommands(name: string, size: Size, hasSplash: boolean): string[] {
  const ollamaCommand = `cl ollama ${name}`;
  const commands = [`  ${ollamaCommand}  ${size.model}`];
  if (!size.mlx) return commands;
  const draftRepo = draftRepoOf(size, hasSplash);
  const served = draftRepo ? `${size.mlx}  draft ${draftRepo}` : size.mlx;
  return [...commands, `  ${`cl mlx ${name}`.padEnd(ollamaCommand.length)}  ${served}`];
}

export function renderLaunchList(sizes: Record<string, Size>, machine: Machine): string {
  const sizeBlocks = Object.entries(sizes).flatMap(([name, size]) => [
    sizeHeading(name, size, machine),
    ...startCommands(name, size, machine.hasSplash),
  ]);
  return [
    ...sizeBlocks,
    "",
    `clients: claude, or add ${clientFlags.join(" or ")} to any command`,
    `also: ${[...thinkingFlags, "--effort <level>", "--print-config"].join(", ")}`,
  ].join("\n");
}
