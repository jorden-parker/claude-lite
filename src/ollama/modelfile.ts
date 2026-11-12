import type { Size } from "./sizes.ts";

const PARAMETER_TOLERANCE = 1e-6;

export function modelParameters(size: Size): Record<string, number> {
  return { num_ctx: size.context, num_predict: size.output_tokens, ...size.parameters };
}

export function hasParameters(reported: Record<string, number>, size: Size): boolean {
  return Object.entries(modelParameters(size)).every(
    ([name, expected]) => Math.abs(reported[name] - expected) < PARAMETER_TOLERANCE,
  );
}

export function renderModelfile(size: Size): string {
  const lines = Object.entries(modelParameters(size)).map(
    ([name, expected]) => `PARAMETER ${name} ${expected}`,
  );
  return [`FROM ${size.base}`, ...lines].join("\n") + "\n";
}
