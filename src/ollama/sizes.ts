import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withJsonOverlay } from "../json-overlay.ts";

export type Size = {
  base: string;
  model: string;
  context: number;
  output_tokens: number;
  parameters: Record<string, number>;
  thinking: boolean;
  effort?: string;
};

export const DEFAULT_SIZE = "27b";

export function loadSizes(home: string): Record<string, Size> {
  const sizes = JSON.parse(readFileSync(join(home, "config", "sizes.json"), "utf8"));
  return withJsonOverlay(sizes, join(home, "config", "local-sizes.json")) as Record<string, Size>;
}

export function pickSize(sizes: Record<string, Size>, name: string): Size {
  const size = sizes[name];
  if (!size)
    throw new Error(`unknown size ${name}; choose one of ${Object.keys(sizes).join(", ")}`);
  return size;
}
