import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { decide as bashGuard } from "./bash-guard.ts";
import { decide as bashTrim } from "./bash-trim.ts";
import { decide as editCheck } from "./edit-check.ts";
import { decideFallowStop as fallowStop } from "./fallow-stop.ts";
import { decide as readGuard } from "./read-guard.ts";
import { decideWithStateFile as tddGuard } from "./tdd-guard.ts";
import type { HookEvent, HookResult } from "./types.ts";

const HOOKS: Record<string, (event: HookEvent) => HookResult> = {
  "bash-guard": bashGuard,
  "bash-trim": bashTrim,
  "fallow-stop": (event) => fallowStop(event),
  "read-guard": readGuard,
  "edit-check": (event) => editCheck(event),
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
    decision: specific?.permissionDecision,
    reason: specific?.permissionDecisionReason,
    context: specific?.additionalContext,
    exitCode: result.exitCode,
    stderr: result.stderr,
  });
}

function appendHookLog(hook: string, event: HookEvent, result: HookResult): void {
  const line = logLine(hook, event, result, new Date());
  if (!line) return;
  try {
    const path = hookLogPath(process.env.HOME ?? homedir());
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
  } catch {}
}

export async function runHook(name: string): Promise<number> {
  const hook = HOOKS[name];
  if (!hook) {
    console.error(`claude-lite: unknown hook ${name}`);
    return 1;
  }
  let event: HookEvent;
  try {
    event = JSON.parse(await Bun.stdin.text());
  } catch {
    return 0;
  }
  const result = hook(event);
  appendHookLog(name, event, result);
  if (result?.output) console.log(JSON.stringify(result.output));
  if (result?.stderr) console.error(result.stderr);
  return result?.exitCode ?? 0;
}
