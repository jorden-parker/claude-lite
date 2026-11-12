import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeSettings, withJsonOverlay } from "../src/json-overlay.ts";

const overlayFile = (contents?: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "overlay-")), "overlay.json");
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
};

test("a missing overlay leaves the base alone", () => {
  expect(withJsonOverlay({ a: 1 }, overlayFile())).toEqual({ a: 1 });
});

test("an overlay merges into the base", () => {
  expect(withJsonOverlay({ a: { b: 1, c: 2 } }, overlayFile('{"a":{"c":3}}'))).toEqual({
    a: { b: 1, c: 3 },
  });
});

test("an invalid overlay is ignored", () => {
  expect(withJsonOverlay({ a: 1 }, overlayFile("{nope"))).toEqual({ a: 1 });
});

test("nested objects merge and scalars are replaced", () => {
  expect(
    mergeSettings(
      { sandbox: { enabled: true, mode: "x" }, keep: 1 },
      { sandbox: { enabled: false } },
    ),
  ).toEqual({ sandbox: { enabled: false, mode: "x" }, keep: 1 });
});

test("arrays in the overlay replace the base array", () => {
  expect(
    mergeSettings({ permissions: { ask: ["a"], deny: ["d"] } }, { permissions: { ask: [] } }),
  ).toEqual({ permissions: { ask: [], deny: ["d"] } });
});
