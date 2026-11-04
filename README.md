# claude-lite

A small TypeScript + Bun take on claude-custom: guard hooks, an Ollama launcher, and an installer. No UI.

## Install

    bun install && bun run build      # dist/claude-lite
    dist/claude-lite install          # CLAUDE.md @-import + `claude` function in rc files (backs up each file)
    dist/claude-lite uninstall        # removes only its own marked blocks

## Launch on Ollama

    claude-lite ollama [27b|35b] [claude args]
    claude-lite ollama --print-config 27b   # print Modelfile + settings, no launch

Pulls the base model and creates the `-cc` model when missing, then runs `claude` with generated settings,
`config/system-prompt.md`, thinking disabled and `Agent` denied. Sizes live in `config/sizes.json`.

## Hooks (`claude-lite hook <name>`, wired by `config/hooks.json`)

- `bash-guard`: denies unbounded `git log`/`git diff`/`find`/`cat <lockfile>` unless piped to head/tail/wc/grep/sed -n
- `bash-trim`: keeps head, tail and error lines of long Bash output
- `read-guard`: denies Reads of files over 300 lines without `limit <= 300`
- `edit-check`: prettier/eslint/biome (project `node_modules/.bin`), gofmt, ruff, shellcheck; rejects new comments
- `fallow-stop`: at Stop, when a `.ts/.js` file changed and Fallow is installed, blocks once with up to 15 new findings
- `tdd-guard`: no code edit until a test in the same scope was edited and a test command ran; third strike passes
  (`CLAUDE_LITE_TDD=0` turns it off; state in `~/.cache/claude-lite/tdd`)

## Develop

`bun test`, `bun run lint`, `bun run build`. Hooks are pure `decide(event)` functions; I/O is in `src/hooks/run-hook.ts`.

## Dropped from claude-custom

Console, Go TUIs, model picker, doctor, benches/evals, messages proxy, incidents, lease/fit/ladder, handoff relaunch,
rule cards, nudges, friction budget, repeat cache, telemetry, Fallow, MCP servers, drafts, Qwen Code, GGUF sizes,
digest pinning, sync beacon, hook Seatbelt sandbox. Claude Code's own sandbox block stays in the generated settings.
