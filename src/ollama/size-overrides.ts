import { optsOut } from "../permissions-opt-out.ts";
import type { Size } from "./sizes.ts";

type Env = Record<string, string | undefined>;
type Switch = "thinking" | "permissions" | "sandbox";

export const FLAGS: Record<string, [Switch, boolean]> = {
  "--think": ["thinking", true],
  "--no-think": ["thinking", false],
  "--permissions": ["permissions", true],
  "--no-permissions": ["permissions", false],
  "--sandbox": ["sandbox", true],
  "--no-sandbox": ["sandbox", false],
};

const THINKING_VALUES: Record<string, boolean> = { on: true, off: false };

export function applyEnv(size: Size, env: Env): Size {
  const thinking = THINKING_VALUES[env.CLAUDE_LITE_THINKING ?? ""];
  return {
    ...size,
    ...(thinking !== undefined && { thinking }),
    ...(env.CLAUDE_LITE_EFFORT && { effort: env.CLAUDE_LITE_EFFORT }),
    ...(optsOut("permissions", "ollama", env) && { permissions: false }),
    ...(optsOut("sandbox", "ollama", env) && { sandbox: false }),
  };
}

export function applyFlags(size: Size, args: string[]): { size: Size; claudeArgs: string[] } {
  const switches = args.filter((arg) => Object.hasOwn(FLAGS, arg)).map((arg) => FLAGS[arg]);
  return {
    size: { ...size, ...Object.fromEntries(switches) },
    claudeArgs: args.filter((arg) => !Object.hasOwn(FLAGS, arg)),
  };
}
