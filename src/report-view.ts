import { counterDelta, type DiagnosticReport } from "./report-data.ts";
import {
  elapsedMs,
  eventStatus,
  isFinding,
  type ReportSession,
  type ToolEvent,
} from "./report-session.ts";
import styles from "./report.css" with { type: "text" };

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
const num = (n?: number) =>
  n === undefined ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const stamp = (s: string) =>
  Number.isFinite(Date.parse(s))
    ? new Date(s).toISOString().replace("T", " ").slice(0, 19)
    : "Unknown";
function duration(ms: number) {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) return num(seconds) + " s";
  return Math.floor(seconds / 60) + "m " + Math.floor(seconds % 60) + "s";
}

function toolRow(event: ToolEvent, liveAt?: string) {
  const elapsed = elapsedMs(event);
  const since =
    liveAt && !event.result && !event.continued
      ? Date.parse(liveAt) - Date.parse(event.at)
      : undefined;
  const timing =
    elapsed !== undefined && elapsed >= 0
      ? duration(elapsed) + " to result"
      : since !== undefined && since >= 0
        ? duration(since) + " since request"
        : "";
  return `<li><div class="event"><span class="dot ${isFinding(event) ? "warning" : "good"}"></span><div><strong>${escape(event.name)}</strong><small>${eventStatus(event)}</small></div></div><div class="when"><time>${stamp(event.at)} UTC</time>${timing ? `<small>${timing}</small>` : ""}</div></li>`;
}

function sessionCard(session: ReportSession, captured: string, expanded: boolean) {
  const flagged = session.tools.filter(isFinding);
  const recent = session.tools.filter((t) => !isFinding(t)).slice(-5);
  return `<details class="session"${expanded ? " open" : ""}><summary><div><strong>${escape(session.project)}</strong><small>${escape(session.client)} · ${escape(session.model ?? "Model unknown")}</small></div><div class="count">${session.live ? "Live · " : ""}${flagged.length ? `<b>${num(flagged.length)} flagged</b>` : "No flags"}<small>${num(session.tools.length)} calls</small></div></summary>
  <p class="session-id">Session <code>${escape(session.id)}</code> · Last activity <time>${stamp(session.lastActivity)} UTC</time></p>
  ${
    flagged.length
      ? `<h3>Flagged calls</h3><ol>${flagged
          .toReversed()
          .map((event) => toolRow(event, session.live ? captured : undefined))
          .join("")}</ol>`
      : ""
  }
  ${
    recent.length
      ? `<h3>Recent successful calls</h3><ol>${recent
          .toReversed()
          .map((event) => toolRow(event, session.live ? captured : undefined))
          .join("")}</ol>`
      : ""
  }
  </details>`;
}

