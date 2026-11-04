import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { deny, type HookEvent, type HookResult } from "./types.ts";

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit"];
const CODE_SUFFIXES = [
  ".go",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
];
const PACKAGE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const TEST_NAME = /(^|[._-])(test|tests|spec)([._-]|$)/i;
const CONFIG_NAME = /(\.config\.[a-z]+|^\.[a-z0-9-]+rc(\.[a-z]+)?)$/i;
const TEST_DIRS = ["test", "tests", "__tests__", "testdata", "fixtures", "eval", ".claude"];
const TEST_COMMAND =
  /^(?:go\s+test|make\s+(?:test|check|verify)\S*|(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\S*|(?:npx\s+|pnpm\s+exec\s+|bunx\s+)?(?:vitest|jest|pytest)\b|python3?\s+-m\s+pytest|\S*\.test\.sh|\S*\.claude\/verify)\b/;
const STRIKE_LIMIT = 2;

export type TddState = {
  counter: number;
  testEdits: Record<string, number>;
  testRunAt: number;
  strikes: Record<string, number>;
};
export const emptyState = (): TddState => ({
  counter: 0,
  testEdits: {},
  testRunAt: 0,
  strikes: {},
});

const isTest = (path: string) => TEST_NAME.test(basename(path));
const inTestDir = (path: string) =>
  dirname(path)
    .split(sep)
    .some((part) => TEST_DIRS.includes(part));
const isCode = (path: string) =>
  CODE_SUFFIXES.includes(extname(path)) && !CONFIG_NAME.test(basename(path));

function scopeOf(path: string): string {
  if (!PACKAGE_SUFFIXES.includes(extname(path))) return dirname(path);
  for (let dir = dirname(path); dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return dirname(path);
}

const ranTest = (command: string) =>
  command
    .split(/\|\||&&|;|\|/)
    .some((segment) => TEST_COMMAND.test(segment.trim().replace(/^(?:cd\s+\S+\s*)/, "")));

function record(state: TddState, event: HookEvent) {
  const input = event.tool_input ?? {};
  if (EDIT_TOOLS.includes(event.tool_name ?? "") && input.file_path) {
    const path = resolve(event.cwd ?? ".", input.file_path);
    if (!isTest(path)) return;
    state.testEdits[scopeOf(path)] = ++state.counter;
    state.strikes = {};
  } else if (event.tool_name === "Bash" && ranTest(input.command ?? "")) {
    state.testRunAt = ++state.counter;
    state.strikes = {};
  }
}

function gate(state: TddState, event: HookEvent): HookResult {
  const input = event.tool_input ?? {};
  if (!EDIT_TOOLS.includes(event.tool_name ?? "") || !input.file_path) return null;
  const path = resolve(event.cwd ?? ".", input.file_path);
  if (!isCode(path) || isTest(path) || inTestDir(path)) return null;
  const editedAt = state.testEdits[scopeOf(path)];
  if (editedAt && state.testRunAt > editedAt) return null;
  const strikes = (state.strikes[path] ?? 0) + 1;
  state.strikes[path] = strikes;
  if (strikes > STRIKE_LIMIT) {
    return {
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: `tdd-guard let ${basename(path)} through after ${STRIKE_LIMIT} refusals; write its test next.`,
        },
      },
    };
  }
  return deny(
    `TDD: edit or add a failing test beside ${basename(path)} first, run the tests and see it fail, then edit ${basename(path)}.`,
  );
}

export function decide(event: HookEvent, state: TddState): HookResult {
  if (event.hook_event_name === "PostToolUse") {
    record(state, event);
    return null;
  }
  return event.hook_event_name === "PreToolUse" ? gate(state, event) : null;
}

export function decideWithStateFile(event: HookEvent): HookResult {
  if (process.env.CLAUDE_LITE_TDD === "0") return null;
  const dir = process.env.CLAUDE_LITE_STATE_DIR ?? join(homedir(), ".cache", "claude-lite", "tdd");
  const file = join(dir, `${event.session_id ?? "nosession"}.json`);
  const state: TddState = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : emptyState();
  const result = decide(event, state);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(state));
  return result;
}
