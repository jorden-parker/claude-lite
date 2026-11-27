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
  return `<li><div class="event"><span class="dot ${event.failed ? "error" : isFinding(event) ? "warning" : "good"}"></span><div><strong>${escape(event.name)}</strong><small>${eventStatus(event)}</small></div></div><div class="when"><time>${stamp(event.at)} UTC</time>${timing ? `<small>${timing}</small>` : ""}</div></li>`;
}

function sessionCard(session: ReportSession, captured: string, key: string) {
  const flagged = session.tools.filter(isFinding);
  const recent = session.tools.filter((t) => !isFinding(t)).slice(-5);
  return `<details data-session-key="${escape(key)}" class="session" data-flagged="${!!flagged.length}" data-live="${!!session.live}">
  <summary><span class="project"><strong>${escape(session.project)}</strong><small>${escape(session.client)} · ${escape(session.model ?? "Model unknown")}</small></span>
  <span class="activity">${session.live ? '<b class="live">Live</b> ' : ""}${stamp(session.lastActivity)}</span>
  <span class="calls">${num(session.tools.length)}</span><span class="status${flagged.length ? " flagged" : ""}">${flagged.length ? num(flagged.length) + " flagged" : "No flags"}</span></summary>
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

export function reportParts(report: DiagnosticReport): {
  panels: Record<string, string>;
  sessions: [string, string][];
} {
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
    ["Active requests", server.active],
    ["Waiting requests", server.waiting],
    ["Prompt tokens", server.prompt],
    ["Cached tokens", server.cached],
  ] as const;
  const rows = [
    ["Sample time (UTC)", ...samples.map((s) => stamp(s.at).slice(11))],
    ["Completed requests", ...samples.map((s) => num(s.requests))],
    ["Active / queued", ...samples.map((s) => num(s.active) + " / " + num(s.waiting))],
    ["Prompt tokens", ...samples.map((s) => num(s.prompt))],
    ["Cached tokens", ...samples.map((s) => num(s.cached))],
    ["Average prefill (tok/s)", ...samples.map((s) => num(s.prefill))],
  ];
  const panels: Record<string, string> = {
    "capture-time": `Captured <time>${stamp(captured)} UTC</time>`,
    "session-heading": report.allModels ? "All recorded sessions" : "Local model sessions",
    "session-count": num(sessions.length) + " recorded",
    "activity-summary": `<strong class="${flagged ? "flag-text" : ""}">${num(flagged)} flagged ${flagged === 1 ? "call" : "calls"}</strong>
      <span>${num(errors)} ${errors === 1 ? "error" : "errors"}</span><span>${num(missing)} without a result</span><span title="Successful calls lasting at least 60 seconds">${num(slow)} slow (≥60s)</span>`,
    "history-empty": sessions.length
      ? ""
      : `<div class="empty"><strong>No matching sessions</strong><p>${report.allModels ? "No supported session records were found." : "Use <code>cl report --all-models</code> to include other models."}</p></div>`,
    "report-warnings": report.warnings.map((w) => `<p class="note">${escape(w)}</p>`).join(""),
    "runtime-status": `<div class="runtime-head"><h3>oMLX</h3><span class="state${server.error ? " flagged" : ""}">${escape(state)}</span></div>
      ${server.error ? "" : `<p class="model">${escape(model || (server.loading ? "Loading weights" : "No loaded model reported"))}</p>`}
      ${server.version ? `<small>Version <code>${escape(server.version)}</code></small>` : ""}
      ${server.error ? "" : `<dl class="metrics">${items.map(([label, value]) => `<div><dt>${label}</dt><dd>${num(value)}</dd></div>`).join("")}</dl>`}
      <div class="ollama"><h3>Ollama</h3><p class="model">${escape(report.ollamaModels?.join(", ") || (report.ollamaModels ? "No loaded models" : "Local status unavailable"))}</p></div>`,
    "runtime-samples": samples.every((s) => s.error)
      ? ""
      : `<div class="runtime-head"><h3>oMLX server samples</h3><small>${num(samples.length)} captured</small></div>
      <div class="table-wrap"><table aria-label="oMLX server samples"><thead><tr><th scope="col">Measurement</th>${samples.map((_, i) => `<th scope="col">Sample ${i + 1}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(([label, ...values]) => `<tr><th scope="row">${label}</th>${values.map((value) => `<td>${value}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="note">${samples.length < 2 || server.error ? "A second successful server sample is needed to compare counters." : counterDelta(report, "requests") === 0 ? "No requests finished between samples. Token totals can stay flat during a long request." : "Token counts accumulate across requests."}</p>`,
  };
  return {
    panels,
    sessions: sessions.map((session) => {
      const key = JSON.stringify([session.client, session.project, session.id]);
      return [key, sessionCard(session, captured, key)];
    }),
  };
}

export function renderReport(report: DiagnosticReport, live = false): string {
  const { panels, sessions } = reportParts(report);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Session diagnostics · claude-lite</title><style>${styles}</style></head>
<body><header><div class="bar"><strong class="brand"><span class="mark" aria-hidden="true">›_</span> claude-lite</strong><span class="slash" aria-hidden="true">/</span>Diagnostics
${live ? '<span id="stream-status" role="status" data-state="connecting">Connecting</span>' : '<span class="snapshot">Offline snapshot</span>'}</div></header>
<main><div class="mast"><div><h1>Session diagnostics</h1><p id="capture-time">${panels["capture-time"]}</p></div><button onclick="window.print()">Print report</button></div>
<section aria-labelledby="session-heading"><div class="section-title"><h2 id="session-heading">${panels["session-heading"]}</h2><small id="session-count" role="status">${panels["session-count"]}</small></div>
<div class="panel"><div id="activity-summary">${panels["activity-summary"]}</div>
<div class="toolbar" hidden><label class="search"><span>Search</span><input id="session-query" type="search" placeholder="Project, client, model or ID"></label>
<label><span>Show</span><select id="session-filter"><option value="all">All sessions</option><option value="flagged">Flagged</option><option value="live">Live</option></select></label></div>
<div class="inventory"><div class="columns" aria-hidden="true"><span>Project / model</span><span>Last activity · UTC</span><span>Calls</span><span>Findings</span></div>
<div id="session-list">${sessions.map(([, html]) => html).join("")}</div></div>
<div id="history-empty">${panels["history-empty"]}</div><div id="filter-empty" class="empty" hidden>No sessions match these filters.</div></div>
<p class="note">A missing result can indicate a running tool, an ended session or an unrecorded response.</p><div id="report-warnings">${panels["report-warnings"]}</div></section>
<section aria-labelledby="runtime"><div class="section-title"><h2 id="runtime">Runtime</h2><small>Server-wide</small></div>
<div class="runtime"><div class="panel runtime-card" id="runtime-status">${panels["runtime-status"]}</div>
<div class="panel runtime-card" id="runtime-samples">${panels["runtime-samples"]}</div></div></section></main>
<script>
(() => {
  const list = document.getElementById("session-list");
  const query = document.getElementById("session-query");
  const filter = document.getElementById("session-filter");
  const count = document.getElementById("session-count");
  document.querySelector(".toolbar").hidden = false;
  const searchIndex = new WeakMap();
  function searchable(row) {
    if (!searchIndex.has(row)) {
      const fields = [".project strong", ".project small", ".session-id code"];
      searchIndex.set(row, fields.map(selector => row.querySelector(selector).textContent).join(" ").toLowerCase());
    }
    return searchIndex.get(row);
  }
  function refresh() {
    const needle = query.value.trim().toLowerCase();
    let visible = 0;
    for (const row of list.children) {
      const matches = filter.value === "all" || row.dataset[filter.value] === "true";
      const hidden = !matches || (needle !== "" && !searchable(row).includes(needle));
      if (row.hidden !== hidden) row.hidden = hidden;
      if (!row.hidden) visible++;
    }
    count.textContent = (needle || filter.value !== "all") ? visible.toLocaleString("en-US") + " of " + list.children.length.toLocaleString("en-US") : list.children.length.toLocaleString("en-US") + " recorded";
    document.getElementById("filter-empty").hidden = visible !== 0 || list.children.length === 0;
  }
  query.addEventListener("input", refresh);
  filter.addEventListener("change", refresh);
  document.addEventListener("report-updated", refresh);
  let collapsed = [];
  window.addEventListener("beforeprint", () => {
    collapsed = [...list.querySelectorAll("details:not([open]):not([hidden])")];
    for (const row of collapsed) row.open = true;
  });
  window.addEventListener("afterprint", () => {
    for (const row of collapsed) row.open = false;
    collapsed = [];
  });
})();
</script></body></html>`;
}
