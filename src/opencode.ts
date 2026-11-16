import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liteHome } from "./home.ts";
import type { Runner } from "./ollama/launch.ts";

const PROVIDER = "claude-lite";
const MINIMUM_OPENCODE_MAJOR = 2;
const IMAGE_READER = "image-reader";

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
  {
    model,
    url,
    args,
    visionModel,
  }: { model: string; url: string; args: string[]; visionModel?: string },
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
    instructions: [join(liteHome(), "config", "opencode-instructions.md")],
    plugins: [join(liteHome(), "src", "opencode-plugin.ts")],
    providers: {
      [PROVIDER]: {
        name: PROVIDER,
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${url}/v1` },
        models: visionModel
          ? {
              [model]: { capabilities: { tools: true, input: ["text"], output: ["text"] } },
              [visionModel]: {
                capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
              },
            }
          : { [model]: {} },
      },
    },
    ...(visionModel && {
      agents: {
        [IMAGE_READER]: {
          description:
            "Reads an image file (screenshot, mock-up, diagram, photo) and describes it. You cannot read images yourself: give this agent the file path and what you need to know about the image.",
          mode: "subagent",
          model: `${PROVIDER}/${visionModel}`,
          system:
            "Read the image file you are given and answer the question about it. Describe layout, text, colors and visible defects precisely. Do not edit files.",
        },
      },
    }),
  };
  const hasOwnServer = args.some((arg) => arg === "--server" || arg === "--standalone");
  const serverArgs = hasOwnServer ? [] : ["--standalone"];
  return await run(["opencode", ...serverArgs, ...args], {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  });
}
