# claude-lite

TypeScript + Bun: guard hooks, Ollama launcher, installer. See README.md for usage.

## Commands

- `bun test`: run tests (`test/*.test.ts`)
- `bun run lint`: oxlint plus `oxfmt --check`; `bun run format` writes fixes
- `bun run typecheck`: `tsc`
- `bun run build`: compiles `src/cli.ts` to `dist/claude-lite`

## Architecture

- `src/cli.ts`: entry point and subcommand dispatch (`install`, `update`, `uninstall`, `ollama`, `hook <name>`)
- `src/hooks/`: each hook is a pure `decide(event)` function. I/O lives only in `run-hook.ts`.
- `src/ollama/`: Modelfile and settings rendering, size table, launcher
- `config/`: `hooks.json` wires hooks, `sizes.json` defines model sizes, `system-prompt.md` is injected on launch

## Gotchas

- Adding a hook means a new `src/hooks/<name>.ts`, an entry in the `HOOKS` map in `run-hook.ts`, an entry in `config/hooks.json`, and a `test/<name>.test.ts`.
- `install`, `uninstall` and `update` share the signature `(userHome, home, run?) => Promise<number>` and dispatch through `LIFECYCLE` in `cli.ts`. A new lifecycle command goes in `src/install.ts` and that map.
- `install` owns the `~/.local/bin/cl` symlink to `dist/claude-lite`; `uninstall` removes it only when it points at this checkout. `update` is pull, build, then the fresh binary's `install`.
- Commits go through husky, lint-staged and commitlint, so use conventional commit messages.
- `dist/` is build output. Bun leaves `.*.bun-build` temp files in the repo root and they are gitignored. Don't commit them.
- Hooks run inside user sessions and fail open: unparseable stdin exits 0. The only stdout is the hook's JSON output.
