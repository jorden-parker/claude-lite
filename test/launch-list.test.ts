import { expect, test } from "bun:test";
import { renderLaunchList } from "../src/launch-list.ts";
import type { Size } from "../src/ollama/sizes.ts";

const baseSize: Size = {
  base: "qwen:small",
  model: "qwen-small-cc",
  context: 1024,
  output_tokens: 512,
  parameters: {},
  thinking: false,
  memory_gb: 9,
};

const sizes: Record<string, Size> = {
  small: baseSize,
  big: {
    ...baseSize,
    base: "flint:big",
    model: "flint-big-cc",
    thinking: true,
    effort: "low",
    opencode: true,
    memory_gb: 27,
    mlx: "org/flint-mlx",
    mlx_draft: "org/flint-mtp",
    mlx_dflash: "org/flint-dflash",
    vision_size: "small",
  },
};

const machine = { defaultName: "small", fitting: ["small"], hasSplash: false };

test("lists each size with its start command per backend", () => {
  expect(renderLaunchList(sizes, machine)).toBe(
    [
      "small  qwen:small  9 GB  thinking off  default",
      "  cl ollama small  qwen-small-cc",
      "big  flint:big  27 GB  thinking on  effort low  client opencode  does not fit memory  images via small",
      "  cl ollama big  flint-big-cc",
      "  cl mlx big     org/flint-mlx  draft org/flint-mtp",
      "",
      "clients: claude, or add --qwen or --opencode to any command",
      "also: --think, --no-think, --effort <level>, --print-config",
    ].join("\n"),
  );
});

test("shows the DFlash draft when splash is installed", () => {
  expect(renderLaunchList(sizes, { ...machine, hasSplash: true })).toContain(
    "cl mlx big     org/flint-mlx  draft org/flint-dflash",
  );
});
