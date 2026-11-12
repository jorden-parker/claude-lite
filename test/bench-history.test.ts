import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareBench, latestBench, saveBench } from "../src/ollama/bench-history.ts";

const record = (model: string, passes: boolean[], tokensPerSecond: number) => ({
  model,
  tasks: passes.map((isPass, i) => ({ name: `task-${i}`, failure: isPass ? null : "no" })),
  summary: {
    passed: passes.filter(Boolean).length,
    total: passes.length,
    generationTokensPerSecond: tokensPerSecond,
  },
});
const earlier = record("m-cc", [true, false], 20);
const later = record("m-cc", [true, true], 30);

test("saveBench writes one file per run and latestBench returns the newest for the model", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "bench-")), "history");
  saveBench(dir, earlier, new Date("2026-11-10T10:00:00.000Z"));
  saveBench(dir, later, new Date("2026-11-11T10:00:00.000Z"));
  saveBench(dir, later, new Date("2026-11-11T10:00:00.000Z"));
  saveBench(dir, record("other-cc", [], 0), new Date("2026-11-12T10:00:00.000Z"));
  expect(readdirSync(dir)).toHaveLength(4);
  expect(latestBench(dir, "m-cc")).toMatchObject({
    savedAt: "2026-11-11T10:00:00.000Z",
    tasks: later.tasks,
  });
  expect(latestBench(dir, "missing-cc")).toBeNull();
  expect(latestBench(join(dir, "absent"), "m-cc")).toBeNull();
});

test("compareBench prints quality, speed and the tasks whose pass count changed", () => {
  const saved = { ...earlier, savedAt: "2026-11-10T10:00:00.000Z" };
  expect(compareBench(saved, later)).toBe(
    [
      "compared with 2026-11-10T10:00:00.000Z",
      "quality 1/2 -> 2/2",
      "generation 20.0 -> 30.0 t/s",
      "task-1 0/1 -> 1/1",
    ].join("\n"),
  );
});
