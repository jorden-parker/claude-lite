import type { Runner } from "./ollama/launch.ts";

export async function runQwen(
  { model, url, args }: { model: string; url: string; args: string[] },
  run: Runner,
): Promise<number> {
  console.error(
    "claude-lite: qwen runs without claude-lite's permissions, sandbox and secret denies; configure ~/.qwen/settings.json",
  );
  const env = {
    ...process.env,
    OPENAI_BASE_URL: `${url}/v1`,
    OPENAI_API_KEY: "claude-lite",
    OPENAI_MODEL: model,
  };
  return await run(["qwen", "--model", model, ...args], env);
}
