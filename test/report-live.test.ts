import { expect, test } from "bun:test";
import { startReportMonitor } from "../src/report-live.ts";
import type { DiagnosticReport } from "../src/report-data.ts";

const at = "2026-11-27T12:00:00.000Z";
const initial: DiagnosticReport = {
  captured: at,
  samples: [{ at, active: 1 }],
  warnings: [],
  sessions: ["stable", "changing"].map((id) => ({
    client: "Claude Code",
    project: "fixture",
    id,
    lastActivity: at,
    tools: [{ name: "Edit", at }],
  })),
};

test("serves a private live page and streams only changed rows, with full recovery for a stale browser", async () => {
  const next = structuredClone(initial);
  next.sessions[1].tools[0].result = at;
  let calls = 0;
  const monitor = startReportMonitor(
    initial,
    async () => {
      calls++;
      return next;
    },
    20,
  );
  const disconnected = new AbortController();
  const reconnect = new AbortController();
  try {
    expect((await fetch(new URL("/", monitor.url))).status).toBe(404);
    expect((await fetch(monitor.url, { headers: { host: "foreign.example" } })).status).toBe(404);
    const page = await fetch(monitor.url);
    expect(await page.text()).toContain('name="report-version" content="1"');
    const response = await fetch(new URL("events?version=1", monitor.url), {
      signal: disconnected.signal,
    });
    const reader = response.body!.getReader();
    let data = "";
    const decoder = new TextDecoder();
    while (!data.includes("event: patch")) data += decoder.decode((await reader.read()).value);
    expect(data).toContain("event: ready");
    const event = JSON.parse(data.split("event: patch\ndata: ")[1].split("\n")[0]);
    expect(event.order).toBeUndefined();
    expect(event.changed).toHaveLength(1);
    expect(event.changed[0][1]).toContain("changing");
    disconnected.abort();
    const resumed = await fetch(new URL("events?version=1", monitor.url), {
      signal: reconnect.signal,
    });
    const first = decoder.decode((await resumed.body!.getReader().read()).value);
    expect(first).toContain("stable");
    expect(first).toContain("changing");
    expect(calls).toBeGreaterThan(0);
  } finally {
    disconnected.abort();
    reconnect.abort();
    await monitor.stop();
  }
});

test("keeps the last successful capture during a refresh failure and stops sampling without viewers", async () => {
  let attempts = 0;
  const monitor = startReportMonitor(
    initial,
    async () => {
      if (++attempts === 1) throw new Error("transient failure");
      return { ...initial, sessions: [] };
    },
    20,
  );
  const tab = new AbortController();
  try {
    const res = await fetch(new URL("events?version=1", monitor.url), { signal: tab.signal });
    const reader = res.body!.getReader();
    let events = "";
    const decoder = new TextDecoder();
    while (!events.includes("event: stale")) events += decoder.decode((await reader.read()).value);
    expect(monitor.latest().sessions).toHaveLength(2);
    while (!events.includes("event: patch")) events += decoder.decode((await reader.read()).value);
    const patch = JSON.parse(events.split("event: patch\ndata: ")[1].split("\n")[0]);
    expect(patch.order).toEqual([]);
    tab.abort();
    await Bun.sleep(75);
    const count = attempts;
    await Bun.sleep(75);
    expect(attempts).toBe(count);
  } finally {
    tab.abort();
    await monitor.stop();
  }
});
