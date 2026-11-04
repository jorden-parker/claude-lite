import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Size = {
  base: string;
  model: string;
  context: number;
  output_tokens: number;
  parameters: Record<string, number>;
};

export const DEFAULT_SIZE = "27b";

export function loadSizes(home: string): Record<string, Size> {
  return JSON.parse(readFileSync(join(home, "config", "sizes.json"), "utf8"));
}

export function pickSize(sizes: Record<string, Size>, name: string): Size {
  const size = sizes[name];
  if (!size)
    throw new Error(`unknown size ${name}; choose one of ${Object.keys(sizes).join(", ")}`);
  return size;
}
