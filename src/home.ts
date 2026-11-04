import { basename, dirname, join } from "node:path";

export function liteHome(): string {
  if (process.env.CLAUDE_LITE_HOME) return process.env.CLAUDE_LITE_HOME;
  return basename(process.execPath) === "claude-lite"
    ? dirname(dirname(process.execPath))
    : join(import.meta.dir, "..");
}