export function renderReport(report: DiagnosticReport) {
  const { samples, sessions, captured } = report;
  const server = samples.at(-1)!;
  let errors = 0,
    missing = 0,
    slow = 0;
  for (const session of sessions)
    for (const tool of session.tools) {
      if (tool.failed) errors++;
      else if (!tool.result) missing++;
      else if (isFinding(tool)) slow++;
    }
  const flagged = errors + missing + slow;
  const focus =
    sessions.find((s) => s.live && s.tools.some(isFinding)) ??
    sessions.find((s) => s.tools.some(isFinding));
  const model = server.models?.join(", ");
  const state = server.error
    ? server.error
    : server.loading
      ? "Loading model"
      : server.active
        ? "Processing"
        : server.waiting
          ? "Requests queued"
          : server.active === 0 && server.waiting === 0
            ? "Idle"
            : "Reachable";
  const items = [
    ["Active requests", server.active, "At last sample"],
    ["Waiting requests", server.waiting, "At last sample"],
    ["Prompt tokens", server.prompt, "Server total"],
    ["Cached tokens", server.cached, "Server total"],
  ] as const;
  const rows = [
    ["Sample time (UTC)", ...samples.map((s) => stamp(s.at).slice(11))],
    ["Completed requests", ...samples.map((s) => num(s.requests))],
    ["Active / queued", ...samples.map((s) => num(s.active) + " / " + num(s.waiting))],
    ["Prompt tokens", ...samples.map((s) => num(s.prompt))],
    ["Cached tokens", ...samples.map((s) => num(s.cached))],
    ["Average prefill (tok/s)", ...samples.map((s) => num(s.prefill))],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Session diagnostics · claude-lite</title>
<style>${styles}</style>
</head>
<body>
<header>
<div class="bar">
<strong class="brand">
<span class="mark" aria-hidden="true">›_</span> claude-lite</strong>
<span class="slash" aria-hidden="true">/</span>
<span>Diagnostics</span>
</div>
</header>
<main>
<div class="mast">
<div>
<h1>Session diagnostics</h1>
<p class="meta">Captured <time>${stamp(captured)} UTC</time>
</p>
</div>
<button onclick="window.print()">Print report <span aria-hidden="true">↗</span>
</button>
</div>
<section class="summary">
<div class="finding">
<div class="label">
<span class="dot ${flagged ? "warning" : "good"}"></span> Tool activity</div>
<h2>${flagged ? num(flagged) + (flagged === 1 ? " flagged call" : " flagged calls") : sessions.length ? "No calls flagged" : "No matching sessions"}</h2>
<p>${num(errors)} errors · ${num(missing)} without a result · ${num(slow)} successful calls lasting at least 60 seconds</p></div>
<div class="server">
<div class="label">
<span class="dot ${server.error ? "warning" : "good"}">
</span> oMLX server</div>
<h2>${escape(state)}</h2>
<p class="model">${escape(model || (server.loading ? "Loading weights" : server.error ? "Live counters unavailable" : "No loaded model reported"))}</p>${
    server.version
      ? `<small>Version <code>${escape(server.version)}</code>
</small>`
      : ""
  }</div>
</section>
<section aria-labelledby="sessions"><div class="section-title"><h2 id="sessions">${report.allModels ? "All recorded sessions" : "Local model sessions"}</h2><span>${num(sessions.length)} recorded</span></div>
<div class="panel sessions">${sessions.length ? sessions.map((session) => sessionCard(session, captured, session === focus)).join("") : `<div class="empty"><strong>No matching history found</strong><p>${report.allModels ? "No supported session records were found." : "Use cl report --all-models to include older aliases and other providers."}</p></div>`}</div>
<p class="note">A missing result can mean the tool is still running, the session ended, or the client did not record its response. Times are measured between recorded events.</p>
${report.warnings.map((w) => `<p class="note">${escape(w)}</p>`).join("")}</section>
<section aria-labelledby="metrics">
<div class="section-title">
<h2 id="metrics">Inference activity</h2>
<span>oMLX · server-wide</span>
</div>
<div class="metrics">${items
    .map(
      ([label, value, note]) => `<div>
<h3>${label}</h3>
<b>${num(value)}</b>
<small>${note}</small>
</div>`,
    )
    .join("")}</div>
</section>
<section>
<div class="section-title">
<h2>oMLX server samples</h2>
<span>${samples.length} captured</span>
</div>
<div class="panel">
<table>
<thead>
<tr>
<th scope="col">Measurement</th>${samples.map((_, i) => `<th scope="col">Sample ${i + 1}</th>`).join("")}</tr>
</thead>
<tbody>${rows
    .map(
      ([label, ...vals]) => `<tr>
<th scope="row">${label}</th>${vals.map((v) => `<td>${v}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody>
</table>
</div>
<p class="note">${samples.length < 2 || server.error ? "A second successful server sample is needed to compare counters." : counterDelta(report, "requests") === 0 ? "No requests finished between samples. Token totals can stay flat during a long request." : "Token counts accumulate across requests. Compare the two samples for changes."}</p>
<p class="note">Ollama · ${escape(report.ollamaModels?.join(", ") || (report.ollamaModels ? "No loaded models" : "Local status unavailable"))}</p>
</section>
<footer>
<span>claude-lite</span>
<span>Local snapshot · UTC</span>
</footer>
</main>
<script>
let collapsed = [];
window.addEventListener("beforeprint", () => {
  collapsed = [...document.querySelectorAll("details:not([open])")];
  for (const session of collapsed) session.open = true;
});
window.addEventListener("afterprint", () => {
  for (const session of collapsed) session.open = false;
  collapsed = [];
});
</script>
</body>
</html>`;
}
