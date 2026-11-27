import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { collectReport, reportLines } from "./report-data.ts";
import { renderReport } from "./report-view.ts";

export async function report(userHome: string, home: string, allModels = false) {
  const data = await collectReport(userHome, home, allModels);
  const path = join(userHome, ".cache", "claude-lite", "reports", "latest.html");
  await mkdir(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID();
  try {
    await writeFile(temp, renderReport(data), { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
  for (const line of reportLines(data)) console.log(line);
  console.log(path);
  if (process.platform === "darwin" && process.stdout.isTTY)
    await Bun.spawn(["open", path], { stdout: "ignore", stderr: "ignore" }).exited;
  return 0;
}
