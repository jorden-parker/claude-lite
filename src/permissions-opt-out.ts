export type LaunchTarget = "anthropic" | "ollama";

type Env = Record<string, string | undefined>;

const OPT_OUT_VARIABLES = {
  permissions: "CLAUDE_LITE_NO_PERMISSIONS",
  sandbox: "CLAUDE_LITE_NO_SANDBOX",
} as const;

function optsOut(variable: string, target: LaunchTarget, env: Env): boolean {
  return (env[variable] ?? "")
    .split(",")
    .map((name) => name.trim())
    .includes(target);
}

export function withOptOutsFor<T extends object>(
  target: LaunchTarget,
  settings: T,
  env: Env = process.env,
): T | Partial<T> {
  const droppedKeys = Object.entries(OPT_OUT_VARIABLES)
    .filter(([, variable]) => optsOut(variable, target, env))
    .map(([key]) => key);
  if (droppedKeys.length === 0) return settings;
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => !droppedKeys.includes(key)),
  ) as Partial<T>;
}
