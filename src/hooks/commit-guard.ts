import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMAND_START, GIT_OPTIONS } from "./bash-guard.ts";
import { defaultRun, type Run } from "./edit-check.ts";
import { deny, type HookEvent, type HookResult } from "./types.ts";

type ReadText = (path: string) => string | null;
type Issue = { severity?: string; title?: string; filePath?: string };

const COMMIT = new RegExp(`${COMMAND_START}git\\s+${GIT_OPTIONS}commit\\b[^;&|)\\n\`]*`);
const SKIP_HOOKS = /\s(?:--no-verify|-[a-mo-zA-Z]*n[a-zA-Z]*)(?=\s|$)/;
const SCRIPT_ORDER = ["lint", "typecheck", "test"];
const LOCKFILE_RUNNERS: [string, string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];
const BLOCKING_SEVERITIES = ["fatal", "error", "bug"];
const MAX_ISSUES = 15;
const TAIL_LINES = 30;
const MCP_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "get_compilation_issues", arguments: {} },
});

const readFileText: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

function parseJson(text: string | null): any {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function runnerFor(root: string, readText: ReadText): string {
  const found = LOCKFILE_RUNNERS.find(([lockfile]) => readText(join(root, lockfile)) !== null);
  return found?.[1] ?? "npm";
}

function failedScript(root: string, manifest: any, run: Run, readText: ReadText): string | null {
  const runner = runnerFor(root, readText);
  for (const script of SCRIPT_ORDER.filter((name) => manifest.scripts?.[name])) {
    const result = run([runner, "run", script], root);
    if (result?.ok) continue;
    const tail = (result?.output ?? "").split("\n").slice(-TAIL_LINES).join("\n");
    return `\`${runner} run ${script}\` failed; fix it before committing.\n${tail}`;
  }
  return null;
}

function hasPreCommitHook(root: string, run: Run, readText: ReadText): boolean {
  const located = run(["git", "rev-parse", "--git-path", "hooks/pre-commit"], root);
  if (!located?.ok) return false;
  return readText(resolve(root, located.output.trim())) !== null;
}

function compilationIssues(output: string): Issue[] | null {
  const dataLine = output.split("\n").find((line) => line.startsWith("data:"));
  const text = parseJson(dataLine?.slice(5).trim() ?? null)?.result?.content?.[0]?.text;
  const issues = parseJson(text ?? null)?.issues;
  return Array.isArray(issues) ? issues : null;
}

function nextDevServerProblem(root: string, run: Run, readText: ReadText): string | null {
  const lock = parseJson(readText(join(root, ".next/dev/lock")));
  if (!lock?.port) {
    return "Start `next dev` in the background, open the pages you changed in a browser, then commit again.";
  }
  const url = `http://localhost:${lock.port}/_next/mcp`;
  const headers = ["Content-Type: application/json", "Accept: application/json, text/event-stream"];
  const reply = run(
    [
      "curl",
      "-s",
      "-m",
      "60",
      "-X",
      "POST",
      ...headers.flatMap((h) => ["-H", h]),
      "-d",
      MCP_BODY,
      url,
    ],
    root,
  );
  if (!reply?.ok) return "The dev server in .next/dev/lock isn't responding; restart `next dev`.";
  const blocking = (compilationIssues(reply.output) ?? []).filter((issue) =>
    BLOCKING_SEVERITIES.includes(issue.severity ?? ""),
  );
  if (blocking.length === 0) return null;
  const listed = blocking.slice(0, MAX_ISSUES).map((i) => `${i.title} (${i.filePath})`);
  return `next dev reports compilation errors; fix them before committing:\n${listed.join("\n")}`;
}

function projectProblem(root: string, run: Run, readText: ReadText): string | null {
  const manifest = parseJson(readText(join(root, "package.json")));
  if (!manifest) return null;
  const scriptProblem = hasPreCommitHook(root, run, readText)
    ? null
    : failedScript(root, manifest, run, readText);
  if (scriptProblem) return scriptProblem;
  const usesNext = manifest.dependencies?.next || manifest.devDependencies?.next;
  return usesNext ? nextDevServerProblem(root, run, readText) : null;
}

export function decide(
  event: HookEvent,
  run: Run = defaultRun,
  readText: ReadText = readFileText,
): HookResult {
  const command = event.tool_input?.command ?? "";
  const commit = COMMIT.exec(command);
  if (!commit || process.env.CLAUDE_LITE_COMMIT_GUARD === "0") return null;
  if (SKIP_HOOKS.test(commit[0])) {
    return deny("Don't skip hooks with --no-verify; fix the failing check instead.");
  }
  const cwd = event.cwd ?? process.cwd();
  const top = run(["git", "rev-parse", "--show-toplevel"], cwd);
  if (!top?.ok) return null;
  const problem = projectProblem(top.output.trim(), run, readText);
  return problem ? deny(problem) : null;
}
