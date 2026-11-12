import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type TaskOutcome = { name: string; failure: string | null };
type BenchSummary = { passed: number; total: number; generationTokensPerSecond: number };
type BenchRecord = { model: string; tasks: TaskOutcome[]; summary: BenchSummary };
type SavedBench = BenchRecord & { savedAt: string };

function unusedPath(dir: string, stem: string): string {
  let copy = 1;
  while (existsSync(join(dir, `${stem}-${copy}.json`))) copy++;
  return join(dir, `${stem}-${copy}.json`);
}

export function saveBench(dir: string, record: BenchRecord, now: Date): string {
  const savedAt = now.toISOString();
  const stem = `${savedAt.replace(/[:.]/g, "-")}-${record.model.replace(/[^\w.-]/g, "_")}`;
  mkdirSync(dir, { recursive: true });
  const savedPath = unusedPath(dir, stem);
  writeFileSync(savedPath, JSON.stringify({ ...record, savedAt }, null, 2));
  return savedPath;
}

export function latestBench(dir: string, model: string): SavedBench | null {
  if (!existsSync(dir)) return null;
  const saved: SavedBench[] = readdirSync(dir)
    .sort()
    .map((fileName) => JSON.parse(readFileSync(join(dir, fileName), "utf8")));
  return saved.filter((entry) => entry.model === model).at(-1) ?? null;
}

function passCounts(tasks: TaskOutcome[]): Map<string, string> {
  const counts = new Map<string, [number, number]>();
  for (const task of tasks) {
    const [passed, total] = counts.get(task.name) ?? [0, 0];
    counts.set(task.name, [passed + (task.failure === null ? 1 : 0), total + 1]);
  }
  return new Map([...counts].map(([name, [passed, total]]) => [name, `${passed}/${total}`]));
}

export function compareBench(previous: SavedBench, current: BenchRecord): string {
  const [before, after] = [previous.summary, current.summary];
  const countsBefore = passCounts(previous.tasks);
  const changed = [...passCounts(current.tasks)]
    .filter(([name, counts]) => countsBefore.get(name) !== counts)
    .map(([name, counts]) => `${name} ${countsBefore.get(name) ?? "0/0"} -> ${counts}`);
  return [
    `compared with ${previous.savedAt}`,
    `quality ${before.passed}/${before.total} -> ${after.passed}/${after.total}`,
    `generation ${before.generationTokensPerSecond.toFixed(1)} -> ${after.generationTokensPerSecond.toFixed(1)} t/s`,
    ...changed,
  ].join("\n");
}
