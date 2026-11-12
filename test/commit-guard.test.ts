import { expect, test } from "bun:test";
import { decide } from "../src/hooks/commit-guard.ts";

type Reply = { ok: boolean; output: string } | null;
type Setup = {
  files?: Record<string, string>;
  scripts?: Record<string, Reply>;
  curl?: Reply;
};

const commitEvent = (command = "git commit -m x") => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  cwd: "/repo",
  tool_input: { command },
});

const packageJson = (scripts: string[], next = false) =>
  JSON.stringify({
    scripts: Object.fromEntries(scripts.map((name) => [name, "x"])),
    dependencies: next ? { next: "16.0.0" } : {},
  });

const mcpReply = (payload: unknown): Reply => ({
  ok: true,
  output: `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(payload) }] } })}\n\n`,
});

function harness({ files = {}, scripts = {}, curl = null }: Setup) {
  const run = (command: string[]): Reply => {
    if (command[0] === "git" && command[1] === "rev-parse") {
      return {
        ok: true,
        output: command.includes("--show-toplevel") ? "/repo\n" : "/repo/.git/hooks/pre-commit\n",
      };
    }
    if (command[0] === "curl") return curl;
    return scripts[command[2]] ?? { ok: true, output: "" };
  };
  const readText = (path: string) => files[path] ?? null;
  return { run, readText };
}

const decideWith = (setup: Setup, command?: string) => {
  const { run, readText } = harness(setup);
  return decide(commitEvent(command), run, readText);
};

const reason = (result: ReturnType<typeof decide>) =>
  (result?.output as any)?.hookSpecificOutput?.permissionDecisionReason ?? "";

const lock = { "/repo/.next/dev/lock": JSON.stringify({ pid: 1, port: 3000 }) };
const nextProject = { "/repo/package.json": packageJson([], true) };

test("ignores non-commit commands", () => expect(decideWith({}, "git status")).toBeNull());

test("denies --no-verify", () =>
  expect(reason(decideWith({}, "git commit --no-verify -m x"))).toContain("--no-verify"));

test("denies a failing lint script", () => {
  const result = decideWith({
    files: { "/repo/package.json": packageJson(["lint", "test"]) },
    scripts: { lint: { ok: false, output: "bad style" } },
  });
  expect(reason(result)).toContain("lint");
  expect(reason(result)).toContain("bad style");
});

test("skips scripts when a pre-commit hook exists", () =>
  expect(
    decideWith({
      files: {
        "/repo/package.json": packageJson(["lint"]),
        "/repo/.git/hooks/pre-commit": "#!/bin/sh",
      },
      scripts: { lint: { ok: false, output: "bad" } },
    }),
  ).toBeNull());

test("denies a Next project with no dev server lock", () =>
  expect(reason(decideWith({ files: nextProject }))).toContain("next dev"));

test("denies error-severity compilation issues", () => {
  const issues = [{ severity: "error", title: "Parse failed", filePath: "app/page.tsx" }];
  const result = decideWith({ files: { ...nextProject, ...lock }, curl: mcpReply({ issues }) });
  expect(reason(result)).toContain("Parse failed");
});

test("passes warning-only issues", () => {
  const issues = [{ severity: "warning", title: "w", filePath: "a.ts" }];
  expect(decideWith({ files: { ...nextProject, ...lock }, curl: mcpReply({ issues }) })).toBeNull();
});

test("denies when the dev server does not respond", () =>
  expect(
    reason(decideWith({ files: { ...nextProject, ...lock }, curl: { ok: false, output: "" } })),
  ).toContain("isn't responding"));

test("passes an error reply such as webpack", () =>
  expect(
    decideWith({ files: { ...nextProject, ...lock }, curl: mcpReply({ error: "webpack" }) }),
  ).toBeNull());

test("passes when opted out", () => {
  process.env.CLAUDE_LITE_COMMIT_GUARD = "0";
  try {
    expect(decideWith({}, "git commit --no-verify -m x")).toBeNull();
  } finally {
    delete process.env.CLAUDE_LITE_COMMIT_GUARD;
  }
});

test("allows -n inside a quoted commit message", () =>
  expect(decideWith({}, 'git commit -m "add -n flag"')).toBeNull());

test.each([
  "HUSKY=0 git commit -m x",
  "env git commit --no-verify -m x",
  "git -c core.hooksPath=/dev/null commit -m x",
  'git commit -m "one; two" --no-verify',
])("denies hook skipping in %s", (command) =>
  expect(reason(decideWith({}, command))).toContain("fix the failing check"),
);
