import { expect, test } from "bun:test";
import { join } from "node:path";
import { settings } from "../src/install.ts";
import { launch } from "../src/ollama/launch.ts";
import { loadSandboxSecrets, withSandboxSecrets } from "../src/sandbox-secrets.ts";

const home = join(import.meta.dir, "..");
const secrets = loadSandboxSecrets(home)!;

async function printedBy(print: () => Promise<number>): Promise<string[]> {
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => printed.push(line);
  try {
    await print();
  } finally {
    console.log = originalLog;
  }
  return printed;
}

const deniedNames = (sandbox: any) => sandbox.credentials.envVars.map((entry: any) => entry.name);

test("withSandboxSecrets unions the shared lists without duplicates", () => {
  const sandbox = {
    enabled: true,
    filesystem: { denyRead: ["~/.ssh", "~/.claude"] },
    credentials: { envVars: [{ name: "GH_TOKEN", mode: "deny" }] },
  };
  const shared = { denyRead: ["~/.ssh", "~/.gnupg"], envVars: ["GH_TOKEN", "NPM_TOKEN"] };
  const merged = withSandboxSecrets(sandbox, shared);
  expect(merged.filesystem.denyRead).toEqual(["~/.ssh", "~/.claude", "~/.gnupg"]);
  expect(deniedNames(merged)).toEqual(["GH_TOKEN", "NPM_TOKEN"]);
  expect(merged.enabled).toBe(true);
});

test("a home without sandbox-secrets.json has no shared secrets", () => {
  expect(loadSandboxSecrets("/nonexistent")).toBeNull();
});

test("the anthropic settings deny every shared secret", async () => {
  const [line] = await printedBy(() => settings("/unused", home));
  const { sandbox } = JSON.parse(line);
  expect(sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(secrets.denyRead));
  expect(deniedNames(sandbox)).toEqual(expect.arrayContaining(secrets.envVars));
});

test("the ollama settings deny every shared secret", async () => {
  const printed = await printedBy(() => launch(home, ["--print-config"]));
  const { sandbox } = JSON.parse(printed[1]);
  expect(sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(secrets.denyRead));
  expect(deniedNames(sandbox)).toEqual(expect.arrayContaining(secrets.envVars));
});
