import { historyReader, type ReportCache } from "./report-cache.ts";
import { Database } from "bun:sqlite";
import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ReportSession, SessionInventory } from "./report-session.ts";

type SessionRow = {
  id: string;
  directory: string;
  updated: number;
  provider: string | null;
  model: string | null;
};
type MessageRow = { id: string; provider: string | null; model: string | null; updated: number };
type ToolRow = { name: string; created: number; completed: number | null; status: string };

function iso(time: unknown) {
  if (typeof time === "number" && Number.isFinite(new Date(time).getTime()))
    return new Date(time).toISOString();
}

function label(value: string) {
  return basename(value.replaceAll("\\", "/"))
    .replace(/[\p{C}]/gu, "")
    .slice(0, 180);
}

function modelLabel(value: string | null) {
  if (!value) return undefined;
  return /^[\w.:-]+(?:\/[\w.:-]+)?$/.test(value) ? value : label(value);
}

// OpenCode v2.0.2 stores assistant content inline. v2.4.2 also projects it into
// session_part. See packages/core/src/session/sql.ts and packages/schema/src/session-message.ts
// at https://github.com/anomalyco/opencode/tree/v2.4.2
function readDatabase(db: Database, models: Set<string> | undefined) {
  db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON");
  const tables = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map((row) => row.name),
  );
  if (!tables.has("session_v2") || !tables.has("session_message")) throw Error("schema");
  const sessionRows = db.query<SessionRow, []>(`
    SELECT id, directory, time_updated AS updated,
           json_extract(model,'$.providerID') AS provider, json_extract(model,'$.id') AS model
    FROM session_v2 ORDER BY id`);
  const messages = db.query<MessageRow, [string]>(`
    SELECT id, time_updated AS updated, json_extract(data,'$.model.providerID') AS provider,
           json_extract(data,'$.model.id') AS model
    FROM session_message WHERE session_id=? AND type='assistant' ORDER BY seq`);
  const split = tables.has("session_part");
  const parts = db.query<ToolRow, [string]>(`
    WITH tools(data) AS (
      SELECT p.value FROM session_message m, json_each(m.data,'$.content') p
      WHERE m.id=?1 AND json_extract(p.value,'$.type')='tool'
      ${split ? "AND NOT EXISTS (SELECT 1 FROM session_part s WHERE s.message_id=m.id AND s.type='tool' AND json_extract(s.data,'$.id')=json_extract(p.value,'$.id'))" : ""}
      ${split ? "UNION ALL SELECT data FROM session_part WHERE message_id=?1 AND type='tool'" : ""}
    )
    SELECT json_extract(data,'$.name') AS name, json_extract(data,'$.state.status') AS status,
           json_extract(data,'$.time.created') AS created, json_extract(data,'$.time.completed') AS completed
    FROM tools ORDER BY created`);
  const local = (provider: string | null, model: string | null) =>
    !models ||
    provider === "claude-lite" ||
    provider === "ollama" ||
    provider === "lmstudio" ||
    (!provider && !!model && models.has(model));

  const sessions: ReportSession[] = [];
  for (const row of sessionRows.all()) {
    let include = local(row.provider, row.model);
    let model = include ? modelLabel(row.model) : undefined;
    let lastActivity = iso(row.updated) ?? "";
    const tools: ReportSession["tools"] = [];
    let outstanding: ReportSession["tools"] = [];
    for (const message of messages.all(row.id)) {
      for (const call of outstanding) call.continued = true;
      outstanding = [];
      if (!local(message.provider ?? row.provider, message.model ?? row.model)) continue;
      include = true;
      model = modelLabel(message.model) ?? model;
      const updated = iso(message.updated);
      if (updated && updated > lastActivity) lastActivity = updated;
      for (const part of parts.all(message.id)) {
        const at = iso(part.created);
        if (!at || typeof part.name !== "string") continue;
        const result = iso(part.completed);
        const call = { name: label(part.name), at, result, failed: part.status === "error" };
        tools.push(call);
        if (!result && !call.failed) outstanding.push(call);
        if ((result ?? at) > lastActivity) lastActivity = result ?? at;
      }
    }
    if (include)
      sessions.push({
        client: "OpenCode",
        id: label(row.id),
        project: label(row.directory) || "(unknown)",
        model,
        lastActivity,
        tools,
      });
  }
  return sessions;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export async function openCodeSessions(
  userHome: string,
  models: Set<string> | undefined,
  cache?: ReportCache,
): Promise<SessionInventory> {
  const read = historyReader(cache, "opencode", models);
  const inventory: SessionInventory = { sessions: [], warnings: [] };
  const root = join(process.env.XDG_DATA_HOME || join(userHome, ".local/share"), "opencode");
  const override = process.env.OPENCODE_DB;
  let files: string[];
  try {
    if (override) files = override === ":memory:" ? [] : [resolve(root, override)];
    else {
      const entries = await readdir(root);
      files = entries
        .filter((name) => /^opencode(?:-[\w.-]+)?\.db$/.test(name))
        .sort()
        .map((name) => join(root, name));
      if (!files.length && entries.includes("storage"))
        inventory.warnings.push(
          "Legacy OpenCode storage found. Only v2 SQLite history is supported.",
        );
    }
  } catch (error) {
    if (!missing(error)) inventory.warnings.push("OpenCode data directory could not be read.");
    return inventory;
  }
  for (const file of files) {
    try {
      const result = await read(file, undefined, async () => {
        if (!(await stat(file)).isFile()) throw Error("not a file");
        const db = new Database(file, { readonly: true });
        try {
          return { sessions: db.transaction(() => readDatabase(db, models))(), warnings: [] };
        } finally {
          db.close();
        }
      });
      for (const session of result.sessions) inventory.sessions.push(session);
    } catch (error) {
      if (!missing(error))
        inventory.warnings.push(
          "OpenCode history database could not be read as a supported v2 SQLite database.",
        );
    }
  }
  return inventory;
}
