import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  IMAGE_READER,
  IMAGE_READER_DESCRIPTION,
  IMAGE_READER_HANDOFF,
  IMAGE_READER_PROMPT,
} from "./image-reader.ts";
import type { Runner } from "./ollama/launch.ts";

const MANAGED_MARKER = "# managed by claude-lite";

const imageReaderFile = (visionModel: string) =>
  [
    "---",
    MANAGED_MARKER,
    `name: ${IMAGE_READER}`,
    `description: ${JSON.stringify(IMAGE_READER_DESCRIPTION)}`,
    `model: ${visionModel}`,
    "tools:",
    "  - read_file",
    "---",
    "",
    IMAGE_READER_PROMPT,
    "",
  ].join("\n");

const isOwnedByUser = (agentPath: string) =>
  existsSync(agentPath) && !readFileSync(agentPath, "utf8").includes(MANAGED_MARKER);

export async function runQwen(
  {
    model,
    url,
    args,
    visionModel,
  }: { model: string; url: string; args: string[]; visionModel?: string },
  run: Runner,
  agentsDir = join(process.env.HOME ?? homedir(), ".qwen", "agents"),
): Promise<number> {
  console.error(
    "claude-lite: qwen runs without claude-lite's permissions, sandbox and secret denies; configure ~/.qwen/settings.json",
  );
  const env = {
    ...process.env,
    OPENAI_BASE_URL: `${url}/v1`,
    OPENAI_API_KEY: "claude-lite",
    OPENAI_MODEL: model,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--disable-warning=MaxListenersExceededWarning"]
      .filter(Boolean)
      .join(" "),
  };
  const agentPath = join(agentsDir, `${IMAGE_READER}.md`);
  if (!visionModel) return await run(["qwen", "--model", model, ...args], env);
  if (isOwnedByUser(agentPath)) {
    console.error(
      `claude-lite: ${agentPath} is your own agent, so qwen runs without claude-lite's ${IMAGE_READER} on ${visionModel}`,
    );
    return await run(["qwen", "--model", model, ...args], env);
  }
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(agentPath, imageReaderFile(visionModel));
  try {
    return await run(
      ["qwen", "--model", model, "--append-system-prompt", IMAGE_READER_HANDOFF, ...args],
      env,
    );
  } finally {
    rmSync(agentPath, { force: true });
  }
}
