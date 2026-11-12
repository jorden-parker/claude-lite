import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./ollama/launch.ts";

const PROVIDER = "claude-lite";
const MINIMUM_OPENCODE_MAJOR = 2;

async function openCodeMajorVersion(run: Runner): Promise<number | null> {
  const dir = mkdtempSync(join(tmpdir(), "claude-lite-opencode-"));
  const versionPath = join(dir, "version.txt");
  try {
    const code = await run(["sh", "-c", 'opencode --version > "$1"', "sh", versionPath]);
    if (code !== 0) return null;
    const major = /(\d+)\.\d+/.exec(readFileSync(versionPath, "utf8"))?.[1];
    return major === undefined ? null : Number(major);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runOpenCode(
  { model, url, args }: { model: string; url: string; args: string[] },
  run: Runner,
): Promise<number> {
  const major = await openCodeMajorVersion(run);
  if (major === null || major < MINIMUM_OPENCODE_MAJOR) {
    console.error(
      `claude-lite: --opencode needs opencode ${MINIMUM_OPENCODE_MAJOR}.0 or newer (npm i -g opencode-ai); older versions ignore the claude-lite provider and fall back to a cloud model`,
    );
    return 1;
  }
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
