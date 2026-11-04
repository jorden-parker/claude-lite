import { expect, test } from "bun:test";
import { decide } from "../src/hooks/bash-trim.ts";

const run = (stdout: string) =>
  decide({
    tool_name: "Bash",
    tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
  }) as any;

test("short output untouched", () => expect(run("a\nb")).toBeNull());

test("long output keeps head, tail, errors and Bash shape", () => {
  const lines = Array.from({ length: 400 }, (_, i) =>
    i === 200 ? "boom error here" : `line ${i}`,
  );
  const out = run(lines.join("\n")).output.hookSpecificOutput.updatedToolOutput;
  expect(Object.keys(out)).toEqual(["stdout", "stderr", "interrupted", "isImage"]);
  expect(out.stdout).toContain("line 0");
  expect(out.stdout).toContain("line 399");
  expect(out.stdout).toContain("boom error here");
  expect(out.stdout).toContain("bash-trim:");
  expect(out.stdout).not.toContain("line 100\n");
});

test("long lines are clipped", () => {
  const out = run("x".repeat(1000)).output.hookSpecificOutput.updatedToolOutput;
  expect(out.stdout).toContain("600 chars hidden");
});

test("trimText stays internal to the hook", async () => {
  expect(Object.keys(await import("../src/hooks/bash-trim.ts"))).not.toContain("trimText");
});
