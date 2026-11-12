import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { liteHome } from "../src/home.ts";
import { runOpenCode } from "../src/opencode.ts";

const BROWSER_INSTRUCTIONS = join(liteHome(), "config", "opencode-instructions.md");

const OPTIONS = {
  model: "qwen3.8-27b-dflash-cc",
  url: "http://127.0.0.1:11434",
  args: ["run", "hi"],
};

const fakeOpenCode = (reportedVersion: string | null) => {
  const calls: string[][] = [];
  const envs: Record<string, string | undefined>[] = [];
  const run = async (argv: string[], env?: Record<string, string | undefined>) => {
    calls.push(argv);
    envs.push(env ?? {});
    if (argv[0] !== "sh") return 0;
    if (reportedVersion === null) return 127;
    writeFileSync(argv[4], `${reportedVersion}\n`);
    return 0;
  };
  return { calls, envs, run };
};

test("opencode gets an inline provider for the served model", async () => {
  const { envs, run } = fakeOpenCode("2.1.2");
  expect(await runOpenCode(OPTIONS, run)).toBe(0);
  expect(JSON.parse(envs.at(-1)?.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({
    $schema: "https://opencode.ai/config.json",
    model: "claude-lite/qwen3.8-27b-dflash-cc",
    instructions: [BROWSER_INSTRUCTIONS],
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

test("the served model is passed with --model so no opencode config or last-used model wins", async () => {
  const { calls, run } = fakeOpenCode("2.1.2");
  expect(await runOpenCode(OPTIONS, run)).toBe(0);
  expect(calls.at(-1)).toEqual([
    "opencode",
    "run",
    "hi",
    "--model",
    "claude-lite/qwen3.8-27b-dflash-cc",
  ]);
});

test("a --model or -m the user passes is left alone", async () => {
  for (const flag of ["--model", "-m"]) {
    const { calls, run } = fakeOpenCode("2.1.2");
    const args = ["run", flag, "other/model", "hi"];
    expect(await runOpenCode({ ...OPTIONS, args }, run)).toBe(0);
    expect(calls.at(-1)).toEqual(["opencode", ...args]);
  }
});

test("opencode is told to browse with agent-browser", () => {
  const instructions = readFileSync(BROWSER_INSTRUCTIONS, "utf8");
  for (const command of [
    "agent-browser open",
    "agent-browser console",
    "agent-browser errors",
    "agent-browser screenshot",
  ])
    expect(instructions).toContain(command);
});

test("opencode 1.x is refused because it ignores the providers config", async () => {
  const { calls, run } = fakeOpenCode("1.18.35");
  expect(await runOpenCode(OPTIONS, run)).toBe(1);
  expect(calls.some((argv) => argv[0] === "opencode")).toBe(false);
});

test("a missing opencode is refused", async () => {
  const { calls, run } = fakeOpenCode(null);
  expect(await runOpenCode(OPTIONS, run)).toBe(1);
  expect(calls.some((argv) => argv[0] === "opencode")).toBe(false);
});
