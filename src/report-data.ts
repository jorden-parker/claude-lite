import type { ReportCache } from "./report-cache.ts";
import { mlxUrl, servedModelId } from "./mlx.ts";
import { loadSizes } from "./ollama/sizes.ts";
import { isRemoteHost, ollamaUrl } from "./ollama/api.ts";
import { claudeSessions } from "./report-claude.ts";
import { qwenSessions } from "./report-qwen.ts";
import { openCodeSessions } from "./report-opencode.ts";
import {
  eventStatus,
  isFinding,
  type ReportSession,
  type SessionInventory,
} from "./report-session.ts";

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

export type DiagnosticReport = SessionInventory & {
  captured: string;
  samples: ServerSample[];
  ollamaModels?: string[];
  allModels?: boolean;
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

async function loadedOllamaModels(): Promise<string[] | undefined> {
  try {
    if (isRemoteHost()) return undefined;
    const response = await fetch(ollamaUrl() + "/api/ps", {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    if (!response.ok) return undefined;
    const data = await response.json();
    if (Array.isArray(data?.models))
      return data.models
        .map((m: { name?: string } | null) => m?.name)
        .filter((name: unknown) => typeof name === "string");
  } catch {
    /* Offline runtimes still have useful session history. */
  }
}

export async function collectReport(
  userHome: string,
  home: string,
  allModels = false,
  cache?: ReportCache,
): Promise<DiagnosticReport> {
  const [samples, ollamaModels] = await Promise.all([sampleWindow(mlxUrl()), loadedOllamaModels()]);
  const models = new Set<string>(ollamaModels);
  for (const sample of samples) for (const id of sample.models ?? []) models.add(id);
  try {
    for (const size of Object.values(loadSizes(home))) {
      models.add(size.model);
      models.add(size.base);
      if (size.mlx) models.add(servedModelId(size.mlx));
    }
  } catch {
    /* The doctor also runs with an invalid size configuration. */
  }
  for (const id of models) {
    if (id.endsWith(":latest")) models.add(id.slice(0, -7));
    else if (!id.includes(":")) models.add(id + ":latest");
  }
  const sessions: ReportSession[] = [];
  const warnings: string[] = [];
  const readers = [claudeSessions, qwenSessions, openCodeSessions];
  const sources = ["Claude Code", "Qwen Code", "OpenCode"];
  const inventories = await Promise.allSettled(
    readers.map((read) => read(userHome, allModels ? undefined : models, cache)),
  );
  for (const [i, inventory] of inventories.entries()) {
    if (inventory.status === "rejected")
      warnings.push(sources[i] + " history could not be inspected.");
    else {
      for (const session of inventory.value.sessions) sessions.push(session);
      warnings.push(...new Set(inventory.value.warnings));
    }
  }
  sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity) || a.id.localeCompare(b.id));
  return {
    captured: new Date().toISOString(),
    samples,
    ollamaModels,
    sessions,
    warnings,
    allModels,
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
  const server = report.samples.at(-1)!;
  const lines = [
    `${report.allModels ? "All recorded sessions" : "Local model sessions"} · ${report.sessions.length} recorded`,
    server.error
      ? `oMLX · ${server.error}`
      : `oMLX ${server.version ?? ""} · active ${server.active ?? "?"} · waiting ${server.waiting ?? "?"} · loading ${server.loading ?? "?"} · ${server.models?.join(", ") || "no loaded model reported"}`,
    `Ollama · ${report.ollamaModels?.join(", ") || (report.ollamaModels ? "no loaded models" : "local status unavailable")}`,
  ];
  if (!server.error)
    lines.push(
      `Server totals · requests ${server.requests ?? "?"} · prompt tokens ${server.prompt ?? "?"} · cached tokens ${server.cached ?? "?"} · average prefill ${server.prefill ?? "?"} tok/s`,
      `Sample change · requests ${counterDelta(report, "requests") ?? "?"} · prompt tokens ${counterDelta(report, "prompt") ?? "?"} · cached tokens ${counterDelta(report, "cached") ?? "?"}`,
    );
  for (const session of report.sessions) {
    const findings = session.tools.filter(isFinding);
    lines.push(
      `${session.client} · ${session.project} · ${session.id} · ${session.model ?? "model unknown"} · ${session.live ? "live · " : ""}${session.tools.length} calls · ${findings.length} flagged`,
    );
    for (const event of findings)
      lines.push(
        `  ${event.at} · ${event.name} · ${eventStatus(event)}${event.result ? " · result " + event.result : ""}`,
      );
  }
  return [...lines, ...report.warnings].map((line) =>
    line.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "),
  );
}
