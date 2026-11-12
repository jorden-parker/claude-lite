import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { deny, type HookEvent, type HookResult } from "./types.ts";

const MAX_LINES = 300;
const MAX_BYTES = 5_000_000;
const BINARY_PROBE_BYTES = 8192;

function isBinary(path: string): boolean {
  const descriptor = openSync(path, "r");
  try {
    const probe = Buffer.alloc(BINARY_PROBE_BYTES);
    return probe.subarray(0, readSync(descriptor, probe, 0, BINARY_PROBE_BYTES, 0)).includes(0);
  } finally {
    closeSync(descriptor);
  }
}

function lineCount(path: string): number {
  const text = readFileSync(path, "utf8");
  return text.split("\n").length - (text.endsWith("\n") || !text ? 1 : 0);
}

function sizeProblem(path: string): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    if (isBinary(path)) return null;
    const bytes = statSync(path).size;
    if (bytes > MAX_BYTES) return `is ${Math.round(bytes / 1_000_000)} MB`;
    const lines = lineCount(path);
    return lines > MAX_LINES ? `has ${lines} lines` : null;
  } catch {
    return null;
  }
}

export function decide(event: HookEvent): HookResult {
  const input = event.tool_input ?? {};
  const limit = input.limit;
  if (Number.isInteger(limit) && limit > 0 && limit <= MAX_LINES) return null;
  const problem = sizeProblem(input.file_path ?? "");
  if (!problem) return null;
  return deny(
    `${input.file_path} ${problem}. git grep -n for the lines you need first, then Read again with offset and limit (limit ${MAX_LINES} or less).`,
  );
}
