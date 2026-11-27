import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportCache } from "../src/report-cache.ts";
import { claudeSessions } from "../src/report-claude.ts";
import { qwenSessions } from "../src/report-qwen.ts";
import { openCodeSessions } from "../src/report-opencode.ts";

let home: string;
let saved: Partial<NodeJS.ProcessEnv>;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "report-cache-"));
  saved = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    OPENCODE_DB: process.env.OPENCODE_DB,
  };
  process.env.CLAUDE_CONFIG_DIR = home;
  process.env.OPENCODE_DB = join(home, "opencode.db");
});
afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

test("reuses stable files by model scope, drops unseen files, and retries a changing file", async () => {
  const path = join(home, "history");
  await writeFile(path, "a");
  let reads = 0;
  const cache = new ReportCache();
  const scan = (models?: string[]) => cache.scan("claude", models && new Set(models));
  const read = async () => ({ sessions: [], warnings: [String(++reads)] });
  const sample = (models?: string[]) => scan(models)(path, undefined, read);
  expect((await sample(["a", "b"])).warnings).toEqual(["1"]);
  expect((await sample(["b", "a"])).warnings).toEqual(["1"]);
  expect((await sample()).warnings).toEqual(["2"]);
  scan();
  expect((await sample()).warnings).toEqual(["3"]);
  await writeFile(path + "-new", "b");
  await rename(path + "-new", path);
  await scan()(path, undefined, async () => {
    await appendFile(path, "c");
    return read();
  });
  expect((await sample()).warnings).toEqual(["5"]);
});

const timestamp = "2025-01-01T00:00:00Z";
test("Claude merge and live flags remain fresh, including completed partial lines", async () => {
  const dir = join(home, "projects", "project");
  const agents = join(dir, "main", "subagents");
  await mkdir(agents, { recursive: true });
  const row = (name: string) =>
    JSON.stringify({
      timestamp,
      sessionId: "main",
      type: "assistant",
      message: { model: "local", content: [{ type: "tool_use", id: name, name }] },
    });
  const parent = join(dir, "main.jsonl");
  await writeFile(parent, row("root") + "\n{");
  await writeFile(join(agents, "agent.jsonl"), row("agent"));
  await mkdir(join(home, "sessions"));
  const registry = join(home, "sessions", String(process.pid));
  await writeFile(registry, JSON.stringify({ sessionId: "main", pid: process.pid }));
  const cache = new ReportCache();
  const sample = () => claudeSessions(home, undefined, cache);
  const first = await sample();
  expect(first.sessions[0]?.live).toBe(true);
  first.sessions[0]!.tools.length = 0;
  await rm(registry);
  const second = await sample();
  expect(second.sessions[0]?.live).toBeUndefined();
  expect(second.sessions[0]?.tools).toHaveLength(2);
  expect(second.warnings).toHaveLength(1);
  await appendFile(parent, row("tail").slice(1));
  await rm(agents, { recursive: true });
  const last = await sample();
  expect(last.warnings).toEqual([]);
  expect(last.sessions[0]?.tools.map((t) => t.name)).toEqual(["root", "tail"]);
});

test("Qwen reattributes an unchanged subagent when its parent launch changes", async () => {
  const project = join(home, ".qwen/projects/a");
  await mkdir(join(project, "chats"), { recursive: true });
  await mkdir(join(project, "subagents/main"), { recursive: true });
  const parent = (model: string) =>
    writeFile(
      join(project, "chats/main.jsonl"),
      JSON.stringify({
        timestamp,
        type: "assistant",
        model: "local",
        message: { parts: [{ functionCall: { id: "call", name: "agent", args: { model } } }] },
      }),
    );
  await parent("local");
  await writeFile(
    join(project, "subagents/main/agent-call.jsonl"),
    JSON.stringify({ timestamp, type: "assistant" }),
  );
  const cache = new ReportCache();
  const sample = () => qwenSessions(home, new Set(["local"]), cache);
  expect((await sample()).sessions).toHaveLength(2);
  expect((await sample()).sessions).toHaveLength(2);
  await parent("remote");
  expect((await sample()).sessions.map((s) => s.id)).toEqual(["main"]);
});

test("OpenCode sees new WAL commits between reads", async () => {
  const db = new Database(process.env.OPENCODE_DB!, { create: true });
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE session_v2(id TEXT, directory TEXT, model TEXT, time_updated INTEGER);
      CREATE TABLE session_message(id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_updated INTEGER);
      INSERT INTO session_v2 VALUES ('a','/p',null,1000)`);
    const cache = new ReportCache();
    const sample = () => openCodeSessions(home, undefined, cache);
    expect((await sample()).sessions).toHaveLength(1);
    db.exec("INSERT INTO session_v2 VALUES ('b','/p',null,2000)");
    expect((await sample()).sessions.map((s) => s.id)).toEqual(["a", "b"]);
  } finally {
    db.close();
  }
});
