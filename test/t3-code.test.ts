import { expect, test } from "bun:test";
import { join } from "node:path";
import { mlxUrl, servedModelId } from "../src/mlx.ts";

const config = join(import.meta.dir, "..", "config");
const size = (await Bun.file(join(config, "sizes.json")).json())["27b"];
const { env } = await Bun.file(join(config, "t3-code-27b.json")).json();

test("the T3 Code settings point claude at the 27b model that cl serve serves", () => {
  const model = servedModelId(size.mlx);
  expect(env).toMatchObject({
    ANTHROPIC_BASE_URL: mlxUrl({}),
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(size.context),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(size.output_tokens),
  });
});
