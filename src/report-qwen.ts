import { createReadStream, type Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, win32 } from "node:path";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReportSession, SessionInventory, ToolEvent } from "./report-session.ts";

const ps = promisify(execFile);
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

// Qwen writes both a per-process registry and (in older versions) chat runtime sidecars.
// Compare the OS process start time to the registration time to reject recycled PIDs.
async function liveId(path: string, registry: boolean, warnings: Set<string>) {
  try {
    const row = JSON.parse(await readFile(path, "utf8"));
    if (!registry && row.hostname !== hostname()) return;
    const id = registry ? row.sessionId : row.session_id;
    const since = registry ? row.startedAt : row.started_at * 1000;
    if (
      typeof id !== "string" ||
      !Number.isFinite(since) ||
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 0
    )
      return;
    if (registry && basename(path) !== row.pid + ".json") return;
    try {
      const { stdout } = await ps("ps", ["-p", String(row.pid), "-o", "lstart="], {
        env: { ...process.env, LC_ALL: "C" },
      });
      if (Date.parse(stdout.trim()) <= since) return id;
    } catch {
      // A registry entry often outlives its process.
    }
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
): Promise<SessionInventory> {
  const root = join(userHome, ".qwen");
  const warnings = new Set<string>();
  const sessions: ReportSession[] = [];
  const live = new Set<string>();
  for (const file of await entries(join(root, "sessions"), warnings)) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const id = await liveId(join(root, "sessions", file.name), true, warnings);
    if (id) live.add(id);
  }
  for (const project of await entries(join(root, "projects"), warnings)) {
    if (!project.isDirectory()) continue;
    const dir = join(root, "projects", project.name);
    const parents = new Map<string, Launch[]>();
    for (const file of await entries(join(dir, "chats"), warnings)) {
      if (!file.isFile()) continue;
      const path = join(dir, "chats", file.name);
      if (file.name.endsWith(".runtime.json")) {
        const id = await liveId(path, false, warnings);
        if (id) live.add(id);
      } else if (file.name.endsWith(".jsonl")) {
        const id = basename(file.name, ".jsonl");
        const launches: Launch[] = [];
        const chat = await history(path, id, models, warnings, launches);
        if (chat) sessions.push(chat);
        parents.set(id, launches);
      }
    }
    for (const parent of await entries(join(dir, "subagents"), warnings)) {
      if (!parent.isDirectory()) continue;
      const dirName = join(dir, "subagents", parent.name);
      for (const file of await entries(dirName, warnings)) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const id = basename(file.name, ".jsonl");
        const launch = parents.get(parent.name)?.find((l) => id.endsWith("-" + l.callId));
        const agent = await history(
          join(dirName, file.name),
          id,
          models,
          warnings,
          [],
          true,
          launch,
        );
        if (agent) sessions.push(agent);
      }
    }
  }
  for (const session of sessions) if (live.has(session.id)) session.live = true;
  return { sessions, warnings: [...warnings] };
}
