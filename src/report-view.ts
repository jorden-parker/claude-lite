import { counterDelta, readFinding, type DiagnosticReport } from "./report-data.ts";
import styles from "./report.css" with { type: "text" };

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
const num = (n?: number) =>
  n === undefined ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const stamp = (s: string) => new Date(s).toISOString().replace("T", " ").slice(0, 19);
function duration(ms: number) {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) return num(seconds) + " s";
  return Math.floor(seconds / 60) + "m " + Math.floor(seconds % 60) + "s";
}

export function renderReport(report: DiagnosticReport) {
  const { samples, trace, captured } = report;
  const server = samples.at(-1)!;
  const finding = readFinding(report);
  const reads = trace?.reads ?? [];
  const pending = reads.filter((r) => !r.result && !r.continued);
  const read = pending.at(-1) ?? reads.at(-1);
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
  const activity = reads
    .slice(-5)
    .reverse()
    .map((r) => {
      const status = r.result
        ? r.failed
          ? "Error returned"
          : "Result returned"
        : r.continued
          ? "No recorded result"
          : "Awaiting result";
      return `<li><div class="event"><span class="dot ${r.result && !r.failed ? "good" : "warning"}"></span><div><strong>Read</strong><small>${status}</small></div></div><div class="when"><time>${stamp(r.at)} UTC</time><small>${r.continued ? "Conversation continued" : duration(Date.parse(r.result ?? captured) - Date.parse(r.at)) + (r.result ? " to result" : " since request")}</small></div></li>`;
    })
    .join("");
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
<span class="dot ${finding.tone}">
</span> Read evidence</div>
<h2>${finding.title}</h2>
<p>${escape(finding.detail)}</p>${read ? `<div class="fact">Requested <time>${stamp(read.at)} UTC</time>${read.result ? `<br>Result <time>${stamp(read.result)} UTC</time>` : ""}</div>` : ""}</div>
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
<section aria-labelledby="metrics">
<div class="section-title">
<h2 id="metrics">Inference activity</h2>
<span>Server-wide</span>
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
<div class="panels">
<section>
<div class="section-title">
<h2>Read timeline</h2>
<span>Latest transcript</span>
</div>
<div class="panel">${
    activity
      ? `<ol>${activity}</ol>`
      : `<div class="empty">
<strong>No recorded Read events</strong>
<p>The timeline appears when a matching Claude Code transcript contains a Read request.</p>
</div>`
  }</div>${trace ? `<p class="note">Last transcript activity · ${stamp(trace.lastActivity)} UTC</p>` : ""}</section>
<section>
<div class="section-title">
<h2>Server samples</h2>
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
</section>
</div>
<footer>
<span>claude-lite</span>
<span>Local snapshot · UTC</span>
</footer>
</main>
</body>
</html>`;
}
