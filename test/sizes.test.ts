import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  defaultSize,
  fittingSizes,
  loadSizes,
  memoryBudgetGb,
  PREFERRED_SIZE,
  resolveSize,
} from "../src/ollama/sizes.ts";

const home = join(import.meta.dir, "..");
const GIB = 1024 ** 3;
const NO_WIRED_LIMIT = 0;
const sizes = loadSizes(home);
const sizesWithoutOverlay = await Bun.file(join(home, "config", "sizes.json")).json();

test("every configured size records the memory it needs", () => {
  for (const [name, size] of Object.entries(sizes)) {
    expect(size.memory_gb, name).toBeGreaterThan(0);
  }
});

test("the memory budget is 70 percent of RAM, like Ollama's Metal limit", () => {
  expect(memoryBudgetGb(16 * GIB, NO_WIRED_LIMIT)).toBeCloseTo(11.2, 1);
});

test("a raised GPU wired limit replaces the 70 percent budget", () => {
  const wiredLimitMb = 24 * 1024;
  expect(memoryBudgetGb(16 * GIB, wiredLimitMb)).toBe(24);
  expect(fittingSizes(sizesWithoutOverlay, 16 * GIB, wiredLimitMb)).toEqual(["27b", "35b", "9b"]);
  expect(defaultSize(sizesWithoutOverlay, 16 * GIB, wiredLimitMb)).toBe(PREFERRED_SIZE);
});

test("a wired limit of 0 keeps the 70 percent budget", () => {
  expect(memoryBudgetGb(16 * GIB, NO_WIRED_LIMIT)).toBeCloseTo(11.2, 1);
  expect(fittingSizes(sizesWithoutOverlay, 16 * GIB, NO_WIRED_LIMIT)).toEqual(["9b"]);
});

test("a size marked default wins over the memory-aware pick", () => {
  const marked = {
    ...sizesWithoutOverlay,
    "35b": { ...sizesWithoutOverlay["35b"], default: true },
  };
  expect(defaultSize(marked, 16 * GIB, NO_WIRED_LIMIT)).toBe("35b");
  expect(defaultSize(sizesWithoutOverlay, 16 * GIB, NO_WIRED_LIMIT)).toBe("9b");
});

test("fittingSizes keeps only the sizes within the budget", () => {
  expect(fittingSizes(sizesWithoutOverlay, 16 * GIB, NO_WIRED_LIMIT)).toEqual(["9b"]);
  expect(fittingSizes(sizesWithoutOverlay, 32 * GIB, NO_WIRED_LIMIT)).toEqual(["27b", "35b", "9b"]);
});

test("default size is 35b when it fits, else the largest that fits", () => {
  expect(defaultSize(sizesWithoutOverlay, 64 * GIB, NO_WIRED_LIMIT)).toBe(PREFERRED_SIZE);
  expect(defaultSize(sizesWithoutOverlay, 32 * GIB, NO_WIRED_LIMIT)).toBe("35b");
  expect(defaultSize(sizesWithoutOverlay, 16 * GIB, NO_WIRED_LIMIT)).toBe("9b");
  expect(defaultSize(sizesWithoutOverlay, 4 * GIB, NO_WIRED_LIMIT)).toBe(PREFERRED_SIZE);
});

test("sizes without memory_gb always fit", () => {
  const loose = { tiny: { ...sizes["9b"], memory_gb: undefined } };
  expect(fittingSizes(loose, 1 * GIB, NO_WIRED_LIMIT)).toEqual(["tiny"]);
  expect(defaultSize(loose, 1 * GIB, NO_WIRED_LIMIT)).toBe("tiny");
});

test("resolveSize takes a leading size name, else the memory default", () => {
  expect(resolveSize(home, ["35b", "-p", "hi"], {}, 64 * GIB, NO_WIRED_LIMIT)).toMatchObject({
    name: "35b",
    claudeArgs: ["-p", "hi"],
  });
  expect(resolveSize(home, ["-p", "hi"], {}, 16 * GIB, NO_WIRED_LIMIT)).toMatchObject({
    name: "9b",
    claudeArgs: ["-p", "hi"],
  });
});

test("resolveSize layers env and flags over the size", () => {
  const { size } = resolveSize(
    home,
    ["9b", "--effort", "low"],
    { CLAUDE_LITE_THINKING: "on" },
    16 * GIB,
    NO_WIRED_LIMIT,
  );
  expect(size.thinking).toBe(true);
  expect(size.effort).toBe("low");
});

test("resolveSize ignores local memory when OLLAMA_HOST names another machine", () => {
  const remote = { OLLAMA_HOST: "studio.local" };
  expect(resolveSize(home, [], remote, 16 * GIB, NO_WIRED_LIMIT).name).toBe(PREFERRED_SIZE);
  expect(resolveSize(home, [], { OLLAMA_HOST: "localhost" }, 16 * GIB, NO_WIRED_LIMIT).name).toBe(
    "9b",
  );
});

test("resolveSize ignores the local wired limit when OLLAMA_HOST names another machine", () => {
  const remote = { OLLAMA_HOST: "studio.local" };
  const localWiredLimitMb = 12 * 1024;
  expect(resolveSize(home, [], remote, 16 * GIB, localWiredLimitMb).name).toBe(PREFERRED_SIZE);
});

test("pickSize stays internal to the sizes module", async () => {
  expect(Object.keys(await import("../src/ollama/sizes.ts"))).not.toContain("pickSize");
});

test("every size gives Claude Code a 128k window so compaction starts near 110k tokens", () => {
  for (const [name, size] of Object.entries(sizesWithoutOverlay)) {
    expect((size as { context: number }).context, name).toBe(131072);
  }
});
