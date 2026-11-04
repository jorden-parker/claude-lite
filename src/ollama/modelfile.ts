import type { Size } from "./sizes.ts";

export function renderModelfile(size: Size): string {
  const parameters: Record<string, number> = {
    num_ctx: size.context,
    num_predict: size.output_tokens,
    ...size.parameters,
  };
  const lines = Object.entries(parameters).map(([key, value]) => `PARAMETER ${key} ${value}`);
  return [`FROM ${size.base}`, ...lines].join("\n") + "\n";
}
