import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../src/hooks/read-guard.ts";

const dir = mkdtempSync(join(tmpdir(), "rg-"));
const big = join(dir, "big.txt");
const small = join(dir, "small.txt");
writeFileSync(big, "x\n".repeat(301));
writeFileSync(small, "x\n".repeat(300));

test("denies a big file without limit", () =>
  expect(decide({ tool_input: { file_path: big } })).not.toBeNull());
test("allows a big file with limit 300", () =>
  expect(decide({ tool_input: { file_path: big, limit: 300 } })).toBeNull());
test("denies limit 301", () =>
  expect(decide({ tool_input: { file_path: big, limit: 301 } })).not.toBeNull());
test("allows a 300-line file", () =>
  expect(decide({ tool_input: { file_path: small } })).toBeNull());
test("allows a missing file", () =>
  expect(decide({ tool_input: { file_path: join(dir, "no") } })).toBeNull());
