import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_READER, IMAGE_READER_HANDOFF } from "../src/image-reader.ts";
import { ollamaBaseSettings, runClaude, type Runner } from "../src/ollama/launch.ts";
import { runQwen } from "../src/qwen.ts";

const home = join(import.meta.dir, "..");
const VISION_MODEL = "qwen3.5-9b-mtp-cc";
const valueAfter = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

async function claudeLaunch(visionModel?: string) {
  const dir = mkdtempSync(join(tmpdir(), "claude-lite-image-reader-"));
  let argv: string[] = [];
  let settings: any = {};
  const run: Runner = async (launched) => {
    argv = launched;
    settings = JSON.parse(readFileSync(valueAfter(launched, "--settings"), "utf8"));
    return 0;
  };
  const baseSettings = { ...ollamaBaseSettings(home), availableModels: ["flint"] };
  await runClaude(
    {
      dir,
      home,
      model: "flint",
      settings: baseSettings,
      claudeArgs: [],
      url: "http://x",
      visionModel,
    },
    run,
  );
  return { argv, settings };
}

test("claude gets an image-reader subagent on the vision model and may spawn it", async () => {
  const { argv, settings } = await claudeLaunch(VISION_MODEL);
  const agent = JSON.parse(valueAfter(argv, "--agents"))[IMAGE_READER];
  expect(agent.model).toBe(VISION_MODEL);
  expect(agent.tools).toEqual(["Read"]);
  expect(valueAfter(argv, "--tools").split(",")).toContain("Agent");
  expect(valueAfter(argv, "--tools").split(",")).toContain("AskUserQuestion");
  expect(valueAfter(argv, "--append-system-prompt")).toBe(IMAGE_READER_HANDOFF);
  expect(settings.availableModels).toEqual(["flint", VISION_MODEL]);
  expect(settings.permissions.deny).not.toContain("Agent");
});

test("claude without a vision model keeps Agent denied and defines no subagent", async () => {
  const { argv, settings } = await claudeLaunch();
  expect(argv).not.toContain("--agents");
  expect(argv).not.toContain("--append-system-prompt");
  expect(valueAfter(argv, "--tools").split(",")).not.toContain("Agent");
  expect(valueAfter(argv, "--tools").split(",")).toContain("AskUserQuestion");
  expect(settings.availableModels).toEqual(["flint"]);
  expect(settings.permissions.deny).toContain("Agent");
});

async function qwenLaunch(agentsDir: string, visionModel?: string) {
  let argv: string[] = [];
  let agentFileDuringRun = null as string | null;
  const agentPath = join(agentsDir, `${IMAGE_READER}.md`);
  const run: Runner = async (launched) => {
    argv = launched;
    agentFileDuringRun = existsSync(agentPath) ? readFileSync(agentPath, "utf8") : null;
    return 0;
  };
  await runQwen({ model: "flint", url: "http://x", args: [], visionModel }, run, agentsDir);
  return { argv, agentFileDuringRun, agentPath };
}

test("qwen gets an image-reader subagent file on the vision model for the session only", async () => {
  const agentsDir = join(mkdtempSync(join(tmpdir(), "claude-lite-qwen-agents-")), "agents");
  const { argv, agentFileDuringRun, agentPath } = await qwenLaunch(agentsDir, VISION_MODEL);
  expect(agentFileDuringRun).toContain(`name: ${IMAGE_READER}`);
  expect(agentFileDuringRun).toContain(`model: ${VISION_MODEL}`);
  expect(valueAfter(argv, "--append-system-prompt")).toBe(IMAGE_READER_HANDOFF);
  expect(existsSync(agentPath)).toBe(false);
});

test("qwen without a vision model writes no subagent file", async () => {
  const agentsDir = join(mkdtempSync(join(tmpdir(), "claude-lite-qwen-agents-")), "agents");
  const { argv, agentFileDuringRun } = await qwenLaunch(agentsDir);
  expect(agentFileDuringRun).toBeNull();
  expect(argv).toEqual(["qwen", "--model", "flint"]);
});

test("qwen leaves an image-reader file the user wrote untouched", async () => {
  const agentsDir = mkdtempSync(join(tmpdir(), "claude-lite-qwen-agents-"));
  const agentPath = join(agentsDir, `${IMAGE_READER}.md`);
  writeFileSync(agentPath, "my own agent");
  const { argv } = await qwenLaunch(agentsDir, VISION_MODEL);
  expect(readFileSync(agentPath, "utf8")).toBe("my own agent");
  expect(argv).not.toContain("--append-system-prompt");
});
