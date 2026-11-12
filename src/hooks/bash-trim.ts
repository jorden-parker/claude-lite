import type { HookEvent, HookResult } from "./types.ts";

const MAX_LINES = 150;
const HEAD_LINES = 30;
const TAIL_LINES = 60;
const MAX_SIGNAL_LINES = 40;
const MAX_LINE_CHARS = 400;
const SIGNAL = /error|fail|panic|traceback|exception|fatal|assert/i;
const SUMMARY =
  /^(?:ok|PASS|FAIL)\b|\b\d+ (?:passed|failed|skipped|total)\b|^Tests:|^Test Suites:|^=+ .* =+$/;

const clip = (line: string) =>
  line.length <= MAX_LINE_CHARS
    ? line
    : `${line.slice(0, MAX_LINE_CHARS)} … [${line.length - MAX_LINE_CHARS} chars hidden]`;

function trimLines(lines: string[]): string[] {
  if (lines.length <= MAX_LINES) return lines;
  const middle = lines.slice(HEAD_LINES, -TAIL_LINES);
  const signals = middle
    .filter((line) => SIGNAL.test(line) || SUMMARY.test(line))
    .slice(0, MAX_SIGNAL_LINES);
  const marker = `[bash-trim: ${middle.length - signals.length} lines hidden from lines ${HEAD_LINES + 1}-${lines.length - TAIL_LINES}; rerun piped through grep or sed -n to see them]`;
  return [...lines.slice(0, HEAD_LINES), ...signals, marker, ...lines.slice(-TAIL_LINES)];
}

const trimText = (text: string) => trimLines(text.split("\n")).map(clip).join("\n");

const HIDDEN_COUNT = /\[bash-trim: (\d+) lines hidden/;
const hiddenIn = (text: unknown) => Number(HIDDEN_COUNT.exec(String(text))?.[1] ?? 0);

export function decide(event: HookEvent): HookResult {
  const response = event.tool_response;
  if (event.tool_name !== "Bash" || !response || typeof response !== "object") return null;
  const trimmed: Record<string, any> = { ...response };
  for (const stream of ["stdout", "stderr"]) {
    if (typeof response[stream] === "string") trimmed[stream] = trimText(response[stream]);
  }
  if (JSON.stringify(trimmed) === JSON.stringify(response)) return null;
  return {
    output: { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: trimmed } },
    hiddenLines: hiddenIn(trimmed.stdout) + hiddenIn(trimmed.stderr),
  };
}
