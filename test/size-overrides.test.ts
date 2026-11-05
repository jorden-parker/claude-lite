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
  permissions: true,
  sandbox: true,
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

test("CLAUDE_LITE_NO_PERMISSIONS and CLAUDE_LITE_NO_SANDBOX with ollama turn each off", () => {
  expect(applyEnv(size, { CLAUDE_LITE_NO_PERMISSIONS: "ollama" })).toEqual({
    ...size,
    permissions: false,
  });
  expect(applyEnv(size, { CLAUDE_LITE_NO_SANDBOX: "anthropic,ollama" })).toEqual({
    ...size,
    sandbox: false,
  });
  expect(applyEnv(size, { CLAUDE_LITE_NO_SANDBOX: "anthropic" })).toEqual(size);
});

test.each([
  ["--think", "thinking", true],
  ["--no-think", "thinking", false],
  ["--permissions", "permissions", true],
  ["--no-permissions", "permissions", false],
  ["--sandbox", "sandbox", true],
  ["--no-sandbox", "sandbox", false],
] as const)("%s sets %s to %p and is not passed to claude", (flag, field, value) => {
  const start = { ...size, [field]: !value };
  const result = applyFlags(start, ["-p", flag, "hi"]);
  expect(result.size[field]).toBe(value);
  expect(result.claudeArgs).toEqual(["-p", "hi"]);
});

test("the last flag for a setting wins", () => {
  expect(applyFlags(size, ["--no-sandbox", "--sandbox"]).size.sandbox).toBe(true);
  expect(applyFlags(size, ["--think", "--no-think"]).size.thinking).toBe(false);
});

test("a flag beats the env", () => {
  const fromEnv = applyEnv(size, { CLAUDE_LITE_NO_PERMISSIONS: "ollama" });
  expect(applyFlags(fromEnv, ["--permissions"]).size.permissions).toBe(true);
});

test.each([[["--effort", "low"]], [["--effort=low"]]])(
  "%j sets effort and is not passed to claude",
  (effortArgs) => {
    const result = applyFlags(size, ["-p", ...effortArgs, "hi"]);
    expect(result.size.effort).toBe("low");
    expect(result.claudeArgs).toEqual(["-p", "hi"]);
  },
);

test("--effort beats CLAUDE_LITE_EFFORT", () => {
  const fromEnv = applyEnv(size, { CLAUDE_LITE_EFFORT: "xhigh" });
  expect(applyFlags(fromEnv, ["--effort", "low"]).size.effort).toBe("low");
});
