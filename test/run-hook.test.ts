import { expect, test } from "bun:test";
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
