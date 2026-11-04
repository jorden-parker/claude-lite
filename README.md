# claude-lite

A small TypeScript + Bun take on claude-custom: guard hooks, an Ollama launcher, and an installer. No UI.

## Install, update, uninstall

    bun install && bun run build
    dist/claude-lite install     # CLAUDE.md @-import, `claude` rc function, ~/.local/bin/cl link (backs up each file)

    cl update                    # git pull --ff-only, bun install, build, install
    cl uninstall                 # removes only what install added
    cl doctor                    # checks the build, blocks, link, hook config and Ollama health
    cl logs                      # follows hook decisions and the Ollama logs from its plists or Ollama.app
    cl servers                   # finds duplicate Ollama servers on port 11434; checks the server responds
    cl <command> --help          # usage for one command

### Upgrading an older install

An older binary has no `update` and no `cl`. Run once, then open a new shell; after that `cl update` works:

    git pull && bun install && bun run build && dist/claude-lite install

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

Console, Go TUIs, model picker, benches/evals, messages proxy, incidents, lease/fit/ladder, handoff relaunch,
rule cards, nudges, friction budget, repeat cache, telemetry, MCP servers, drafts, Qwen Code, GGUF sizes,
digest pinning, sync beacon, hook Seatbelt sandbox. Claude Code's own sandbox block stays in the generated settings.
