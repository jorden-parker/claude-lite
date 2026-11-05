# claude-lite

TypeScript + Bun: guard hooks, Ollama launcher, installer. See README.md for usage.

## Commands

- `bun test`: run tests (`test/*.test.ts`)
- `bun run lint`: oxlint plus `oxfmt --check`; `bun run format` writes fixes
- `bun run typecheck`: `tsc`
- `bun run build`: compiles `src/cli.ts` to `dist/claude-lite`

## Architecture

- `src/cli.ts`: entry point and subcommand dispatch (`install`, `update`, `build`, `uninstall`, `doctor`, `logs`, `servers`, `fix-servers`, `settings`, `ollama`, `hook <name>`)
- `src/install.ts`: lifecycle commands, Ollama server checks, `settings` merge (`mergeSettings`)
- `src/help.ts`: `COMMAND_HELP`/`USAGE`; `src/completion.ts`: shell completion; `src/home.ts`: `liteHome()` (`CLAUDE_LITE_HOME` or the checkout)
- `src/permissions-opt-out.ts`: `optsOut` and `withOptOutsFor` for `CLAUDE_LITE_NO_PERMISSIONS` and `CLAUDE_LITE_NO_SANDBOX`
- `src/hooks/`: each hook is a pure `decide(event)` function. I/O lives only in `run-hook.ts`, which logs decisions to `~/.cache/claude-lite/hooks.log`. `comments.ts` is shared comment detection for edit-check and tdd-guard, not a hook.
- `src/ollama/`: Modelfile and settings rendering, size table, launcher; `size-overrides.ts` layers env (`applyEnv`) and flags (`applyFlags`) over a size
- `config/`: `hooks.json` wires hooks, `sizes.json` defines model sizes (thinking, effort, permissions, sandbox), `local-sizes.json` (gitignored) overlays it, `system-prompt.md` is injected on launch, `personal-settings.json` is the base for `settings`, `local-settings.json` (gitignored) overlays it, `ollama-base.json` is the base for `ollama`, `PREFERENCES.md` is @-imported into `~/.claude/CLAUDE.md` by install

## Gotchas

- Adding a hook means a new `src/hooks/<name>.ts`, an entry in the `HOOKS` map in `run-hook.ts`, an entry in `config/hooks.json`, and a `test/<name>.test.ts`.
- `install`, `uninstall`, `update`, `build`, `doctor`, `logs`, `servers`, `settings` and `fix-servers` share the signature `(userHome, home, run?) => Promise<number>` and dispatch through `LIFECYCLE` in `cli.ts`. A new lifecycle command goes in `src/install.ts` and that map.
- `COMMAND_HELP` in `src/help.ts` is the only command list. `USAGE`, shell completion and the `LIFECYCLE` typing derive from it, so a new subcommand needs an entry there and `bun run typecheck` fails if `LIFECYCLE` disagrees.
- `install` owns the `~/.local/bin/cl` symlink to `dist/claude-lite`; `uninstall` removes it only when it points at this checkout. `update` is pull, build, then the fresh binary's `install`.
- Commits go through husky, lint-staged and commitlint, so use conventional commit messages.
- `dist/` is build output. Bun leaves `.*.bun-build` temp files in the repo root and they are gitignored. Don't commit them.
- `cl ollama` curls `localhost:11434/api/version` before `ollama show`, so the launcher's first `Runner` call is `curl`. It exits 1 when Ollama is down.
- A new environment variable needs a row in README's Environment variables table.
- A new `cl ollama` flag goes in `FLAGS` in `size-overrides.ts` (completion derives from it), `COMMAND_HELP.ollama` and the README flag list.
- Hooks run inside user sessions and fail open: unparseable stdin exits 0. The only stdout is the hook's JSON output.
