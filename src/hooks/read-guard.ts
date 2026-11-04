import { existsSync, readFileSync } from "node:fs";
import { deny, type HookEvent, type HookResult } from "./types.ts";

const MAX_LINES = 300;

function lineCount(path: string): number {
  if (!path || !existsSync(path)) return 0;
  try {
    const data = readFileSync(path);
    if (data.subarray(0, 8192).includes(0)) return 0;
    const text = data.toString("utf8");
    return text.split("\n").length - (text.endsWith("\n") || !text ? 1 : 0);
  } catch {
    return 0;
  }
}

export function decide(event: HookEvent): HookResult {
  const input = event.tool_input ?? {};
  const limit = input.limit;
  if (Number.isInteger(limit) && limit > 0 && limit <= MAX_LINES) return null;
  const lines = lineCount(input.file_path ?? "");
  if (lines <= MAX_LINES) return null;
  return deny(
    `${input.file_path} has ${lines} lines. Grep for the lines you need first, then Read again with offset and limit (limit ${MAX_LINES} or less).`,
  );
}
