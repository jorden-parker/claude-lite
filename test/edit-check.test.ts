import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newComments } from "../src/hooks/comments.ts";
import { decide } from "../src/hooks/edit-check.ts";

const dir = mkdtempSync(join(tmpdir(), "ec-"));
const file = join(dir, "a.py");
writeFileSync(file, "x = 1\n");
const edit = (new_string: string) => ({
  tool_name: "Edit",
  cwd: dir,
  tool_input: { file_path: file, old_string: "x = 1", new_string },
});

test("rejects a new comment", () => {
  const result = decide(
    edit("x = 1  # why"),
    () => null,
    () => false,
  );
  expect(result?.exitCode).toBe(2);
  expect(result?.stderr).toContain("# why");
});

test("allows a clean edit", () =>
  expect(
    decide(
      edit("x = 2"),
      () => null,
      () => false,
    ),
  ).toBeNull());

test("reports a failing linter", () => {
  const result = decide(
    edit("x = 2"),
    () => ({ ok: false, output: "E999 bad" }),
    () => true,
  );
  expect(result?.stderr).toContain("ruff failed");
});

test("ignores comment markers inside strings and directives", () => {
  expect(newComments("", 'url = "http://a" # x\n#!/bin/sh\n', "python")).toEqual(["# x"]);
  expect(newComments("", "//go:build linux\n", "go")).toEqual([]);
});

test("keeps existing comments", () => expect(newComments("a // k", "a // k\nb", "js")).toEqual([]));

test("reports gofmt output even when gofmt exits cleanly", () => {
  const goFile = join(dir, "a.go");
  writeFileSync(goFile, "package a\n");
  const result = decide(
    {
      tool_name: "Edit",
      cwd: dir,
      tool_input: { file_path: goFile, old_string: "a", new_string: "b" },
    },
    () => ({ ok: true, output: "a.go\n" }),
    () => true,
  );
  expect(result?.exitCode).toBe(2);
  expect(result?.stderr).toContain("gofmt failed");
});
