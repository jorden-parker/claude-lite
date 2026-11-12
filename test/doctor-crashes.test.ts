import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hookLogPath } from "../src/hooks/run-hook.ts";
import { doctor, recentHookCrashes } from "../src/install.ts";

const now = Date.parse("2026-11-11T12:00:00.000Z");
const crashAt = (time: string) => JSON.stringify({ time, hook: "browser-check", crashed: "boom" });

function userHomeWithLog(logLines: string[]) {
  const userHome = mkdtempSync(join(tmpdir(), "crashes-"));
  mkdirSync(dirname(hookLogPath(userHome)), { recursive: true });
  writeFileSync(hookLogPath(userHome), logLines.join("\n") + "\n");
  return userHome;
}

test("recentHookCrashes counts only crashes from the last day", () => {
  const userHome = userHomeWithLog([
    crashAt("2026-11-11T11:00:00.000Z"),
    crashAt("2026-11-09T11:00:00.000Z"),
    JSON.stringify({ time: "2026-11-11T11:30:00.000Z", hook: "bash-guard", decision: "deny" }),
    "not json",
  ]);
  expect(recentHookCrashes(userHome, now)).toBe(1);
  expect(recentHookCrashes(mkdtempSync(join(tmpdir(), "crashes-")), now)).toBe(0);
});

test("doctor reports recent hook crashes", async () => {
  const userHome = userHomeWithLog([crashAt(new Date().toISOString())]);
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => printed.push(line);
  try {
    await doctor(userHome, join(import.meta.dir, ".."), async () => 0, userHome);
  } finally {
    console.log = originalLog;
  }
  expect(printed).toContain("FAIL no hook crashes in the last day");
});
