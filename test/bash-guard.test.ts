import { expect, test } from "bun:test";
import { decide } from "../src/hooks/bash-guard.ts";

const denied = (command: string) => decide({ tool_input: { command } }) !== null;

test.each([
  "git log",
  "git -C /x log --stat",
  "git diff",
  "git diff HEAD~3",
  "find . -name '*.ts'",
  "cat package-lock.json",
  "ls && cat go.sum",
])("denies %s", (command) => expect(denied(command)).toBe(true));

test.each([
  "git log --oneline -n 20",
  "git log -5",
  "git log | head -20",
  "git diff --stat",
  "git diff | head -50",
  "find . -maxdepth 2 -name x",
  "find . -name x | wc -l",
  "cat package-lock.json | grep left-pad",
  "echo 'git log'",
  "git status",
  "cat src/a.ts",
])("allows %s", (command) => expect(denied(command)).toBe(false));
