import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type SandboxSecrets = { denyRead: string[]; envVars: string[] };
type Sandbox = Record<string, any>;

export function loadSandboxSecrets(home: string): SandboxSecrets | null {
  const secretsPath = join(home, "config", "sandbox-secrets.json");
  return existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, "utf8")) : null;
}

export function withSandboxSecrets(sandbox: Sandbox, secrets: SandboxSecrets): Sandbox {
  const deniedVariables: { name: string }[] = sandbox.credentials?.envVars ?? [];
  const deniedNames = new Set(deniedVariables.map((entry) => entry.name));
  const addedVariables = secrets.envVars
    .filter((name) => !deniedNames.has(name))
    .map((name) => ({ name, mode: "deny" }));
  return {
    ...sandbox,
    filesystem: {
      ...sandbox.filesystem,
      denyRead: [...new Set([...(sandbox.filesystem?.denyRead ?? []), ...secrets.denyRead])],
    },
    credentials: { ...sandbox.credentials, envVars: [...deniedVariables, ...addedVariables] },
  };
}

export function withSharedSecrets<Settings extends Record<string, any>>(
  settings: Settings,
  home: string,
): Settings {
  const secrets = loadSandboxSecrets(home);
  if (!secrets || !settings.sandbox) return settings;
  return { ...settings, sandbox: withSandboxSecrets(settings.sandbox, secrets) };
}
