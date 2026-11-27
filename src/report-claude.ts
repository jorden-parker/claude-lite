import { historyReader, type ReportCache } from "./report-cache.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { ReportSession, SessionInventory, ToolEvent } from "./report-session.ts";

const ps = promisify(execFile);
const identifier = (value: unknown) =>
  typeof value === "string" && /^[\w.:-]{1,200}$/.test(value) ? value : undefined;
const projectName = (cwd: unknown) => {
  if (typeof cwd !== "string") return;
  const name = basename(cwd.replaceAll("\\", "/"));
  if (name && name !== "." && name !== ".." && !/[\p{C}]/u.test(name)) return name.slice(0, 120);
};

async function entries(path: string, warnings: Set<string>, optional = false) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (err) {
    if (!optional || (err as NodeJS.ErrnoException).code !== "ENOENT")
      warnings.add("Some Claude Code history directories could not be read.");
    return [];
  }
}

async function liveSessions(root: string, warnings: Set<string>) {
  const live = new Set<string>();
  const dir = join(root, "sessions");
  for (const file of await entries(dir, warnings, true)) {
    if (!file.isFile() || !/^\d+(?:\.json)?$/.test(file.name)) continue;
    try {
      const pid = Number(basename(file.name, ".json"));
      const record = JSON.parse(await readFile(join(dir, file.name), "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0 || (record.pid != null && record.pid !== pid))
        continue;
      const id = identifier(record.sessionId);
      if (!id) continue;
      try {
        process.kill(pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EPERM") continue;
      }
      // Recent registries record the OS process start, so a recycled PID can be rejected.
      if (typeof record.procStart === "string" || Number.isFinite(record.startedAt)) {
        const { stdout } = await ps("ps", ["-o", "lstart=", "-p", String(pid)], {
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          timeout: 1500,
        });
        const start = stdout.trim();
        if (typeof record.procStart === "string" && start !== record.procStart) continue;
        if (Number.isFinite(record.startedAt) && Date.parse(start + " UTC") > record.startedAt)
          continue;
      }
      live.add(id);
    } catch {
      warnings.add("Some Claude Code process registry entries could not be read.");
    }
  }
  return live;
}

// Keep tool IDs scoped to the transcript. Subagents can execute independently of their parent.
async function readHistory(
  path: string,
  fallbackId: string,
  models: Set<string> | undefined,
  warnings: Set<string>,
) {
  const calls = new Map<string, ToolEvent>();
  const outstanding = new Set<ToolEvent>();
  const turnIds = new Set<string>();
  const canonicalFile = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(fallbackId);
  const tools: ToolEvent[] = [];
  const continued = () => {
    for (const event of outstanding) event.continued = true;
    outstanding.clear();
  };
  let turn: unknown;
  let localModel: string | undefined;
  let session: ReportSession | undefined;
  const stream = createReadStream(path, { encoding: "utf8" });
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        warnings.add("Some Claude Code transcript lines were incomplete or malformed.");
        continue;
      }
      // Forked transcripts can include copied messages tagged with the source session.
      if (canonicalFile && row?.sessionId && row.sessionId !== fallbackId) continue;
      const msg = row?.message;
      if (!msg || typeof row.timestamp !== "string") continue;
      const time = Date.parse(row.timestamp);
      if (!Number.isFinite(time)) continue;
      const at = new Date(time).toISOString();
      if (row.type === "assistant") {
        const model =
          typeof row.requestedModel === "string" && (!models || models.has(row.requestedModel))
            ? row.requestedModel
            : msg.model;
        if (
          msg.model === "<synthetic>" &&
          (!model || model === "<synthetic>" || (models && !models.has(model)))
        )
          continue;
        const next = msg.id ?? row.uuid ?? at;
        if (next !== turn || model !== localModel) {
          continued();
          turnIds.clear();
        }
        turn = next;
        localModel = models
          ? models.has(model)
            ? model
            : undefined
          : typeof model === "string"
            ? model
            : "unknown";
        if (!localModel) {
          calls.clear();
          continue;
        }
        if (!session) {
          session = {
            client: "Claude Code",
            id: identifier(row.sessionId) ?? identifier(fallbackId) ?? "unknown",
            project: projectName(row.cwd) ?? "unknown",
            lastActivity: at,
            tools,
          };
        }
        session.model = projectName(localModel) ?? "unknown";
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type !== "tool_use" || typeof block.id !== "string" || turnIds.has(block.id))
              continue;
            const event = { name: identifier(block.name) ?? "unknown", at };
            turnIds.add(block.id);
            tools.push(event);
            calls.set(block.id, event);
            outstanding.add(event);
          }
        }
      } else if (row.type === "user" && localModel) {
        if (typeof msg.content === "string") continued();
        else if (Array.isArray(msg.content)) {
          let hasResult = false;
          for (const block of msg.content) {
            if (block?.type !== "tool_result") continue;
            hasResult = true;
            const event = calls.get(block.tool_use_id);
            if (event && !event.result) {
              event.result = at;
              event.failed = block.is_error === true;
              delete event.continued;
              outstanding.delete(event);
            }
          }
          if (!hasResult && msg.content.some((b: { type?: string } | null) => b?.type === "text"))
            continued();
        }
      } else continue;
      if (session && at > session.lastActivity) session.lastActivity = at;
    }
  } catch {
    warnings.add("Some Claude Code transcripts could not be read completely.");
  } finally {
    stream.destroy();
  }
  return session;
}

export async function claudeSessions(
  userHome: string,
  models: Set<string> | undefined,
  cache?: ReportCache,
): Promise<SessionInventory> {
  const read = historyReader(cache, "claude", models);
  const root = process.env.CLAUDE_CONFIG_DIR || join(userHome, ".claude");
  const projects = join(root, "projects");
  const warnings = new Set<string>();
  const sessions = new Map<string, ReportSession>();
  const live = await liveSessions(root, warnings);
  async function collect(path: string, id: string) {
    const history = await read(path, id, async () => {
      const notices = new Set<string>();
      const session = await readHistory(path, id, models, notices);
      return {
        sessions: session ? [session] : [],
        warnings: [...notices],
        retry: notices.has("Some Claude Code transcripts could not be read completely."),
      };
    });
    for (const warning of history.warnings) warnings.add(warning);
    const found = history.sessions[0];
    if (!found) return;
    if (live.has(found.id)) found.live = true;
    const previous = sessions.get(found.id);
    if (!previous) sessions.set(found.id, found);
    else {
      for (const tool of found.tools) previous.tools.push(tool);
      if (found.lastActivity > previous.lastActivity) {
        previous.lastActivity = found.lastActivity;
        previous.model = found.model;
      }
    }
  }
  async function agents(dir: string, id: string, optional: boolean) {
    for (const file of await entries(dir, warnings, optional)) {
      const path = join(dir, file.name);
      if (file.isDirectory()) await agents(path, id, false);
      else if (file.isFile() && file.name.endsWith(".jsonl")) await collect(path, id);
    }
  }
  for (const project of await entries(projects, warnings, true)) {
    if (!project.isDirectory()) continue;
    const dir = join(projects, project.name);
    for (const entry of await entries(dir, warnings)) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl"))
        await collect(path, basename(path, ".jsonl"));
      else if (entry.isDirectory()) await agents(join(path, "subagents"), entry.name, true);
    }
  }
  for (const session of sessions.values()) session.tools.sort((a, b) => a.at.localeCompare(b.at));
  return {
    sessions: [...sessions.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
    warnings: [...warnings],
  };
}
