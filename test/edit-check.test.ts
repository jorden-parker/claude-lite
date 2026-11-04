import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("denies a new comment before the edit lands", () => {
  const result = decide({ ...edit("x = 1  # why"), hook_event_name: "PreToolUse" });
  expect(JSON.stringify(result?.output)).toContain('"permissionDecision":"deny"');
  expect(JSON.stringify(result?.output)).toContain("# why");
});

test("denies a comment in a file that does not exist yet", () => {
  const result = decide({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    cwd: dir,
    tool_input: { file_path: join(dir, "new/b.ts"), content: "// hi\nexport const b = 1;\n" },
  });
  expect(JSON.stringify(result?.output)).toContain("// hi");
});

test("lets a clean edit through before it lands without running linters", () =>
  expect(
    decide(
      { ...edit("x = 2"), hook_event_name: "PreToolUse" },
      () => ({ ok: false, output: "E999 bad" }),
      () => true,
    ),
  ).toBeNull());

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

function jsProject(packageJson: object) {
  const root = mkdtempSync(join(tmpdir(), "ec-js-"));
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".bin", "prettier"), "");
  writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));
  const source = join(root, "a.ts");
  writeFileSync(source, "const x = 1;\n");
  return { root, source };
}
const jsEdit = (root: string, source: string) => ({
  tool_name: "Edit",
  cwd: root,
  tool_input: { file_path: source, old_string: "x = 1", new_string: "x = 2" },
});
const failing = () => ({ ok: false, output: "bad" });

test("skips a linter the project does not depend on", () => {
  const { root, source } = jsProject({ devDependencies: { eslint: "1" } });
  expect(decide(jsEdit(root, source), failing, () => false)).toBeNull();
});

test("runs a linter the project lists", () => {
  const { root, source } = jsProject({ devDependencies: { prettier: "1" } });
  expect(decide(jsEdit(root, source), failing, () => false)?.exitCode).toBe(2);
});
