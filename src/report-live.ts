import { randomUUID } from "node:crypto";
import type { DiagnosticReport } from "./report-data.ts";
import { renderReport, reportParts } from "./report-view.ts";
import clientScript from "./report-stream.js" with { type: "text" };

type Parts = ReturnType<typeof reportParts>;

function changes(next: Parts, previous?: Parts) {
  const old = new Map(previous?.sessions);
  const orderChanged =
    !previous ||
    previous.sessions.length !== next.sessions.length ||
    next.sessions.some(([key], i) => previous.sessions[i][0] !== key);
  return {
    panels: Object.fromEntries(
      Object.entries(next.panels).filter(([id, html]) => html !== previous?.panels[id]),
    ),
    changed: next.sessions.filter(([key, html]) => old.get(key) !== html),
    order: orderChanged ? next.sessions.map(([key]) => key) : undefined,
  };
}

export function startReportMonitor(
  initial: DiagnosticReport,
  collect: () => Promise<DiagnosticReport>,
  intervalMs = 2000,
) {
  let latest = initial;
  let parts = reportParts(initial);
  let version = 1;
  let lastCapture = Date.now();
  let delayed = false;
  let stopped = false;
  let refreshing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const route = "/" + randomUUID() + "/";
  const encoder = new TextEncoder();
  function frame(event: string, data: unknown) {
    return encoder.encode(`id: ${version}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function broadcast(bytes: Uint8Array) {
    for (const client of clients) {
      try {
        // Reconnect a tab which has stopped reading instead of accumulating updates.
        if ((client.desiredSize ?? 0) <= 0) client.close();
        else {
          client.enqueue(bytes);
          continue;
        }
      } catch {
        /* A tab can close during capture. */
      }
      clients.delete(client);
    }
  }
  function schedule(delay = intervalMs) {
    if (!timer && !stopped && !refreshing && clients.size) timer = setTimeout(refresh, delay);
  }
  async function refresh() {
    timer = undefined;
    if (!clients.size || stopped) return;
    refreshing = true;
    try {
      const data = await collect();
      if (stopped) return;
      const next = reportParts(data);
      const patch = changes(next, parts);
      latest = data;
      parts = next;
      version++;
      lastCapture = Date.now();
      delayed = false;
      broadcast(frame("patch", patch));
    } catch {
      delayed = true;
      broadcast(frame("stale", null));
    } finally {
      refreshing = false;
      schedule();
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (req.method !== "GET" || req.headers.get("host") !== "127.0.0.1:" + server.port)
        return new Response(null, { status: 404 });
      const headers = {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      };
      if (url.pathname === route) {
        const page = renderReport(latest, true)
          .replace("</head>", `<meta name="report-version" content="${version}"></head>`)
          .replace("</body>", () => `<script>${clientScript}</script></body>`);
        return new Response(page, {
          headers: {
            ...headers,
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
          },
        });
      }
      if (url.pathname !== route + "events") return new Response(null, { status: 404 });
      server.timeout(req, 0);
      const previous = req.headers.get("last-event-id") ?? url.searchParams.get("version");
      let connection: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            connection = controller;
            const overdue = Date.now() - lastCapture >= intervalMs * 2;
            if (previous !== String(version)) controller.enqueue(frame("sync", changes(parts)));
            controller.enqueue(frame(delayed || overdue ? "stale" : "ready", null));
            clients.add(controller);
            schedule(overdue ? 0 : intervalMs);
          },
          cancel() {
            clients.delete(connection);
          },
        },
        { highWaterMark: 4 },
      );
      return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream" } });
    },
  });
  return {
    url: new URL(route, server.url).href,
    latest: () => latest,
    stop() {
      stopped = true;
      clearTimeout(timer);
      for (const client of clients) client.close();
      clients.clear();
      return server.stop(true);
    },
  };
}
