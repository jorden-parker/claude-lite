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

test("personal settings trim idle and effort token spend", async () => {
  const personal = await Bun.file(
    join(import.meta.dir, "..", "config", "personal-settings.json"),
  ).json();
  expect(personal.effortLevel).toBe("medium");
  expect(personal.idleCompaction).toBe(false);
  expect(personal.env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY).toBe("0");
  expect(personal.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE).toBe("1");
});

test("CLAUDE_LITE_NO_PERMISSIONS=anthropic prints no permissions or sandbox", async () => {
  const previous = process.env.CLAUDE_LITE_NO_PERMISSIONS;
  process.env.CLAUDE_LITE_NO_PERMISSIONS = "anthropic";
  try {
    const output = await printedSettings(
      liteHomeWith({ permissions: { deny: ["x"] }, sandbox: { enabled: true }, keep: 1 }),
    );
    expect(output).toBe('{"keep":1}');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_LITE_NO_PERMISSIONS;
    else process.env.CLAUDE_LITE_NO_PERMISSIONS = previous;
  }
});
