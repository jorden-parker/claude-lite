import { expect, test } from "bun:test";
import { decide, emptyState } from "../src/hooks/tdd-guard.ts";

const pre = (file: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  cwd: "/p",
  tool_input: { file_path: file },
});
const post = (file: string) => ({ ...pre(file), hook_event_name: "PostToolUse" });
const bash = (command: string) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  cwd: "/p",
  tool_input: { command },
});
const isDeny = (r: any) => r?.output?.hookSpecificOutput?.permissionDecision === "deny";

test("denies code before a test", () => expect(isDeny(decide(pre("/p/a.go"), emptyState()))).toBe(true));

test("allows tests, configs and non-code", () => {
  const state = emptyState();
  for (const f of [
    "/p/a_test.go",
    "/p/a.test.ts",
    "/p/vitest.config.ts",
    "/p/README.md",
    "/p/test/helper.ts",
  ]) {
    expect(decide(pre(f), state)).toBeNull();
  }
});

test("needs a test edit then a test run", () => {
  const state = emptyState();
  decide(post("/p/a_test.go"), state);
  expect(isDeny(decide(pre("/p/a.go"), state))).toBe(true);
  decide(bash("cd /p && go test ./..."), state);
  expect(decide(pre("/p/a.go"), state)).toBeNull();
});

test("editing the test again relocks", () => {
  const state = emptyState();
  decide(post("/p/a_test.go"), state);
  decide(bash("go test ./..."), state);
  decide(post("/p/a_test.go"), state);
  expect(isDeny(decide(pre("/p/a.go"), state))).toBe(true);
});

test("other directory stays locked", () => {
  const state = emptyState();
  decide(post("/p/a_test.go"), state);
  decide(bash("bun test"), state);
  expect(isDeny(decide(pre("/q/b.go"), state))).toBe(true);
});

test("third strike passes", () => {
  const state = emptyState();
  expect(isDeny(decide(pre("/p/a.go"), state))).toBe(true);
  expect(isDeny(decide(pre("/p/a.go"), state))).toBe(true);
  const third: any = decide(pre("/p/a.go"), state);
  expect(isDeny(third)).toBe(false);
  expect(third.output.hookSpecificOutput.additionalContext).toContain("let a.go through");
});
