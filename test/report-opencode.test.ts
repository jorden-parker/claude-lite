import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeSessions } from "../src/report-opencode.ts";
import { elapsedMs } from "../src/report-session.ts";

let home: string;
let root: string;
let oldXdg: string | undefined;
let oldDb: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "report-opencode-"));
  oldXdg = process.env.XDG_DATA_HOME;
  oldDb = process.env.OPENCODE_DB;
  process.env.XDG_DATA_HOME = join(home, "data");
  delete process.env.OPENCODE_DB;
  root = join(home, "data/opencode");
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldXdg;
  if (oldDb === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = oldDb;
  rmSync(home, { recursive: true, force: true });
});

for (const split of [false, true]) {
  test(`reads v2 ${split ? "split" : "inline"} tool metadata across projects and agents`, async () => {
    const db = new Database(join(root, "opencode.db"), { create: true });
    db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, model TEXT,time_updated INTEGER);
      CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT,time_updated INTEGER)`);
    if (split) db.exec("CREATE TABLE session_part(message_id TEXT,type TEXT,data TEXT)");
    const insert = db.query("INSERT INTO session_v2 VALUES(?,?,?,?,?)");
    const local = { providerID: "claude-lite", id: "custom" };
    const remote = { providerID: "cloud", id: "custom" };
    for (const [id, parent, model] of [
      ["a", null, remote],
      ["b", "a", local],
      ["c", null, remote],
      ["d", null, local],
    ] as const)
      insert.run(id, parent, "/secret/" + id, JSON.stringify(model), 1000);
    const msg = db.query("INSERT INTO session_message VALUES(?,?,'assistant',?,?,1000)");
    function message(
      id: string,
      session: string,
      seq: number,
      model: typeof local,
      status: string,
    ) {
      const tool = {
        type: "tool",
        name: "plugin_command",
        id: "call",
        state: { status, input: { command: "SECRET" }, content: ["PRIVATE"] },
        time: { created: 1000, completed: status === "running" ? undefined : 63100 },
      };
      msg.run(
        id,
        session,
        seq,
        JSON.stringify({
          model,
          content: split && id !== "one" ? [] : [{ type: "text", text: "PRIVATE" }, tool],
        }),
      );
      if (split)
        db.query("INSERT INTO session_part VALUES(?,'tool',?)").run(id, JSON.stringify(tool));
    }
    message("one", "a", 1, local, "running");
    message("two", "a", 2, remote, "completed");
    message("three", "a", 3, local, "completed");
    message("four", "b", 1, local, "error");
    message("five", "c", 1, remote, "completed");
    db.close();
    const result = await openCodeSessions(home, new Set(["custom"]));
    expect(result.warnings).toEqual([]);
    expect(result.sessions.map((s) => s.id)).toEqual(["a", "b", "d"]);
    const [main, child] = result.sessions;
    expect(main!.tools.map((t) => t.name)).toEqual(["plugin_command", "plugin_command"]);
    expect(main!.tools[0]?.continued).toBe(true);
    expect(main!.tools[0]?.result).toBeUndefined();
    expect(elapsedMs(main!.tools[1]!)).toBe(62100);
    expect(child!.tools[0]?.failed).toBe(true);
    expect(child!.project).toBe("b");
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|secret/);
  });
}

test("missing sources are silent and unreadable or incompatible databases warn", async () => {
  expect(await openCodeSessions(home, new Set())).toEqual({ sessions: [], warnings: [] });
  writeFileSync(join(root, "opencode.db"), "not a database");
  expect((await openCodeSessions(home, new Set())).warnings).toHaveLength(1);
  process.env.OPENCODE_DB = "custom.db";
  const db = new Database(join(root, "custom.db"), { create: true });
  db.exec("CREATE TABLE session(id TEXT)");
  db.close();
  expect((await openCodeSessions(home, new Set())).warnings).toHaveLength(1);
});
