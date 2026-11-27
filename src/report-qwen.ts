import { historyReader, type ReportCache } from "./report-cache.ts";
import { createReadStream, type Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, win32 } from "node:path";
import { createInterface } from "node:readline";
import { ownsSession } from "./report-process.ts";
import type { ReportSession, SessionInventory, ToolEvent } from "./report-session.ts";

const unreadable = "Some Qwen Code history could not be read.";
const malformed = "Some Qwen Code history records could not be parsed.";

async function entries(path: string, warnings: Set<string>): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.add(unreadable);
    return [];
  }
}

// Runtime sidecars are project scoped. Registry slots are authoritative when both exist.
async function liveId(path: string, registry: boolean, warnings: Set<string>) {
  try {
    const row = JSON.parse(await readFile(path, "utf8"));
    const schema = registry ? row.schemaVersion : row.schema_version;
    if (schema != null && schema !== 1) return;
    if (!registry && row.hostname !== hostname()) return;
    const id = registry ? row.sessionId : row.session_id;
    const since = registry
      ? row.startedAt
      : typeof row.started_at === "number"
        ? row.started_at * 1000
        : NaN;
    if (
      typeof id !== "string" ||
      !Number.isFinite(since) ||
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 0
    )
      return;
    // Qwen's shared slot is PID.json. Independently registered sessions get
    // a four-byte random slot suffix and can legitimately share a process.
    if (registry && !new RegExp("^" + row.pid + "(?:-[0-9a-f]{8})?\\.json$").test(basename(path)))
      return;
    if (!registry && basename(path) !== id + ".runtime.json") return;
    if (
      await ownsSession("qwen", {
        pid: row.pid,
        startedAt: since,
        hostname: row.hostname,
        procStart: registry ? row.procStart : row.proc_start,
        pidNs: registry ? row.pidNs : row.pid_ns,
      })
    )
      return { id, pid: row.pid as number };
  } catch {
    warnings.add("Some Qwen Code session registrations could not be read.");
  }
}

type Launch = { model: string; callId: string };

async function history(
  path: string,
  id: string,
  models: Set<string> | undefined,
  warnings: Set<string>,
  launches: Launch[],
  sidechain = false,
  parent?: Launch,
) {
  let current: string | undefined;
  let model: string | undefined;
  let project = "Unknown project";
  let lastActivity = "";
  const calls = new Map<string, ToolEvent>();
  const unresolved = new Set<ToolEvent>();
  let inferred = false;
  const input = createReadStream(path);
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        warnings.add(malformed);
        continue;
      }
      if (
        !row ||
        typeof row.timestamp !== "string" ||
        !Number.isFinite(Date.parse(row.timestamp))
      ) {
        warnings.add(malformed);
        continue;
      }
      const at = new Date(row.timestamp).toISOString();
      const parts = Array.isArray(row.message?.parts) ? row.message.parts : [];
      const telemetry = row.systemPayload?.uiEvent;
      const api =
        row.type === "system" &&
        ["qwen-code.api_error", "qwen-code.api_response"].includes(telemetry?.["event.name"]);
      if (row.type === "assistant" || api) {
        const recordedModel = api ? telemetry.model : row.model;
        if (typeof recordedModel === "string") current = recordedModel;
        else if (!current && parent) {
          current = parent.model;
          inferred = !models || models.has(current);
        }
        if (!models && !current) current = "unknown";
        if (current && (!models || models.has(current))) {
          model = current;
        }
      }
      const local = current !== undefined && (!models || models.has(current));
      if (typeof row.cwd === "string") project = win32.basename(row.cwd) || "Root";
      if (
        row.type === "user" ||
        (row.type === "assistant" &&
          (!row.isSidechain ||
            row.agentRound != null ||
            parts.some((p: { text?: unknown } | null) => typeof p?.text === "string")))
      ) {
        for (const call of unresolved) call.continued = true;
        unresolved.clear();
      }
      let relevant = local && (api || ["assistant", "user", "tool_result"].includes(row.type));
      if (row.type === "assistant") {
        for (const part of parts) {
          const call = part?.functionCall;
          if (typeof call?.id !== "string" || typeof call.name !== "string" || calls.has(call.id))
            continue;
          if (call.name === "agent" || call.name === "task") {
            const agentModel = call.args?.model ?? current;
            if (typeof agentModel === "string")
              launches.push({ callId: call.id, model: agentModel });
          }
          if (!local) continue;
          const event = { name: win32.basename(call.name), at };
          calls.set(call.id, event);
          unresolved.add(event);
        }
      }
      if (row.type === "tool_result") {
        for (const part of parts) {
          const response = part?.functionResponse;
          if (!response) continue;
          const call = calls.get(response.id ?? row.toolCallResult?.callId);
          if (!call) continue;
          relevant = true;
          const info = row.toolCallResult;
          call.result = at;
          call.failed =
            [info?.status, info?.executionStatus].some((s) =>
              ["error", "cancelled", "canceled", "denied", "not_started", "failed"].includes(s),
            ) || !!response.response?.error;
          delete call.continued;
          unresolved.delete(call);
        }
      }
      if (relevant && at > lastActivity) lastActivity = at;
    }
  } catch {
    warnings.add(unreadable);
  } finally {
    input.destroy();
  }
  if (sidechain && !current)
    warnings.add("Some Qwen Code subagent history could not be attributed to a model.");
  if (!model || !lastActivity) return;
  if (inferred)
    warnings.add(
      "Some Qwen Code subagent model assignments use the parent tool call because the subagent history omits its model.",
    );
  return {
    client: "Qwen Code",
    id,
    project,
    model: win32.isAbsolute(model) ? win32.basename(model) : model,
    lastActivity,
    tools: [...calls.values()],
  } satisfies ReportSession;
}

