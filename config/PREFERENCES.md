# Coding preferences

Hooks check these after every edit and before you finish. A failed check blocks
you until it is fixed.

## Code style

These rules apply to every project and every language, with no exceptions.

- Self-describing code: a name says what it holds or does, so the structure
  explains itself. Not `tmp`, `data2`, `obj`, `handleStuff`, `utils.ts`:
  `parsedConfig`, `retryCount`, `closeIdleSockets`, `profile-rules.ts`.
- Keep designs simple: SOLID, KISS, YAGNI. Add only what the task needs.
- No comments, including lint suppressions. Rewrite unclear code instead.
  (enforced by the edit-check hook)
- Small functions that do one thing.
- Formatting and lint rules come from the project's own configs. (enforced by
  gofmt, go vet, prettier, eslint, ruff, shellcheck)

## Workflow

- TDD: write a failing test, make it pass with the smallest change, refactor.
  (enforced by the tdd-guard hook: a code file can be edited only after a test in
  its package was edited and a test command ran)
- Tests must pass before you finish.
- TS/JS: Fallow runs before you finish. Fix its findings; use
  `npx fallow explain <issue-type>` when unclear; remove dead code, never
  suppress it. (enforced by the fallow-stop hook)

## Before committing

- Find the checks: CLAUDE.md/README commands, `package.json` scripts, Makefile,
  CI workflows. Run them fast to slow: lint, typecheck, tests, build.
- Dev server: reuse a running one, or start it in the background. Wait until it
  serves, request the pages or endpoints you changed, grep its log for errors,
  and stop it if you started it.
- Next.js 16+: reuse the server in `.next/dev/lock`. Check
  `get_compilation_issues`, and with the page open in a browser, `get_errors`
  through `/_next/mcp` (next-devtools-mcp, or curl). Also run
  `next typegen && tsc --noEmit`.
- On failure, fix it and re-run all the checks, up to 3 rounds. Then stop and
  report the command and its output. Never commit with a failing check, never
  use `--no-verify`, and never skip or delete tests. (enforced by the
  commit-guard hook)

## Token discipline

- Grep/Glob before Read. Read only the line range you need.
- Bound shell output: `| head -50`, `-n 20`, `--oneline`, `-q`.
- One targeted search beats several broad ones.
- Wide searches go to a subagent; keep only its conclusion.
- Lead with the result. No preamble, no recap.
