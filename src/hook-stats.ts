type LogEntry = {
  hook: string;
  decision?: string;
  reason?: string;
  exitCode?: number;
  stderr?: string;
  crashed?: string;
  hiddenLines?: number;
};
type HookTotals = { decisions: number; blocked: number; crashed: number; hiddenLines: number };

function parseEntries(logText: string): LogEntry[] {
  return logText.split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry?.hook ? [entry as LogEntry] : [];
    } catch {
      return [];
    }
  });
}

const isBlocked = (entry: LogEntry) => entry.decision === "deny" || entry.exitCode === 2;

function totalsByHook(entries: LogEntry[]): Map<string, HookTotals> {
  const totals = new Map<string, HookTotals>();
  for (const entry of entries) {
    const hookTotals = totals.get(entry.hook) ?? {
      decisions: 0,
      blocked: 0,
      crashed: 0,
      hiddenLines: 0,
    };
    hookTotals.decisions += 1;
    hookTotals.blocked += isBlocked(entry) ? 1 : 0;
    hookTotals.crashed += entry.crashed ? 1 : 0;
    hookTotals.hiddenLines += entry.hiddenLines ?? 0;
    totals.set(entry.hook, hookTotals);
  }
  return totals;
}

const totalsLine = ([hook, totals]: [string, HookTotals]) =>
  `${hook}: ${totals.decisions} decisions, ${totals.blocked} blocked, ${totals.crashed} crashed, ${totals.hiddenLines} lines hidden`;

const MAX_REASONS = 5;

function topReasons(entries: LogEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries.filter(isBlocked)) {
    const reason = (entry.reason ?? entry.stderr ?? "no reason").split("\n")[0];
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts]
    .sort(([, left], [, right]) => right - left)
    .slice(0, MAX_REASONS)
    .map(([reason, count]) => `${count}x ${reason}`);
}

export function summarizeHookLog(logText: string): string {
  const entries = parseEntries(logText);
  if (entries.length === 0) return "no hook decisions logged";
  const hookLines = [...totalsByHook(entries)]
    .sort(([, left], [, right]) => right.decisions - left.decisions)
    .map(totalsLine);
  return [...hookLines, "most frequent block reasons:", ...topReasons(entries)].join("\n");
}
