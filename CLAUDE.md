# claude-lite

TypeScript + Bun: guard hooks, Ollama launcher, installer. See README.md for usage.

## Commands

- `bun test`: run tests (`test/*.test.ts`)
- `bun run lint`: oxlint plus `oxfmt --check`; `bun run format` writes fixes
- `bun run typecheck`: `tsc`
- `bun run build`: compiles `src/cli.ts` to `dist/claude-lite`

## Architecture

- `src/cli.ts`: entry point and subcommand dispatch (`install`, `update`, `build`, `uninstall`, `disable`, `enable`, `doctor`, `logs`, `servers`, `fix-servers`, `settings`, `stats`, `config`, `ollama`, `bench`, `hook <name>`)
- `src/install.ts`: lifecycle commands, Ollama server checks, `settings` merge (`mergeSettings`)
- `src/help.ts`: `COMMAND_HELP`/`USAGE`; `src/completion.ts`: shell completion; `src/home.ts`: `liteHome()` (`CLAUDE_LITE_HOME` or the checkout)
- `src/config-screen.ts`: `cl config`; pure `renderConfig`/`pressKey` over a `ConfigState`, plus `loadConfigState`/`saveConfigState` and the raw-terminal loop `runConfigScreen`. Writes `local-claude.json` (`model`, `effortLevel`, `sandbox.enabled`, `permissions.defaultMode`), `local-ollama.json` (`sandbox.enabled`, `permissions.defaultMode`) and `local-sizes.json` (`default`, `thinking`, `effort`, `output_tokens`); edit rows open `PREFERENCES.md`/`system-prompt.md` in `$VISUAL`/`$EDITOR`; a size with `"default": true` wins in `defaultSize`
- `src/hooks/`: each hook is a pure `decide(event)` function. I/O lives only in `run-hook.ts`, which logs decisions to `~/.cache/claude-lite/hooks.log`. `comments.ts` is shared comment detection for edit-check and tdd-guard, not a hook.
- `src/ollama/`: Modelfile and settings rendering, size table, launcher, bench; `size-overrides.ts` layers env (`applyEnv`) and flags (`applyFlags`) over a size; `sizes.ts` resolves the size (`resolveSize`) and picks the memory-aware default (`defaultSize`, from each size's `memory_gb`); `api.ts` is the only fetch client for Ollama (`load`, `chat`) and is injected into `launch` and `bench` so tests never touch a server; `bench.ts` holds the quality tasks and their pure `check` functions
- `config/`: `hooks.json` wires hooks, `sizes.json` defines model sizes (model, context, thinking, effort, parameters; no sandbox or permissions), `local-sizes.json` (gitignored) overlays it, `system-prompt.md` is injected on launch, `claude.json` is the base for `settings`, `local-claude.json` (gitignored) overlays it, `ollama.json` is the base for `ollama` (it denies `Agent`), `local-ollama.json` (gitignored) overlays it, `sandbox-secrets.json` lists the secret paths and env vars that both launch paths deny (`src/sandbox-secrets.ts` merges it), `PREFERENCES.md` is @-imported into `~/.claude/CLAUDE.md` by install

## Gotchas

- Adding a hook means a new `src/hooks/<name>.ts`, an entry in the `HOOKS` map in `run-hook.ts`, an entry in `config/hooks.json`, and a `test/<name>.test.ts`.
- `install`, `uninstall`, `update`, `build`, `disable`, `enable`, `doctor`, `logs`, `servers`, `settings`, `stats` and `fix-servers` share the signature `(userHome, home, run?) => Promise<number>` and dispatch through `LIFECYCLE` in `cli.ts`. A new lifecycle command goes in `src/install.ts` and that map.
- `COMMAND_HELP` in `src/help.ts` is the only command list. `USAGE`, shell completion and the `LIFECYCLE` typing derive from it, so a new subcommand needs an entry there and `bun run typecheck` fails if `LIFECYCLE` disagrees.
- `install` owns the `~/.local/bin/cl` symlink to `dist/claude-lite`; `uninstall` removes it only when it points at this checkout. `update` is pull, build, then the fresh binary's `install`.
- Commits go through husky, lint-staged and commitlint, so use conventional commit messages.
- `dist/` is build output. Bun leaves `.*.bun-build` temp files in the repo root and they are gitignored. Don't commit them.
- `cl ollama` curls `localhost:11434/api/version` before `ollama show`, so the launcher's first `Runner` call is `curl`. It exits 1 when Ollama is down, and after `ollama show` it loads the model through `api.load` and exits 1 with the fitting sizes when that fails.
- A new size in `config/sizes.json` needs `memory_gb` (what Ollama reports it requires at the size's context; `cl bench` or the load error tells you) or the memory-aware default ignores it, and `test/sizes.test.ts` pins which sizes fit 16 and 32 GB.
- `cl bench` tasks are checked by pure functions in `bench.ts`; a new task needs a pass and a fail case in `test/bench.test.ts`. Record its output before and after changing a size, its parameters or `config/system-prompt.md`.
- A new environment variable needs a row in README's Environment variables table.
- A new `cl ollama` flag goes in `FLAGS` in `size-overrides.ts` (completion derives from it), `COMMAND_HELP.ollama` and the README flag list.
- Hooks run inside user sessions and fail open: unparseable stdin exits 0. The only stdout is the hook's JSON output.
