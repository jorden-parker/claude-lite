export type LaunchTarget = "anthropic" | "ollama";

export function withoutPermissionsFor<T extends object>(
  target: LaunchTarget,
  settings: T,
  env: Record<string, string | undefined> = process.env,
): T | Omit<T, "permissions" | "sandbox"> {
  const optedOut = (env.CLAUDE_LITE_NO_PERMISSIONS ?? "").split(",").map((name) => name.trim());
  if (!optedOut.includes(target)) return settings;
  const { permissions: _permissions, sandbox: _sandbox, ...rest } = settings as any;
  return rest;
}
