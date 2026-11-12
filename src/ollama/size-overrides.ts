import type { Size } from "./sizes.ts";

type Env = Record<string, string | undefined>;
type Switch = "thinking" | "qwen";

export const FLAGS: Record<string, [Switch, boolean]> = {
  "--think": ["thinking", true],
  "--no-think": ["thinking", false],
  "--qwen": ["qwen", true],
};

const THINKING_VALUES: Record<string, boolean> = { on: true, off: false };

export function applyEnv(size: Size, env: Env): Size {
  const thinking = THINKING_VALUES[env.CLAUDE_LITE_THINKING ?? ""];
  return {
    ...size,
    ...(thinking !== undefined && { thinking }),
    ...(env.CLAUDE_LITE_EFFORT && { effort: env.CLAUDE_LITE_EFFORT }),
  };
}

const EFFORT_FLAG = /^--effort(?:=(.*))?$/;

function takeEffort(args: string[]) {
  const claudeArgs: string[] = [];
  let effort: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const match = EFFORT_FLAG.exec(args[index]);
    if (!match) claudeArgs.push(args[index]);
    else if (match[1] !== undefined) effort = match[1];
    else effort = args[++index];
  }
  return { effort, claudeArgs };
}

export function applyFlags(size: Size, args: string[]): { size: Size; claudeArgs: string[] } {
  const { effort, claudeArgs } = takeEffort(args);
  const switches = claudeArgs.filter((arg) => Object.hasOwn(FLAGS, arg)).map((arg) => FLAGS[arg]);
  return {
    size: { ...size, ...Object.fromEntries(switches), ...(effort && { effort }) },
    claudeArgs: claudeArgs.filter((arg) => !Object.hasOwn(FLAGS, arg)),
  };
}
