import { expect, test } from "bun:test";
import { hasParameters, modelParameters } from "../src/ollama/modelfile.ts";
import type { Size } from "../src/ollama/sizes.ts";

const size: Size = {
  base: "b",
  model: "m",
  context: 100,
  output_tokens: 10,
  parameters: { temperature: 0.7, top_k: 20 },
  thinking: false,
};

test("modelParameters adds context and output tokens to the size parameters", () => {
  expect(modelParameters(size)).toEqual({
    num_ctx: 100,
    num_predict: 10,
    temperature: 0.7,
    top_k: 20,
  });
});

test("hasParameters accepts extra reported parameters and float rounding", () => {
  const reported = { num_ctx: 100, num_predict: 10, temperature: 0.7000000001, top_k: 20, seed: 1 };
  expect(hasParameters(reported, size)).toBe(true);
});

test("hasParameters rejects a changed or missing parameter", () => {
  const changed = { num_ctx: 200, num_predict: 10, temperature: 0.7, top_k: 20 };
  expect(hasParameters(changed, size)).toBe(false);
  expect(hasParameters({ num_ctx: 100, num_predict: 10, top_k: 20 }, size)).toBe(false);
});
