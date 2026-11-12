import { expect, test } from "bun:test";
import { unboundedGitLogReason } from "../src/ollama/git-log-guard.ts";

test.each(["git log", "git log --stat", "git --no-pager log --oneline", "npm test && git log"])(
  "denies unbounded git log: %s",
  (command) => {
    expect(unboundedGitLogReason(command)).toBe("Unbounded git log. Use: git log --oneline -n 20");
  },
);

test.each([
  "git log --oneline -n 20",
  "git log -5",
  "git log --max-count=3",
  "git log --oneline | head -20",
  "echo git log",
  "git status",
])("allows bounded or unrelated command: %s", (command) => {
  expect(unboundedGitLogReason(command)).toBeNull();
});
