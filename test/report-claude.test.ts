import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessions } from "../src/report-claude.ts";

const model = "configured-local";
const at = (n: number) => new Date(1700000000000 + n * 1000).toISOString();
const use = (name: string, id: string) => ({
  type: "tool_use",
  id,
  name,
  input: { private: "private-input" },
});
const result = (id: string, error = false) => ({
  type: "tool_result",
  tool_use_id: id,
  is_error: error,
  content: "private-result",
});
const row = (n: number, type: string, content: unknown, modelId = model, id = String(n)) =>
  JSON.stringify({
    timestamp: at(n),
    type,
    cwd: "/secret/second",
    sessionId: "old-session",
    message: { model: modelId, content, id },
  });

test("rejects an unrelated live PID across projects and pairs main and agent tools independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl-history-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const first = join(root, "projects", "first");
    const second = join(root, "projects", "another");
    const agents = join(second, "old-session", "subagents");
    await mkdir(first, { recursive: true });
    await mkdir(agents, { recursive: true });
    await mkdir(join(root, "sessions"));
    await writeFile(
      join(root, "sessions", process.pid + ".json"),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), sessionId: "old-session" }),
    );
    await writeFile(
      join(second, "old-session.jsonl"),
      [
        row(1, "assistant", [use("Bash", "a"), use("Grep", "b")], model, "turn"),
        row(2, "assistant", [use("Edit", "c")], model, "turn"),
        row(3, "user", [result("b", true), result("a")]),
        row(4, "user", "private-interrupt"),
        row(5, "assistant", [use("Write", "d")]),
        row(6, "assistant", [use("Remote", "e")], "remote"),
        row(7, "user", [result("e")]),
        row(8, "assistant", [use("Last", "f")]),
      ].join("\n"),
    );
    await writeFile(
      join(agents, "agent-x.jsonl"),
      [row(1, "assistant", [use("AgentTool", "a")]), row(2, "user", [result("a", true)])].join(
        "\n",
      ),
    );
    for (let i = 0; i < 14; i++)
      await writeFile(
        join(first, i + ".jsonl"),
        JSON.stringify({
          cwd: "/secret/first",
          timestamp: at(0),
          type: "assistant",
          message: { model, content: [] },
        }),
      );
    const report = await claudeSessions(root, new Set([model]));
    expect(report.warnings).toEqual([]);
    expect(report.sessions).toHaveLength(15);
    const session = report.sessions[0]!;
    expect(session).toMatchObject({
      id: "old-session",
      project: "second",
      lastActivity: at(8),
      model,
    });
    expect(session.live).toBeUndefined();
    const tools = Object.fromEntries(session.tools.map((t) => [t.name, t]));
    expect(Object.keys(tools).sort()).toEqual([
      "AgentTool",
      "Bash",
      "Edit",
      "Grep",
      "Last",
      "Write",
    ]);
    expect(tools.Bash).toMatchObject({ result: at(3), failed: false });
    expect(tools.AgentTool).toMatchObject({ result: at(2), failed: true });
    expect(tools.Grep).toMatchObject({ result: at(3), failed: true });
    expect(tools.Edit).toEqual({ name: "Edit", at: at(2), continued: true });
    expect(tools.Write.continued).toBe(true);
    expect(tools.Last).toEqual({ name: "Last", at: at(8) });
    expect(JSON.stringify(report)).not.toMatch(/secret|private-|Remote/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("missing history is quiet and unreadable history warns without leaking paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "cl-missing-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    expect(await claudeSessions(home, new Set([model]))).toEqual({ sessions: [], warnings: [] });
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude", "projects"), "bad directory");
    const { warnings } = await claudeSessions(home, new Set([model]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(home);
  } finally {
    if (previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(home, { recursive: true, force: true });
  }
});
