import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../src/install.ts";
import type { LauncherApi } from "../src/ollama/api.ts";
import { isSupportedVersion, launch, type Runner } from "../src/ollama/launch.ts";

const home = join(import.meta.dir, "..");
const serverWithVersion =
  (version: string): Runner =>
  async (argv) => {
    if (argv[0] === "curl")
      writeFileSync(argv[argv.indexOf("-o") + 1], JSON.stringify({ version }));
    return 0;
  };
const api: LauncherApi = {
  load: async () => null,
  chat: async () => {
    throw new Error("not used");
  },
  parameters: async () => null,
};

async function captured(channel: "log" | "error", action: () => Promise<number>) {
  const printed: string[] = [];
  const original = console[channel];
  console[channel] = (line: string) => printed.push(line);
  try {
    return { code: await action(), printed };
  } finally {
    console[channel] = original;
  }
}

test("isSupportedVersion compares numerically and accepts an unknown version", () => {
  expect(isSupportedVersion("0.40.12")).toBe(true);
  expect(isSupportedVersion("0.41.0")).toBe(true);
  expect(isSupportedVersion("1.0.0-rc1")).toBe(true);
  expect(isSupportedVersion("0.40.9")).toBe(false);
  expect(isSupportedVersion("0.9.99")).toBe(false);
  expect(isSupportedVersion(null)).toBe(true);
});

test("launch stops when Ollama is older than the minimum", async () => {
  const outdated = serverWithVersion("0.39.5");
  const { code, printed } = await captured("error", () => launch(home, [], outdated, api));
  expect(code).toBe(1);
  expect(printed[0]).toBe("Ollama 0.39.5 is older than 0.40.12; update Ollama");
});

test("doctor fails the version check on an old Ollama and passes on a new one", async () => {
  const userHome = mkdtempSync(join(tmpdir(), "version-user-"));
  const check = (version: string) =>
    captured("log", () => doctor(userHome, home, serverWithVersion(version), userHome));
  expect((await check("0.39.5")).printed).toContain("FAIL ollama 0.40.12 or newer");
  expect((await check("0.41.0")).printed).toContain("ok   ollama 0.40.12 or newer");
});
