import { expect, test } from "bun:test";
import { applyEnv, applyFlags } from "../src/ollama/size-overrides.ts";
import type { Size } from "../src/ollama/sizes.ts";

const size: Size = {
  base: "b",
  model: "m",
  context: 100,
  output_tokens: 10,
  parameters: {},
  thinking: false,
};

test("CLAUDE_LITE_THINKING on and off set thinking", () => {
  expect(applyEnv(size, { CLAUDE_LITE_THINKING: "on" }).thinking).toBe(true);
  expect(applyEnv({ ...size, thinking: true }, { CLAUDE_LITE_THINKING: "off" }).thinking).toBe(
    false,
  );
});

test("unset or unknown CLAUDE_LITE_THINKING leaves thinking alone", () => {
  expect(applyEnv(size, {})).toEqual(size);
  expect(applyEnv({ ...size, thinking: true }, { CLAUDE_LITE_THINKING: "yes" }).thinking).toBe(
    true,
  );
});

test("CLAUDE_LITE_EFFORT sets effort", () => {
  expect(applyEnv(size, { CLAUDE_LITE_EFFORT: "low" }).effort).toBe("low");
});

test("retired CLAUDE_LITE_NO_PERMISSIONS and CLAUDE_LITE_NO_SANDBOX are ignored", () => {
  const env = { CLAUDE_LITE_NO_PERMISSIONS: "ollama", CLAUDE_LITE_NO_SANDBOX: "ollama" };
  expect(applyEnv(size, env)).toEqual(size);
});

test.each([
  ["--think", "thinking", true],
  ["--no-think", "thinking", false],
] as const)("%s sets %s to %p and is not passed to claude", (flag, field, value) => {
  const start = { ...size, [field]: !value };
  const result = applyFlags(start, ["-p", flag, "hi"]);
  expect(result.size[field]).toBe(value);
  expect(result.claudeArgs).toEqual(["-p", "hi"]);
});

test("retired sandbox and permission flags are passed to claude", () => {
  const retired = ["--permissions", "--no-permissions", "--sandbox", "--no-sandbox"];
  expect(applyFlags(size, retired)).toEqual({ size, claudeArgs: retired });
});

test("the last flag for a setting wins", () => {
  expect(applyFlags(size, ["--no-think", "--think"]).size.thinking).toBe(true);
  expect(applyFlags(size, ["--think", "--no-think"]).size.thinking).toBe(false);
});

test.each([[["--effort", "low"]], [["--effort=low"]]])(
  "%j sets effort and is not passed to claude",
  (effortArgs) => {
    const result = applyFlags(size, ["-p", ...effortArgs, "hi"]);
    expect(result.size.effort).toBe("low");
    expect(result.claudeArgs).toEqual(["-p", "hi"]);
  },
);

test("--qwen sets qwen and is not passed to claude", () => {
  const result = applyFlags(size, ["-p", "--qwen", "hi"]);
  expect(result.size.qwen).toBe(true);
  expect(result.claudeArgs).toEqual(["-p", "hi"]);
});

test("--effort beats CLAUDE_LITE_EFFORT", () => {
  const fromEnv = applyEnv(size, { CLAUDE_LITE_EFFORT: "xhigh" });
  expect(applyFlags(fromEnv, ["--effort", "low"]).size.effort).toBe("low");
});
