import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { mlxUrl, servedModelId } from "./mlx.ts";
import { loadSizes } from "./ollama/sizes.ts";

export type ServerSample = {
  at: string;
  error?: string;
  version?: string;
  models?: string[];
  loading?: number;
  active?: number;
  waiting?: number;
  requests?: number;
  prompt?: number;
  cached?: number;
  prefill?: number;
  uptime?: number;
};

export type ReadEvent = { at: string; result?: string; failed?: boolean; continued?: boolean };
export type ReadTrace = { reads: ReadEvent[]; lastActivity: string };
export type DiagnosticReport = {
  captured: string;
  samples: ServerSample[];
  trace?: ReadTrace;
};

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

async function sampleServer(url: string): Promise<ServerSample> {
  const at = new Date().toISOString();
  try {
    const response = await fetch(url + "/api/status", { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { at, error: `HTTP ${response.status}` };
    const data = await response.json();
    if (data?.status !== "ok" && typeof data?.total_requests !== "number")
      return { at, error: "Unrecognized status response" };
    return {
      at,
      version: typeof data.version === "string" ? data.version : undefined,
      models: Array.isArray(data.loaded_models)
        ? data.loaded_models.filter((m: unknown) => typeof m === "string")
        : undefined,
      loading: finite(data.models_loading),
      active: finite(data.active_requests),
      waiting: finite(data.waiting_requests),
      requests: finite(data.total_requests),
      prompt: finite(data.total_prompt_tokens),
      cached: finite(data.total_cached_tokens),
      prefill: finite(data.avg_prefill_tps),
      uptime: finite(data.uptime_seconds),
    };
  } catch (error) {
    return {
      at,
      error:
        error instanceof Error && error.name === "TimeoutError"
          ? "Status request timed out"
          : "Status endpoint unavailable",
    };
  }
}

async function sampleWindow(url: string) {
  const first = await sampleServer(url);
  if (first.error) return [first];
  await Bun.sleep(1000);
  return [first, await sampleServer(url)];
}

const validTime = (s: unknown): s is string =>
  typeof s === "string" && Number.isFinite(Date.parse(s));

// Only typed tool IDs and timestamps survive parsing. Never retain tool inputs or result text.
export function readTrace(lines: string, cwd: string, models: Set<string>): ReadTrace | undefined {
  const calls = new Map<string, ReadEvent>();
  const openCalls = new Set<ReadEvent>();
  let turn: string | undefined;
  const nextTurn = () => {
    for (const call of openCalls) call.continued = true;
    openCalls.clear();
  };
  let lastActivity: string | undefined;
  let mlxConversation = false;
  for (const line of lines.split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.isSidechain || entry.cwd !== cwd || !validTime(entry.timestamp)) continue;
    const { type, message } = entry;
    const timestamp = new Date(entry.timestamp).toISOString();
    if (type === "user" && typeof message?.content === "string") {
      if (mlxConversation) {
        nextTurn();
        lastActivity = timestamp;
      }
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    if (type === "assistant") {
      if (message.model === "<synthetic>" && !models.has(entry.requestedModel)) continue;
      const id = message.id ?? entry.uuid ?? timestamp;
      if (id !== turn) nextTurn();
      turn = id;
      mlxConversation = models.has(entry.requestedModel) || models.has(message.model);
      if (!mlxConversation) calls.clear();
      if (!mlxConversation) continue;
      for (const block of message.content)
        if (
          block?.type === "tool_use" &&
          block.name === "Read" &&
          typeof block.id === "string" &&
          !calls.has(block.id)
        ) {
          const call = { at: timestamp };
          calls.set(block.id, call);
          openCalls.add(call);
        }
    } else if (type === "user" && mlxConversation) {
      for (const block of message.content) {
        const call = block?.type === "tool_result" && calls.get(block.tool_use_id);
        if (call) {
          openCalls.delete(call);
          delete call.continued;
          call.result = timestamp;
          call.failed = block.is_error === true;
        }
      }
      if (
        message.content.some((b: { type?: string } | null) => b?.type === "text") &&
        !message.content.some((b: { type?: string } | null) => b?.type === "tool_result")
      )
        nextTurn();
    } else continue;
    lastActivity = timestamp;
  }
  return lastActivity && mlxConversation ? { reads: [...calls.values()], lastActivity } : undefined;
}

async function transcriptTail(path: string) {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString();
    return start ? lines.slice(lines.indexOf("\n") + 1) : lines;
  } finally {
    await file.close();
  }
}

export async function latestReadTrace(configDir: string, cwd: string, models: Set<string>) {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const root = join(configDir, "projects");
  try {
    const dirs =
      slug.length <= 200
        ? [slug]
        : (await readdir(root)).filter((n) => n.startsWith(slug.slice(0, 200)));
    const candidates: { path: string; mtime: number }[] = [];
    for (const dir of dirs) {
      const project = join(root, dir);
      for (const entry of await readdir(project, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const path = join(project, entry.name);
        const info = await stat(path).catch(() => undefined);
        if (info) candidates.push({ path, mtime: info.mtimeMs });
      }
    }
    for (const { path } of candidates.sort((a, b) => b.mtime - a.mtime).slice(0, 12)) {
      const text = await transcriptTail(path).catch(() => "");
      const trace = readTrace(text, cwd, models);
      if (trace) return trace;
    }
  } catch {
    /* A project may have no readable Claude history. */
  }
}

export async function collectReport(userHome: string, home: string): Promise<DiagnosticReport> {
  const models = new Set<string>();
  try {
    for (const size of Object.values(loadSizes(home)))
      if (size.mlx) models.add(servedModelId(size.mlx));
  } catch {
    /* The doctor also runs with an invalid size configuration. */
  }
  const samples = await sampleWindow(mlxUrl());
  for (const sample of samples) for (const model of sample.models ?? []) models.add(model);
  const trace = await latestReadTrace(
    process.env.CLAUDE_CONFIG_DIR || join(userHome, ".claude"),
    process.cwd(),
    models,
  );
  return { captured: new Date().toISOString(), samples, trace };
}

export function readFinding({ trace, samples }: DiagnosticReport) {
  const server = samples.at(-1);
  if (!trace)
    return {
      title: "No matching transcript",
      detail:
        "Run cl report in the directory where you launched Claude Code to inspect its recent Read events.",
      tone: "neutral",
    };
  if (!trace.reads.length)
    return {
      title: "No recent Read recorded",
      detail: "The matching transcript contains no Read call in the inspected portion.",
      tone: "neutral",
    };
  const pending = trace.reads.filter((call) => !call.result && !call.continued);
  if (pending.length)
    return {
      title: "Read result outstanding",
      detail:
        (pending.length === 1 ? "One Read has" : pending.length + " Reads have") +
        " no recorded result. " +
        (server?.active === 0 && server.waiting === 0 && server.loading === 0
          ? "oMLX was idle at capture. Check Claude Code for a permission prompt or a waiting hook."
          : "Check Claude Code for a permission prompt or a waiting hook."),
      tone: "warning",
    };
  if (trace.reads.at(-1)?.continued)
    return {
      title: "Conversation continued",
      detail:
        "Claude continued after this Read. Its result was absent from the inspected transcript entries.",
      tone: "neutral",
    };
  if (trace.reads.at(-1)?.failed)
    return {
      title: "Read returned an error",
      detail: "Claude recorded an error result for its latest Read.",
      tone: "warning",
    };
  return {
    title: "Read returned",
    detail: server?.active
      ? "Claude recorded the file result. oMLX was processing a request at capture. Check the model turn following the Read."
      : "Claude recorded a result for the latest Read. A pause after that timestamp is downstream of the file read.",
    tone: "good",
  };
}

export function counterDelta(report: DiagnosticReport, key: "requests" | "prompt" | "cached") {
  if (report.samples.length !== 2) return undefined;
  const [a, b] = report.samples;
  if (
    a.error ||
    b.error ||
    (a.uptime !== undefined && b.uptime !== undefined && b.uptime < a.uptime)
  )
    return undefined;
  const from = a[key],
    to = b[key];
  return from !== undefined && to !== undefined && to >= from ? to - from : undefined;
}

export function reportLines(report: DiagnosticReport) {
  const finding = readFinding(report);
  const server = report.samples.at(-1)!;
  const recent =
    report.trace?.reads.findLast((r) => !r.result && !r.continued) ?? report.trace?.reads.at(-1);
  return [
    `Read evidence · ${finding.title}${recent ? " · last Read " + recent.at + (recent.result ? " · result " + recent.result : "") : ""}`,
    server.error
      ? `oMLX · ${server.error}`
      : `oMLX ${server.version ?? ""} · active ${server.active ?? "?"} · waiting ${server.waiting ?? "?"} · loading ${server.loading ?? "?"} · ${server.models?.join(", ") || "no loaded model reported"}`,
    ...(!server.error
      ? [
          `Server totals · requests ${server.requests ?? "?"} · prompt tokens ${server.prompt ?? "?"} · cached tokens ${server.cached ?? "?"} · average prefill ${server.prefill ?? "?"} tok/s`,
          `Sample change · requests ${counterDelta(report, "requests") ?? "?"} · prompt tokens ${counterDelta(report, "prompt") ?? "?"} · cached tokens ${counterDelta(report, "cached") ?? "?"}`,
        ]
      : []),
  ];
}
