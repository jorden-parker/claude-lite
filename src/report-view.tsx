import { Alert, AlertDescription } from "./report-ui/alert";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "./report-ui/empty";
import { counterDelta, type DiagnosticReport } from "./report-data.ts";
import {
  elapsedMs,
  eventStatus,
  isFinding,
  type ReportSession,
  type ToolEvent,
} from "./report-session.ts";
import styles from "./report.css" with { type: "text" };

import { renderToStaticMarkup as html } from "react-dom/server";
import {
  Printer,
  Search,
  Terminal,
  CircleAlert,
  Activity,
  Timer,
  CircleX,
  CircleDashed,
} from "lucide-react";
import { Badge } from "./report-ui/badge";
import { Button } from "./report-ui/button";
import { Input } from "./report-ui/input";
import { NativeSelect, NativeSelectOption } from "./report-ui/native-select";
import { Card } from "./report-ui/card";
import { Table, TableHead, TableRow, TableBody, TableHeader, TableCell } from "./report-ui/table";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./report-ui/collapsible";
import utilities from "./report-ui/utilities.css" with { type: "text" };

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

function ToolRow({ event, liveAt }: { event: ToolEvent; liveAt?: string }) {
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
  return (
    <li>
      <div className="event">
        <span
          className={"dot " + (event.failed ? "error" : isFinding(event) ? "warning" : "good")}
        />
        <div>
          <strong>{event.name}</strong>
          <small>{eventStatus(event)}</small>
        </div>
      </div>
      <div className="when">
        <time>{stamp(event.at)} UTC</time>
        {timing && <small>{timing}</small>}
      </div>
    </li>
  );
}

function sessionCard(session: ReportSession, captured: string, key: string) {
  const flagged = session.tools.filter(isFinding);
  const recent = session.tools.filter((t) => !isFinding(t)).slice(-5);
  return html(
    <Collapsible
      data-session-key={key}
      className="session"
      data-flagged={!!flagged.length}
      data-live={!!session.live}
    >
      <CollapsibleTrigger>
        <span className="project">
          <strong>{session.project}</strong>
          <small>
            {session.client} · {session.model ?? "Model unknown"}
          </small>
        </span>
        <span className="activity">
          {session.live && (
            <Badge variant="outline" className="live">
              <span className="current">Live</span>
              <span className="snapshot-live">Live at capture</span>
              <span className="last-live">Last seen live</span>
            </Badge>
          )}
          {stamp(session.lastActivity)}
        </span>
        <span className="calls" data-unit={session.tools.length === 1 ? " call" : " calls"}>
          {num(session.tools.length)}
        </span>
        <Badge variant="secondary" className={"status" + (flagged.length ? " flagged" : "")}>
          {flagged.length ? num(flagged.length) + " flagged" : "No flags"}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="session-id">
          Session <code>{session.id}</code> · Last activity{" "}
          <time>{stamp(session.lastActivity)} UTC</time>
        </p>
        {(
          [
            ["Flagged calls", flagged],
            ["Recent successful calls", recent],
          ] as const
        ).map(([title, calls]) => {
          return (
            calls.length > 0 && (
              <div key={title}>
                <h3>{title}</h3>
                <ol>
                  {calls.toReversed().map((event, i) => (
                    <ToolRow key={i} event={event} liveAt={session.live ? captured : undefined} />
                  ))}
                </ol>
              </div>
            )
          );
        })}
      </CollapsibleContent>
    </Collapsible>,
  );
}

