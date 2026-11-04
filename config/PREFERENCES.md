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

## Token discipline

- Grep/Glob before Read. Read only the line range you need.
- Bound shell output: `| head -50`, `-n 20`, `--oneline`, `-q`.
- One targeted search beats several broad ones.
- Wide searches go to a subagent; keep only its conclusion.
- Lead with the result. No preamble, no recap.
