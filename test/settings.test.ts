import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeSettings, settings } from "../src/install.ts";

function liteHomeWith(base: object, overlay?: string) {
  const home = mkdtempSync(join(tmpdir(), "settings-"));
  mkdirSync(join(home, "config"));
  writeFileSync(join(home, "config", "personal-settings.json"), JSON.stringify(base));
  if (overlay !== undefined) writeFileSync(join(home, "config", "local-settings.json"), overlay);
  return home;
}

async function printedSettings(home: string) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    expect(await settings("/unused", home)).toBe(0);
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("nested objects merge and scalars are replaced", () => {
  const merged = mergeSettings(
    { sandbox: { enabled: true, mode: "x" }, keep: 1 },
    { sandbox: { enabled: false } },
  );
  expect(merged).toEqual({ sandbox: { enabled: false, mode: "x" }, keep: 1 });
});

test("arrays in the overlay replace the base array", () => {
  const merged = mergeSettings(
    { permissions: { ask: ["a"], deny: ["d"] } },
    { permissions: { ask: [] } },
  );
  expect(merged).toEqual({ permissions: { ask: [], deny: ["d"] } });
});

test("no overlay prints the base settings as one line", async () => {
  const output = await printedSettings(liteHomeWith({ a: { b: 1 } }));
  expect(output).toBe('{"a":{"b":1}}');
});

test("invalid overlay falls back to the base settings", async () => {
  const output = await printedSettings(liteHomeWith({ a: 1 }, "{not json"));
  expect(output).toBe('{"a":1}');
});