export async function qwenSessions(
  userHome: string,
  models: Set<string> | undefined,
  cache?: ReportCache,
): Promise<SessionInventory> {
  const read = historyReader(cache, "qwen", models);
  const root = join(userHome, ".qwen");
  const warnings = new Set<string>();
  const sessions: ReportSession[] = [];
  const main = new Map<ReportSession, string>();
  async function collect(path: string, id: string, sidechain = false, parent?: Launch) {
    const result = await read(path, parent?.model, async () => {
      const notices = new Set<string>();
      const launches: Launch[] = [];
      const session = await history(path, id, models, notices, launches, sidechain, parent);
      return {
        sessions: session ? [session] : [],
        warnings: [...notices],
        launches,
        retry: notices.has(unreadable),
      };
    });
    for (const warning of result.warnings) warnings.add(warning);
    sessions.push(...result.sessions);
    if (!sidechain) for (const session of result.sessions) main.set(session, path);
    return result.launches ?? [];
  }
  const runtimeFiles: string[] = [];
  for (const project of await entries(join(root, "projects"), warnings)) {
    if (!project.isDirectory()) continue;
    const dir = join(root, "projects", project.name);
    const parents = new Map<string, Launch[]>();
    for (const file of await entries(join(dir, "chats"), warnings)) {
      if (!file.isFile()) continue;
      const path = join(dir, "chats", file.name);
      if (file.name.endsWith(".runtime.json")) {
        runtimeFiles.push(path);
      } else if (file.name.endsWith(".jsonl")) {
        const id = basename(file.name, ".jsonl");
        parents.set(id, await collect(path, id));
      }
    }
    for (const parent of await entries(join(dir, "subagents"), warnings)) {
      if (!parent.isDirectory()) continue;
      const dirName = join(dir, "subagents", parent.name);
      for (const file of await entries(dirName, warnings)) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const id = basename(file.name, ".jsonl");
        const launch = parents.get(parent.name)?.find((l) => id.endsWith("-" + l.callId));
        await collect(join(dirName, file.name), id, true, launch);
      }
    }
  }
  const registered = new Set<number>();
  const liveIds = new Set<string>();
  for (const file of await entries(join(root, "sessions"), warnings)) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const id = await liveId(join(root, "sessions", file.name), true, warnings);
    if (id) {
      registered.add(id.pid);
      liveIds.add(id.id);
    }
  }
  const sidecars = new Map<number, string | undefined>();
  for (const path of runtimeFiles) {
    const id = await liveId(path, false, warnings);
    if (!id || registered.has(id.pid)) continue;
    const chat = path.slice(0, -".runtime.json".length) + ".jsonl";
    sidecars.set(id.pid, sidecars.has(id.pid) && sidecars.get(id.pid) !== chat ? undefined : chat);
  }
  const livePaths = new Set(sidecars.values());
  const unique = new Map<string, ReportSession | undefined>();
  for (const [session, path] of main) {
    if (livePaths.has(path)) session.live = true;
    if (liveIds.has(session.id))
      unique.set(session.id, unique.has(session.id) ? undefined : session);
  }
  for (const session of unique.values()) if (session) session.live = true;
  return { sessions, warnings: [...warnings] };
}
