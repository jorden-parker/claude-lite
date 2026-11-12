import type { Runner } from "./ollama/launch.ts";

const PROVIDER = "claude-lite";

export async function runOpenCode(
  { model, url, args }: { model: string; url: string; args: string[] },
  run: Runner,
): Promise<number> {
  console.error(
    "claude-lite: opencode runs without claude-lite's permissions, sandbox and secret denies; configure ~/.config/opencode/opencode.json",
  );
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER}/${model}`,
    providers: {
      [PROVIDER]: {
        name: PROVIDER,
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${url}/v1` },
        models: { [model]: {} },
      },
    },
  };
  return await run(["opencode", ...args], {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  });
}
