export type LaunchTarget = "anthropic" | "ollama";

type Env = Record<string, string | undefined>;

const OPT_OUT_VARIABLES = {
  permissions: "CLAUDE_LITE_NO_PERMISSIONS",
  sandbox: "CLAUDE_LITE_NO_SANDBOX",
} as const;

type OptOutKey = keyof typeof OPT_OUT_VARIABLES;

export function optsOut(key: OptOutKey, target: LaunchTarget, env: Env): boolean {
  return (env[OPT_OUT_VARIABLES[key]] ?? "")
    .split(",")
    .map((name) => name.trim())
    .includes(target);
}

export function withOptOutsFor<T extends object>(
  target: LaunchTarget,
  settings: T,
  env: Env = process.env,
): T | Partial<T> {
  const droppedKeys = (Object.keys(OPT_OUT_VARIABLES) as OptOutKey[]).filter((key) =>
    optsOut(key, target, env),
  );
  if (droppedKeys.length === 0) return settings;
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => !droppedKeys.includes(key as OptOutKey)),
  ) as Partial<T>;
}
