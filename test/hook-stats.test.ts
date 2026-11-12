import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { summarizeHookLog } from "../src/hook-stats.ts";
import { hookLogPath } from "../src/hooks/run-hook.ts";
import { stats } from "../src/install.ts";

const gitLogReason = "Unbounded git log. Use: git log --oneline -n 20";
const logText = [
  { hook: "bash-trim", hiddenLines: 120 },
  { hook: "bash-trim", hiddenLines: 30 },
  { hook: "bash-guard", decision: "deny", reason: gitLogReason },
  { hook: "bash-guard", decision: "deny", reason: gitLogReason },
  { hook: "edit-check", exitCode: 2, stderr: "New comments are not allowed\nsecond line" },
  { hook: "browser-check", crashed: "ENOENT" },
]
  .map((entry) => JSON.stringify(entry))
  .join("\n");

test("summarizeHookLog counts decisions, blocks, crashes and hidden lines per hook", () => {
  const summary = summarizeHookLog(`${logText}\nnot json\n`);
  expect(summary).toContain("bash-trim: 2 decisions, 0 blocked, 0 crashed, 150 lines hidden");
  expect(summary).toContain("bash-guard: 2 decisions, 2 blocked, 0 crashed, 0 lines hidden");
  expect(summary).toContain("edit-check: 1 decisions, 1 blocked, 0 crashed, 0 lines hidden");
  expect(summary).toContain("browser-check: 1 decisions, 0 blocked, 1 crashed, 0 lines hidden");
});

test("summarizeHookLog lists the most frequent block reasons by their first line", () => {
  const summary = summarizeHookLog(logText);
  expect(summary).toContain(`2x ${gitLogReason}`);
  expect(summary).toContain("1x New comments are not allowed");
  expect(summary).not.toContain("second line");
});

test("summarizeHookLog says so when the log is empty", () => {
  expect(summarizeHookLog("")).toBe("no hook decisions logged");
});

async function printedStats(userHome: string): Promise<string> {
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => printed.push(line);
  try {
    expect(await stats(userHome, "/lite")).toBe(0);
  } finally {
    console.log = originalLog;
  }
  return printed.join("\n");
}

test("stats prints the summary of the user's hook log", async () => {
  const userHome = mkdtempSync(join(tmpdir(), "stats-"));
  mkdirSync(dirname(hookLogPath(userHome)), { recursive: true });
  writeFileSync(hookLogPath(userHome), logText);
  expect(await printedStats(userHome)).toContain("bash-guard: 2 decisions, 2 blocked");
  const emptyHome = mkdtempSync(join(tmpdir(), "stats-"));
  expect(await printedStats(emptyHome)).toBe("no hook decisions logged");
});
