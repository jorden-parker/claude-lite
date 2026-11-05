import { expect, test } from "bun:test";
import { optsOut, withOptOutsFor } from "../src/permissions-opt-out.ts";

const settings = { permissions: { deny: ["x"] }, sandbox: { enabled: true }, hooks: {}, env: {} };

test("unset leaves settings untouched", () => {
  expect(withOptOutsFor("anthropic", settings, {})).toBe(settings);
});

test("CLAUDE_LITE_NO_PERMISSIONS drops only permissions for its target", () => {
  const env = { CLAUDE_LITE_NO_PERMISSIONS: "anthropic" };
  expect(withOptOutsFor("anthropic", settings, env)).toEqual({
    sandbox: { enabled: true },
    hooks: {},
    env: {},
  });
  expect(withOptOutsFor("ollama", settings, env)).toBe(settings);
});

test("CLAUDE_LITE_NO_SANDBOX drops only sandbox for its target", () => {
  const env = { CLAUDE_LITE_NO_SANDBOX: "ollama" };
  expect(withOptOutsFor("ollama", settings, env)).toEqual({
    permissions: { deny: ["x"] },
    hooks: {},
    env: {},
  });
  expect(withOptOutsFor("anthropic", settings, env)).toBe(settings);
});

test("both variables with comma lists drop both blocks on both targets", () => {
  const env = {
    CLAUDE_LITE_NO_PERMISSIONS: "anthropic, ollama",
    CLAUDE_LITE_NO_SANDBOX: "ollama,anthropic",
  };
  expect(withOptOutsFor("ollama", settings, env)).toEqual({ hooks: {}, env: {} });
  expect(withOptOutsFor("anthropic", settings, env)).toEqual({ hooks: {}, env: {} });
});

test("optsOut reads the comma list for its key", () => {
  const env = { CLAUDE_LITE_NO_SANDBOX: "anthropic, ollama" };
  expect(optsOut("sandbox", "ollama", env)).toBe(true);
  expect(optsOut("permissions", "ollama", env)).toBe(false);
});
