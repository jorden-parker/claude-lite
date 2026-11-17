import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mlxUrl, servedModelId } from "../src/mlx.ts";

const config = join(import.meta.dir, "..", "config");
const setupScript = join(import.meta.dir, "..", "scripts", "t3-code-setup.sh");
const settingsSource = readFileSync(join(config, "t3-code-27b.json"), "utf8");

function runSetup(userHome: string) {
  const result = Bun.spawnSync([setupScript], { env: { ...process.env, HOME: userHome } });
  return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
}

test("the T3 Code setup script installs the settings and prints the launch arguments and model", () => {
  const userHome = mkdtempSync(join(tmpdir(), "claude-lite-t3-"));
  const { exitCode, output } = runSetup(userHome);
  expect(exitCode).toBe(0);
  expect(readFileSync(join(userHome, ".claude_local", "settings.json"), "utf8")).toBe(
    settingsSource,
  );
  expect(output).toContain(`--append-system-prompt-file ${join(config, "system-prompt.md")}`);
  expect(output).toContain(servedModelId(size.mlx));
  expect(runSetup(userHome).exitCode).toBe(0);
});

test("the T3 Code setup script leaves a different settings.json alone", () => {
  const userHome = mkdtempSync(join(tmpdir(), "claude-lite-t3-"));
  const existing = join(userHome, ".claude_local", "settings.json");
  mkdirSync(join(userHome, ".claude_local"));
  writeFileSync(existing, '{"model":"mine"}');
  const { exitCode, output } = runSetup(userHome);
  expect(exitCode).toBe(1);
  expect(output).toContain(existing);
  expect(readFileSync(existing, "utf8")).toBe('{"model":"mine"}');
});

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
