import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deny } from "../src/hooks/types.ts";
import { hookLogPath, logLine } from "../src/hooks/run-hook.ts";

const now = new Date("2026-01-02T03:04:05.000Z");

test("logLine is null when the hook produced no result", () => {
  expect(logLine("bash-guard", {}, null, now)).toBeNull();
});

test("logLine records a deny result as one JSON line", () => {
  const event = { hook_event_name: "PreToolUse", tool_name: "Bash" };
  const line = logLine("bash-guard", event, deny("no"), now) as string;
  expect(line).not.toContain("\n");
  const parsed = JSON.parse(line);
  expect(parsed).toMatchObject({
    time: "2026-01-02T03:04:05.000Z",
    hook: "bash-guard",
    event: "PreToolUse",
    tool: "Bash",
  });
  expect(parsed).toMatchObject({ decision: "deny", reason: "no" });
});

test("logLine leaves out bash-trim's trimmed output", () => {
  const result = {
    output: {
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "secret stdout" },
    },
  };
  const line = logLine("bash-trim", { tool_name: "Bash" }, result, now) as string;
  expect(line).not.toContain("secret stdout");
  expect(line.length).toBeLessThan(200);
});

test("logLine keeps exit code and stderr", () => {
  const parsed = JSON.parse(
    logLine("edit-check", {}, { exitCode: 2, stderr: "bad" }, now) as string,
  );
  expect(parsed).toMatchObject({ exitCode: 2, stderr: "bad" });
});

test("hookLogPath lives under the claude-lite cache", () => {
  expect(hookLogPath("/u")).toBe("/u/.cache/claude-lite/hooks.log");
});

test("a crashing hook exits 0 and logs the crash", () => {
  const userHome = mkdtempSync(join(tmpdir(), "crash-"));
  const event = { hook_event_name: "Stop", transcript_path: join(userHome, "missing.jsonl") };
  const result = Bun.spawnSync(["bun", "src/cli.ts", "hook", "browser-check"], {
    stdin: Buffer.from(JSON.stringify(event)),
    env: { ...process.env, HOME: userHome },
  });
  expect(result.exitCode).toBe(0);
  const logged = JSON.parse(readFileSync(hookLogPath(userHome), "utf8").trim());
  expect(logged).toMatchObject({ hook: "browser-check", event: "Stop" });
  expect(logged.crashed).toContain("missing.jsonl");
});

test("logLine records the session and the lines bash-trim hid", () => {
  const event = { tool_name: "Bash", session_id: "session-1" };
  const parsed = JSON.parse(logLine("bash-trim", event, { hiddenLines: 42 }, now) as string);
  expect(parsed).toMatchObject({ session: "session-1", hiddenLines: 42 });
});
