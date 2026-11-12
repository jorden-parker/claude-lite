import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, ollamaStartupSources, servers, uninstall } from "../src/install.ts";
import type { Runner } from "../src/ollama/launch.ts";

const agentPath = (userHome: string) =>
  join(userHome, "Library/LaunchAgents/com.claude-lite.server-env.plist");
const roots = () => ({
  userHome: mkdtempSync(join(tmpdir(), "env-user-")),
  systemRoot: mkdtempSync(join(tmpdir(), "env-sys-")),
});
const succeed: Runner = async () => 0;

test("servers writes a login agent that sets the server env again", async () => {
  const { userHome, systemRoot } = roots();
  await servers(userHome, "/lite", succeed, systemRoot);
  const agent = readFileSync(agentPath(userHome), "utf8");
  expect(agent).toContain("<key>RunAtLoad</key><true/>");
  expect(agent).toContain("launchctl setenv OLLAMA_KEEP_ALIVE -1");
  expect(agent).toContain("launchctl setenv OLLAMA_MAX_LOADED_MODELS 1");
  expect(ollamaStartupSources(userHome, systemRoot)).toEqual([]);
});

test("uninstall removes the login agent", async () => {
  const { userHome, systemRoot } = roots();
  await servers(userHome, "/lite", succeed, systemRoot);
  expect(existsSync(agentPath(userHome))).toBe(true);
  await uninstall(userHome, "/lite");
  expect(existsSync(agentPath(userHome))).toBe(false);
});

test("doctor checks that launchctl still holds the server env", async () => {
  const { userHome, systemRoot } = roots();
  const scripts: string[] = [];
  const failEnvCheck: Runner = async (argv) => {
    if (argv[0] !== "sh") return 0;
    scripts.push(argv[2]);
    return argv[2].includes("launchctl getenv") ? 1 : 0;
  };
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => printed.push(line);
  try {
    await doctor(userHome, join(import.meta.dir, ".."), failEnvCheck, systemRoot);
  } finally {
    console.log = originalLog;
  }
  expect(scripts.join("\n")).toContain('test "$(launchctl getenv OLLAMA_KEEP_ALIVE)" = "-1"');
  expect(printed).toContain("FAIL ollama server env set");
});
