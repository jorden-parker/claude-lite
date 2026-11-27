import { stat } from "node:fs/promises";
import type { SessionInventory } from "./report-session.ts";

type Source = "claude" | "qwen" | "opencode";
type History = SessionInventory & {
  launches?: { model: string; callId: string }[];
  retry?: boolean;
};
type Entry = { signature: string; association: string | undefined; history: History };

async function fingerprint(path: string, optional = false) {
  try {
    const s = await stat(path, { bigint: true });
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return undefined;
  }
}

async function signature(path: string, source: Source) {
  const parts = await Promise.all([
    fingerprint(path),
    ...(source === "opencode"
      ? [fingerprint(path + "-wal", true), fingerprint(path + "-journal", true)]
      : []),
  ]);
  if (!parts.includes(undefined)) return parts.join("/");
}

export class ReportCache {
  private sources = new Map<Source, { scope: string | undefined; files: Map<string, Entry> }>();

  scan(source: Source, models: Set<string> | undefined) {
    const scope = models && JSON.stringify([...models].sort());
    const previous = this.sources.get(source);
    // Each directory walk retains only files it encounters, even across overlapping scans.
    const current = new Map<string, Entry>();
    this.sources.set(source, { scope, files: current });
    return async (path: string, association: string | undefined, read: () => Promise<History>) => {
      const before = await signature(path, source);
      const hit = previous && previous.scope === scope ? previous.files.get(path) : undefined;
      if (hit && before === hit.signature && association === hit.association) {
        current.set(path, hit);
        return structuredClone(hit.history);
      }
      const history = await read();
      // A writer can append, replace or checkpoint the file while it is being parsed.
      if (!history.retry && before && before === (await signature(path, source))) {
        current.set(path, { signature: before, association, history: structuredClone(history) });
      }
      return history;
    };
  }
}

export function historyReader(
  cache: ReportCache | undefined,
  source: Source,
  models: Set<string> | undefined,
) {
  return (
    cache?.scan(source, models) ??
    ((_path: string, _association: string | undefined, read: () => Promise<History>) => read())
  );
}
