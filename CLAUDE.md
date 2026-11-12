# claude-lite

TypeScript + Bun: Ollama launcher, bench, server checks and installer. See README.md for usage.

## Commands

- `bun test`: run tests (`test/*.test.ts`)
- `bun run lint`: oxlint plus `oxfmt --check`; `bun run format` writes fixes
- `bun run typecheck`: `tsc`
- `bun run build`: compiles `src/cli.ts` to `dist/claude-lite`
- `scripts/bench-variants.sh [size] [runs]`: benches baseline, temperature 0.4 and 32k-context overlays of a size, then restores `config/local-sizes.json`

## Architecture

- `src/cli.ts`: entry point and subcommand dispatch (`install`, `update`, `build`, `uninstall`, `doctor`, `logs`, `servers`, `fix-servers`, `config`, `ollama`, `mlx`, `bench`)
- `src/install.ts`: lifecycle commands, shell completion blocks, the `cl` link, Ollama server checks and the server env login agent
- `src/help.ts`: `COMMAND_HELP`/`USAGE`; `src/completion.ts`: shell completion; `src/home.ts`: `liteHome()` (`CLAUDE_LITE_HOME` or the checkout)
- `src/config-screen.ts`: `cl config`; pure `renderConfig`/`pressKey` over a `ConfigState`, plus `loadConfigState`/`saveConfigState` and the raw-terminal loop `runConfigScreen`. Writes `local-ollama.json` (`sandbox.enabled`, `permissions.defaultMode`) and `local-sizes.json` (`default`, `thinking`, `effort`, `output_tokens`); the system prompt row opens `system-prompt.md` in `$VISUAL`/`$EDITOR`; a size with `"default": true` wins in `defaultSize`
- `src/mlx.ts`: `cl mlx`; serves a size's `mlx` model with `uvx vllm-mlx` on port 8435 (`CLAUDE_LITE_MLX_PORT`) after unloading Ollama models (`unloadModels` in `api.ts`), then reuses `renderLaunchSettings`/`runClaude` from `launch.ts`. `startServer`, `run` and `unload` are injected so tests start nothing
- `src/json-overlay.ts`: `mergeSettings`/`withJsonOverlay`, the deep merge used for every gitignored `local-*.json`
- `src/sandbox-secrets.ts`: merges `config/sandbox-secrets.json` into the sandbox settings
- `src/ollama/`: Modelfile and settings rendering, size table, launcher, bench. `launch.ts` owns `ollamaBaseSettings` (ollama.json + local-ollama.json + shared secrets), the server status checks and `launch`; `settings.ts` `renderSettings` turns the base into the per-size settings; `size-overrides.ts` layers env (`applyEnv`) and flags (`applyFlags`) over a size; `sizes.ts` resolves the size (`resolveSize`) and picks the memory-aware default (`defaultSize`, from each size's `memory_gb`); `api.ts` is the only fetch client for Ollama (`load`, `chat`, `parameters`) and is injected into `launch` and `bench` so tests never touch a server; `bench.ts` holds the quality tasks and their pure `check` functions; `git-log-guard.ts` is the unbounded `git log` rule the bench's deny-recovery task scores against; `bench-history.ts` saves and compares runs
- `config/`: `sizes.json` defines model sizes (base, model, context, output_tokens, thinking, optional effort, parameters, memory_gb, optional mlx Hugging Face id for `cl mlx`; no sandbox or permissions), `local-sizes.json` (gitignored) overlays it, `system-prompt.md` is injected on launch, `ollama.json` is the base for `ollama` (it denies `Agent`), `local-ollama.json` (gitignored) overlays it, `sandbox-secrets.json` lists the secret paths and env vars the launcher denies

## Gotchas

- `install`, `uninstall`, `update`, `build`, `doctor`, `logs`, `servers`, `fix-servers` and `config` share the signature `(userHome, home, run?) => Promise<number>` and dispatch through `LIFECYCLE` in `cli.ts`. A new lifecycle command goes in `src/install.ts` and that map.
- `COMMAND_HELP` in `src/help.ts` is the only command list. `USAGE`, shell completion and the `LIFECYCLE` typing derive from it, so a new subcommand needs an entry there and `bun run typecheck` fails if `LIFECYCLE` disagrees.
- `install` writes only the completion blocks (zsh `.zshrc`, bash `.bashrc`, plus the completion files for each shell whose rc exists) and owns the `~/.local/bin/cl` symlink to `dist/claude-lite`; `uninstall` removes the blocks, completion files and link (the link only when it points at this checkout), the server env login agent `cl servers` writes, and also strips legacy claude-lite blocks from `~/.claude/CLAUDE.md` and the rc files. `update` is pull, build, then the fresh binary's `install`.
- Commits go through husky, lint-staged and commitlint, so use conventional commit messages.
- `dist/` is build output. Bun leaves `.*.bun-build` temp files in the repo root and they are gitignored. Don't commit them.
- `cl ollama` curls `/api/version` on the Ollama URL (`127.0.0.1:11434` unless `OLLAMA_HOST` is set) before `ollama show`, so the launcher's first `Runner` call is `curl`. It exits 1 when Ollama is down, and after `ollama show` it loads the model through `api.load` and exits 1 with the fitting sizes when that fails.
- A new size in `config/sizes.json` needs `memory_gb` (what Ollama reports it requires at the size's context; `cl bench` or the load error tells you) or the memory-aware default ignores it, and `test/sizes.test.ts` pins which sizes fit 16 and 32 GB.
- `cl bench` tasks are checked by pure functions in `bench.ts`; a new task needs a pass and a fail case in `test/bench.test.ts`. Record its output before and after changing a size, its parameters or `config/system-prompt.md`.
- A new environment variable needs a row in README's Environment variables table.
- A new `cl ollama` flag goes in `FLAGS` in `size-overrides.ts` (completion derives from it), `COMMAND_HELP.ollama` and the README flag list.
- Personal Claude settings (model, effort, permissions, sandbox) are not in this repo. They live in `~/.claude/settings.json`; claude-lite must not wrap `claude`.
