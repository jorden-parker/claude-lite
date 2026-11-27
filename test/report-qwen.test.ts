import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { qwenSessions } from "../src/report-qwen.ts";

const homes: string[] = [];
async function home() {
  const dir = await mkdtemp(join(tmpdir(), "qwen-history-"));
  homes.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of homes.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function file(dir: string, path: string, contents: string) {
  const target = join(dir, ".qwen", path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}
const models = new Set(["local"]);
const timestamp = (n: number) => new Date(1700000000000 + n * 1000).toISOString();
const entry = (type: string, t: number, extra: object) => ({
  type,
  timestamp: timestamp(t),
  cwd: "/private/place/demo",
  ...extra,
});
const call = (name: string, id: string) => ({
  functionCall: { name, id, args: { prompt: "secret input" } },
});
const assistant = (t: number, model: string | undefined, ...parts: object[]) =>
  entry("assistant", t, { model, message: { parts } });
const result = (t: number, id: string, status: string) =>
  entry("tool_result", t, {
    message: { parts: [{ functionResponse: { id, response: { output: "secret output" } } }] },
    toolCallResult: { callId: id, status },
  });
const lines = (...rows: object[]) => rows.map((row) => JSON.stringify(row)).join("\n");

test("reads across projects, correlates arbitrary tool names and keeps only local activity", async () => {
  const dir = await home();
  await file(
    dir,
    "projects/a/chats/main.jsonl",
    lines(
      assistant(0, "remote", call("cloud", "r")),
      assistant(1, "local", call("mcp__custom", "c"), call("edit", "e")),
      result(3, "e", "error"),
      assistant(4, "local", call("agent", "launch")),
      result(5, "launch", "success"),
      assistant(6, "remote", call("private", "x")),
      result(8, "x", "success"),
    ),
  );
  await file(
    dir,
    "projects/a/subagents/main/agent-Explore-launch.jsonl",
    lines(
      { ...assistant(2, undefined, call("search", "s")), isSidechain: true },
      { ...assistant(3, undefined, call("read_file", "f")), isSidechain: true },
      result(4, "s", "success"),
    ),
  );
  await file(
    dir,
    "projects/b/chats/other.jsonl",
    lines(
      entry("system", 8, {
        subtype: "ui_telemetry",
        systemPayload: {
          uiEvent: {
            "event.name": "qwen-code.api_error",
            model: "local",
            error_message: "secret error",
          },
        },
      }),
    ),
  );
  await file(dir, "projects/b/chats/cloud.jsonl", lines(assistant(1, "remote")));
  await file(
    dir,
    "sessions/" + process.pid + ".json",
    JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      sessionId: "main",
      startedAt: Date.now(),
    }),
  );
  const inventory = await qwenSessions(dir, models);
  expect(inventory.sessions.length).toBe(3);
  expect(inventory.sessions.find((s) => s.id === "main")).toEqual({
    id: "main",
    project: "demo",
    client: "Qwen Code",
    model: "local",
    live: true,
    lastActivity: timestamp(5),
    tools: [
      { name: "mcp__custom", at: timestamp(1), continued: true },
      { name: "edit", at: timestamp(1), result: timestamp(3), failed: true },
      { name: "agent", at: timestamp(4), result: timestamp(5), failed: false },
    ],
  });
  expect(inventory.sessions.find((s) => s.id === "agent-Explore-launch")?.tools).toEqual([
    { name: "search", at: timestamp(2), result: timestamp(4), failed: false },
    { name: "read_file", at: timestamp(3) },
  ]);
  expect(JSON.stringify(inventory)).not.toMatch(/secret|private\/place/);
});

test("missing sources are quiet, unreadable directories and malformed histories warn", async () => {
  const dir = await home();
  expect(await qwenSessions(dir, models)).toEqual({ sessions: [], warnings: [] });
  await file(dir, "projects/a/chats/broken.jsonl", "{\n" + lines(assistant(1, "local")));
  await file(dir, "projects/b/chats", "unexpected regular file");
  const inventory = await qwenSessions(dir, models);
  expect(inventory.sessions).toHaveLength(1);
  expect(inventory.warnings).toHaveLength(2);
});

test("rejects a recycled registry PID and prefers the subagent's own model", async () => {
  const dir = await home();
  await file(
    dir,
    "projects/a/chats/parent.jsonl",
    lines(assistant(0, "local", call("agent", "fork"))),
  );
  await file(
    dir,
    "projects/a/subagents/parent/agent-Explore-fork.jsonl",
    lines(assistant(2, "remote", call("edit", "cloud"))),
  );
  await file(
    dir,
    "projects/a/subagents/parent/agent-own.jsonl",
    lines(assistant(3, "local", call("edit", "child"))),
  );
  await file(
    dir,
    "sessions/" + process.pid + ".json",
    JSON.stringify({ pid: process.pid, sessionId: "parent", startedAt: 1 }),
  );
  const { sessions, warnings } = await qwenSessions(dir, models);
  expect(sessions.map((s) => s.id).sort()).toEqual(["agent-own", "parent"]);
  expect(sessions.some((s) => s.live)).toBe(false);
  expect(warnings).toEqual([]);
});
