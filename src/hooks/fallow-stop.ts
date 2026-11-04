import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { defaultRun, nearestDirWith, type Run } from "./edit-check.ts";
import type { HookEvent, HookResult } from "./types.ts";

const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const MAX_LINES = 15;
const LOCAL_BIN = join("node_modules", ".bin", "fallow");
const HINT =
  "Run fallow explain <rule> for any you don't understand; delete dead code, don't suppress it.";

const onPath = () => spawnSync("which", ["fallow"], { encoding: "utf8" }).status === 0;

function defaultBinFor(cwd: string): string | null {
  const root = nearestDirWith(cwd, [LOCAL_BIN]);
  if (root) return join(root, LOCAL_BIN);
  return onPath() ? "fallow" : null;
}

function changedScript(cwd: string, run: Run): boolean {
  const status = run(["git", "status", "--porcelain"], cwd);
  if (!status?.ok) return false;
  return status.output.split("\n").some((line) => SCRIPT_FILE.test(line.trim()));
}

function baseArgs(cwd: string, run: Run): string[] {
  for (const branch of ["main", "master"]) {
    if (run(["git", "rev-parse", "--verify", "--quiet", branch], cwd)?.ok) {
      return ["--base", branch];
    }
  }
  return [];
}

function report(output: string): string {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  const shown = lines.slice(0, MAX_LINES);
  const hidden = lines.length - shown.length;
  return [...shown, ...(hidden > 0 ? [`[${hidden} more]`] : []), HINT].join("\n");
}

export function decideFallowStop(
  event: HookEvent,
  run: Run = defaultRun,
  binFor: (cwd: string) => string | null = defaultBinFor,
): HookResult {
  const cwd = event.cwd;
  if (!cwd || event.stop_hook_active) return null;
  if (!changedScript(cwd, run)) return null;
  const bin = binFor(cwd);
  if (!bin) return null;
  const audit = run([bin, "audit", "--format", "compact", "--quiet", ...baseArgs(cwd, run)], cwd);
  if (audit?.status !== 1) return null;
  return { exitCode: 2, stderr: report(audit.output) };
}