export function reportParts(report: DiagnosticReport): {
  panels: Record<string, string>;
  sessions: [string, string][];
} {
  const { samples, sessions, captured } = report;
  const server = samples.at(-1)!;
  let latest: { event: ToolEvent; project: string } | undefined;
  let errors = 0,
    missing = 0,
    slow = 0;
  for (const session of sessions)
    for (const tool of session.tools) {
      if (isFinding(tool) && (!latest || Date.parse(tool.at) > Date.parse(latest.event.at))) {
        latest = { event: tool, project: session.project };
      }
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
  const panels = {
    "capture-time": html(
      <>
        Captured <time>{stamp(captured)} UTC</time>
      </>,
    ),
    "session-heading": report.allModels ? "All recorded sessions" : "Local model sessions",
    "session-count": num(sessions.length) + " recorded",
    "activity-summary": html(
      <Card className="findings">
        <div className="finding-overview">
          <div className="finding-total">
            {flagged ? <CircleAlert aria-hidden="true" /> : <Activity aria-hidden="true" />}
            <strong>
              {num(flagged)} flagged {flagged === 1 ? "call" : "calls"}
            </strong>
          </div>
          {latest && (
            <p className="latest">
              Latest · {latest.project} / <b>{latest.event.name}</b> · {eventStatus(latest.event)}
            </p>
          )}
        </div>
        <dl className="breakdown">
          {(
            [
              [CircleX, "Errors", errors, "errors"],
              [CircleDashed, "Without a result", missing, "missing"],
              [Timer, "Slow (≥60s)", slow, "slow"],
            ] as const
          ).map(([Icon, label, value, kind]) => (
            <div key={kind} data-kind={value ? kind : undefined}>
              <dt>
                <Icon aria-hidden="true" />
                {label}
              </dt>
              <dd>{num(value)}</dd>
            </div>
          ))}
        </dl>
      </Card>,
    ),
    "history-empty": sessions.length
      ? ""
      : html(
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No matching sessions</EmptyTitle>
              <EmptyDescription>
                {report.allModels ? (
                  "No supported session records were found."
                ) : (
                  <>
                    Use <code>cl report --all-models</code> to include other models.
                  </>
                )}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>,
        ),
    "report-warnings": html(
      <>
        {report.warnings.map((w, i) => (
          <Alert key={i}>
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{w}</AlertDescription>
          </Alert>
        ))}
      </>,
    ),
    "runtime-status": html(
      <>
        <div className="runtime-head">
          <h3>oMLX</h3>
          <Badge variant="outline" className={"state" + (server.error ? " flagged" : "")}>
            {state}
          </Badge>
        </div>
        {!server.error && (
          <p className="model">
            {model || (server.loading ? "Loading weights" : "No loaded model reported")}
          </p>
        )}
        {server.version && (
          <small>
            Version <code>{server.version}</code>
          </small>
        )}
        {!server.error && (
          <dl className="metrics">
            {items.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{num(value)}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="ollama">
          <h3>Ollama</h3>
          <p className="model">
            {report.ollamaModels?.join(", ") ||
              (report.ollamaModels ? "No loaded models" : "Local status unavailable")}
          </p>
        </div>
      </>,
    ),
    "runtime-samples": samples.every((s) => s.error)
      ? ""
      : html(
          <>
            <div className="runtime-head">
              <h3>oMLX server samples</h3>
              <small>{num(samples.length)} captured</small>
            </div>
            <Table aria-label="oMLX server samples">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Measurement</TableHead>
                  {samples.map((_, i) => (
                    <TableHead key={i} scope="col">
                      Sample {i + 1}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(([label, ...values]) => (
                  <TableRow key={label}>
                    <TableHead scope="row">{label}</TableHead>
                    {values.map((v, i) => (
                      <TableCell key={i}>{v}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="note">
              {samples.length < 2 || server.error
                ? "A second successful server sample is needed to compare counters."
                : counterDelta(report, "requests") === 0
                  ? "No requests finished between samples. Token totals can stay flat during a long request."
                  : "Token counts accumulate across requests."}
            </p>
          </>,
        ),
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
  const panel = (id: keyof typeof panels) => ({
    id,
    dangerouslySetInnerHTML: { __html: panels[id] },
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Session diagnostics · claude-lite</title><style>${utilities}\n${styles}</style></head><body data-report-state="${live ? "connecting" : "snapshot"}">${html(
    <>
      <header>
        <div className="bar">
          <strong className="brand">
            <span className="mark">
              <Terminal aria-hidden="true" size={16} />
            </span>
            claude-lite
          </strong>
          <span className="slash" aria-hidden="true">
            /
          </span>
          Diagnostics
          {live ? (
            <Badge variant="outline" id="stream-status" role="status" data-state="connecting">
              Connecting
            </Badge>
          ) : (
            <Badge variant="outline" className="snapshot">
              Offline snapshot
            </Badge>
          )}
        </div>
      </header>
      <main>
        <div className="mast">
          <div>
            <h1>Session diagnostics</h1>
            <p {...panel("capture-time")} />
          </div>
          <Button variant="outline" id="print-report" aria-label="Print report">
            <Printer aria-hidden="true" />
            <span>Print report</span>
          </Button>
        </div>
        <div {...panel("activity-summary")} />
        <section aria-labelledby="session-heading">
          <div className="section-title">
            <h2 {...panel("session-heading")} />
            <small role="status" {...panel("session-count")} />
          </div>
          <Card className="panel session-panel">
            <div className="toolbar" hidden>
              <label className="search">
                <Search aria-hidden="true" size={16} />
                <Input
                  id="session-query"
                  type="search"
                  aria-label="Search sessions"
                  placeholder="Search project, client, model or ID"
                />
              </label>
              <NativeSelect id="session-filter" aria-label="Filter sessions">
                <NativeSelectOption value="all">All sessions</NativeSelectOption>
                <NativeSelectOption value="flagged">Flagged sessions</NativeSelectOption>
                <NativeSelectOption value="live">Live at last capture</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="inventory">
              <div className="columns" aria-hidden="true">
                <span>Project / model</span>
                <span>Last activity · UTC</span>
                <span>Calls</span>
                <span>Findings</span>
              </div>
              <div
                id="session-list"
                dangerouslySetInnerHTML={{ __html: sessions.map(([, markup]) => markup).join("") }}
              />
            </div>
            <div {...panel("history-empty")} />
            <Empty id="filter-empty" hidden>
              <EmptyTitle>No sessions match these filters.</EmptyTitle>
            </Empty>
          </Card>
          <p className="note">
            A missing result can indicate a running tool, an ended session or an unrecorded
            response.
          </p>
          <div {...panel("report-warnings")} />
        </section>
        <section aria-labelledby="runtime">
          <div className="section-title">
            <h2 id="runtime">Runtime</h2>
            <small>Server-wide</small>
          </div>
          <div className="runtime">
            <Card className="panel runtime-card" {...panel("runtime-status")} />
            <Card className="panel runtime-card" {...panel("runtime-samples")} />
          </div>
        </section>
      </main>
    </>,
  )}<script>
document.getElementById("print-report").addEventListener("click", () => window.print());

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
