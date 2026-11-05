import { expect, test } from "bun:test";
import { withoutPermissionsFor } from "../src/permissions-opt-out.ts";

const settings = { permissions: { deny: ["x"] }, sandbox: { enabled: true }, hooks: {}, env: {} };

test("unset leaves settings untouched", () => {
  expect(withoutPermissionsFor("anthropic", settings, {})).toBe(settings);
});

test("anthropic target drops the blocks for anthropic only", () => {
  const env = { CLAUDE_LITE_NO_PERMISSIONS: "anthropic" };
  expect(withoutPermissionsFor("anthropic", settings, env)).toEqual({ hooks: {}, env: {} });
  expect(withoutPermissionsFor("ollama", settings, env)).toBe(settings);
});

test("a comma list covers both targets", () => {
  const env = { CLAUDE_LITE_NO_PERMISSIONS: "anthropic,ollama" };
  expect(withoutPermissionsFor("ollama", settings, env)).toEqual({ hooks: {}, env: {} });
  expect(withoutPermissionsFor("anthropic", settings, env)).toEqual({ hooks: {}, env: {} });
});
