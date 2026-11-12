import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { decide as bashGuard } from "./bash-guard.ts";
import { decideFromTranscript as browserCheck } from "./browser-check.ts";
import { decide as commitGuard } from "./commit-guard.ts";
import { decide as bashTrim } from "./bash-trim.ts";
import { decide as editCheck } from "./edit-check.ts";
import { decideFallowStop as fallowStop } from "./fallow-stop.ts";
import { decide as readGuard } from "./read-guard.ts";
import { decideWithStateFile as tddGuard } from "./tdd-guard.ts";
import type { HookEvent, HookResult } from "./types.ts";

const MAX_LOG_BYTES = 5_000_000;

const HOOKS: Record<string, (event: HookEvent) => HookResult> = {
  "bash-guard": bashGuard,
  "bash-trim": bashTrim,
  "browser-check": browserCheck,
  "commit-guard": commitGuard,
  "fallow-stop": fallowStop,
  "read-guard": readGuard,
  "edit-check": editCheck,
  "tdd-guard": tddGuard,
};

export const HOOK_NAMES = Object.keys(HOOKS);

export function hookLogPath(userHome: string): string {
  return join(userHome, ".cache/claude-lite/hooks.log");
}

export function logLine(
  hook: string,
  event: HookEvent,
  result: HookResult,
  now: Date,
): string | null {
  if (!result) return null;
  const specific = (result.output as { hookSpecificOutput?: Record<string, string> } | undefined)
    ?.hookSpecificOutput;
  return JSON.stringify({
    time: now.toISOString(),
    hook,
    event: event.hook_event_name,
    tool: event.tool_name,
    session: event.session_id,
    decision: specific?.permissionDecision,
    reason: specific?.permissionDecisionReason,
    context: specific?.additionalContext,
    exitCode: result.exitCode,
    stderr: result.stderr,
    hiddenLines: result.hiddenLines,
  });
}

function crashLine(hook: string, event: HookEvent, error: unknown, now: Date): string {
  return JSON.stringify({
    time: now.toISOString(),
    hook,
    event: event.hook_event_name,
    tool: event.tool_name,
    crashed: error instanceof Error ? error.message : String(error),
  });
}

function appendHookLog(line: string | null): void {
  if (!line) return;
  try {
    const path = hookLogPath(process.env.HOME ?? homedir());
    mkdirSync(dirname(path), { recursive: true });
    const logBytes = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    if (logBytes > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
  } catch {}
}

async function readEvent(): Promise<HookEvent | undefined> {
  try {
    return JSON.parse(await Bun.stdin.text());
  } catch {
    return undefined;
  }
}

function emitResult(result: HookResult): number {
  if (result?.output) console.log(JSON.stringify(result.output));
  if (result?.stderr) console.error(result.stderr);
  return result?.exitCode ?? 0;
}

export async function runHook(name: string): Promise<number> {
  const hook = HOOKS[name];
  if (!hook) {
    console.error(`claude-lite: unknown hook ${name}`);
    return 1;
  }
  const event = await readEvent();
  if (!event) return 0;
  let result: HookResult;
  try {
    result = hook(event);
  } catch (error) {
    appendHookLog(crashLine(name, event, error, new Date()));
    return 0;
  }
  appendHookLog(logLine(name, event, result, new Date()));
  return emitResult(result);
}
