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
  if (result?.output) console.log(JSON.stringify(result.output));
  if (result?.stderr) console.error(result.stderr);
  return result?.exitCode ?? 0;
}
