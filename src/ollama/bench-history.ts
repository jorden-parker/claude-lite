import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type TaskOutcome = { name: string; failure: string | null };
type BenchSummary = { passed: number; total: number; generationTokensPerSecond: number | null };
type Turn = { task: string; turnSeconds?: number; toolCallSeconds?: number };
type BenchRecord = {
  model: string;
  backend?: string;
  engine?: string;
  turns?: Turn[];
  tasks: TaskOutcome[];
  summary: BenchSummary;
};
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

export function latestBench(dir: string, model: string, backend = "ollama"): SavedBench | null {
  if (!existsSync(dir)) return null;
  const saved: SavedBench[] = readdirSync(dir)
    .sort()
    .map((fileName) => JSON.parse(readFileSync(join(dir, fileName), "utf8")));
  return (
    saved
      .filter((entry) => entry.model === model && (entry.backend ?? "ollama") === backend)
      .at(-1) ?? null
  );
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
    `compared with ${previous.savedAt}${previous.engine ? " (" + previous.engine + ")" : ""}`,
    `quality ${before.passed}/${before.total} -> ${after.passed}/${after.total}`,
    `generation ${before.generationTokensPerSecond?.toFixed(1) ?? "n/a"} -> ${after.generationTokensPerSecond?.toFixed(1) ?? "n/a"} t/s`,
    ...(current.turns ?? []).flatMap((turn) => {
      const prior = previous.turns?.find((value) => value.task === turn.task);
      if (!prior) return [];
      const metrics = [
        ["turnSeconds", "turn"],
        ["toolCallSeconds", "usable tool call"],
      ] as const;
      return metrics.flatMap(([field, label]) => {
        const before = prior[field];
        const after = turn[field];
        if (before === undefined || after === undefined || before <= 0) return [];
        const change = (after / before - 1) * 100;
        return [
          `${turn.task} ${label} ${before.toFixed(2)} -> ${after.toFixed(2)} s (${change > 0 ? "+" : ""}${change.toFixed(1)}%)`,
        ];
      });
    }),
    ...changed,
  ].join("\n");
}
