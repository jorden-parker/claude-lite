import { expect, test } from "bun:test";
import { runOpenCode } from "../src/opencode.ts";

test("opencode gets an inline provider for the served model", async () => {
  let launched: string[] = [];
  let environment: Record<string, string | undefined> = {};
  await runOpenCode(
    { model: "qwen3.8-27b-dflash-cc", url: "http://127.0.0.1:11434", args: ["run", "hi"] },
    async (argv, env) => {
      launched = argv;
      environment = env ?? {};
      return 0;
    },
  );
  expect(launched).toEqual(["opencode", "run", "hi"]);
  expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({
    $schema: "https://opencode.ai/config.json",
    model: "claude-lite/qwen3.8-27b-dflash-cc",
    providers: {
      "claude-lite": {
        name: "claude-lite",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "http://127.0.0.1:11434/v1" },
        models: { "qwen3.8-27b-dflash-cc": {} },
      },
    },
  });
});
