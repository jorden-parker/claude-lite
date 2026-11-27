import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { collectReport, reportLines, type DiagnosticReport } from "./report-data.ts";
import { renderReport } from "./report-view.ts";
import { ReportCache } from "./report-cache.ts";
import { startReportMonitor } from "./report-live.ts";

async function saveSnapshot(path: string, data: DiagnosticReport) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID();
  try {
    await writeFile(temp, renderReport(data), { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function openReport(target: string) {
  if (process.platform === "darwin" && process.stdout.isTTY)
    await Bun.spawn(["open", target], { stdout: "ignore", stderr: "ignore" }).exited;
}

export async function report(
  userHome: string,
  home: string,
  allModels = false,
  live = Boolean(process.stdout.isTTY),
) {
  const cache = live ? new ReportCache() : undefined;
  const collect = () => collectReport(userHome, home, allModels, cache);
  const data = await collect();
  const path = join(userHome, ".cache", "claude-lite", "reports", "latest.html");
  await saveSnapshot(path, data);
  if (!live) {
    for (const line of reportLines(data)) console.log(line);
    console.log(path);
    await openReport(path);
    return 0;
  }

  const monitor = startReportMonitor(data, collect);
  const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    console.log(monitor.url);
    console.error("Live report running. Press Ctrl-C to save the latest snapshot and exit.");
    await openReport(monitor.url);
    await stopped;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await monitor.stop();
    await saveSnapshot(path, monitor.latest());
  }
  return 0;
}
