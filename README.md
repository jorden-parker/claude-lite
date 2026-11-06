# claude-lite

A small TypeScript + Bun take on claude-custom: guard hooks, an Ollama launcher, and an installer. No UI.

## Install, update, uninstall

    bun install && bun run build
    dist/claude-lite install     # CLAUDE.md @-import, `claude` rc function, ~/.local/bin/cl link (backs up each file)

    cl build                     # compile dist/claude-lite in the lite home
    cl update                    # git pull --ff-only, bun install, build, install
    cl uninstall                 # removes only what install added
    cl doctor                    # checks the build, blocks, link, hook config and Ollama health
    cl logs                      # follows hook decisions and the Ollama logs from its plists or Ollama.app
    cl servers                   # finds duplicate Ollama servers on port 11434; checks the server responds; sets the server env (keep-alive, flash attention, q8 KV cache)
    cl settings                  # prints merged personal + local settings JSON for claude --settings
    cl fix-servers               # keeps Ollama.app; moves leftover Ollama LaunchAgents to ~/.Trash
    cl <command> --help          # usage for one command

`install` also sets up tab completion for zsh, bash and fish (for each shell whose rc file exists); it completes only the next valid word and reads sizes live via `cl __complete`; `update` refreshes it and `uninstall` removes it.

Put machine-local overrides in gitignored `config/local-settings.json`; `cl settings` deep-merges it over `config/personal-settings.json` on every launch (arrays replace, e.g. `{"sandbox":{"enabled":false},"permissions":{"ask":[]}}`).

Set `CLAUDE_LITE_NO_PERMISSIONS=anthropic`, `ollama` or `anthropic,ollama` to omit claude-lite's `permissions` block on that launch path (your `~/.claude/settings.json` rules still apply), and `CLAUDE_LITE_NO_SANDBOX` the same way to omit the `sandbox` block. On `cl ollama`, `--permissions` and `--sandbox` turn a block back on for one launch (see [Launch on Ollama](#launch-on-ollama)).

### Upgrading an older install

An older binary has no `update` and no `cl`. Run once, then open a new shell; after that `cl update` works:

    git pull && bun install && bun run build && dist/claude-lite install

## Launch on Ollama

    claude-lite ollama [27b|35b] [--print-config] [--think|--no-think] [--permissions|--no-permissions] [--sandbox|--no-sandbox] [claude args]
    claude-lite ollama --print-config 27b   # print Modelfile + settings, no launch
    claude-lite ollama 35b --think --no-sandbox -p "hi"

- `--print-config`: print the Modelfile and settings instead of launching
- `--think` / `--no-think`: turn thinking on or off for this launch
- `--effort <level>`: thinking effort sent to the model; needs thinking on. Qwen3.8 accepts `low`, `medium` or `xhigh` (`high` and `max` fall back to `medium`); Qwen3.6 only does on/off
- `--permissions` / `--no-permissions`: keep or omit claude-lite's `permissions` block (including the `Agent` deny) for this launch; `~/.claude/settings.json` rules still apply
- `--sandbox` / `--no-sandbox`: keep or omit the `sandbox` block for this launch
- Every other argument, such as `-p`, passes through to `claude`

Pulls the base model and creates the `-cc` model when missing, then runs `claude` with generated settings,
`config/system-prompt.md` and `Agent` denied. Sizes live in `config/sizes.json`.

Each size sets thinking, effort, permissions and sandbox. Later layers win:

| Setting     | `config/sizes.json` | `config/local-sizes.json` | Env var                                   | Flag                                 |
| ----------- | ------------------- | ------------------------- | ----------------------------------------- | ------------------------------------ |
| thinking    | `false`             | ✓                         | `CLAUDE_LITE_THINKING=on\|off`            | `--think` / `--no-think`             |
| effort      | unset               | ✓                         | `CLAUDE_LITE_EFFORT=<level>`              | `--effort <level>`                   |
| permissions | `true`              | ✓                         | `CLAUDE_LITE_NO_PERMISSIONS=ollama` → off | `--permissions` / `--no-permissions` |
| sandbox     | `true`              | ✓                         | `CLAUDE_LITE_NO_SANDBOX=ollama` → off     | `--sandbox` / `--no-sandbox`         |

`config/local-sizes.json` is gitignored and survives `cl update`, e.g. `{"27b": {"thinking": true, "effort": "low", "sandbox": false}}`. Add `--print-config` to see the resulting Modelfile and settings without launching.

Needs Ollama ≥ 0.40.12. MLX runs one request at a time, so two sessions on one model take turns; switching sizes reloads the model and clears its prompt cache (`cl servers` sets `OLLAMA_MAX_LOADED_MODELS=1`).

## Hooks (`claude-lite hook <name>`, wired by `config/hooks.json`)

- `bash-guard`: denies unbounded `git log`/`git diff`/`find`/`cat <lockfile>` unless piped to head/tail/wc/grep/sed -n
- `commit-guard`: before `git commit`, denies `--no-verify`, runs the project's `lint`/`typecheck`/`test` scripts (unless a pre-commit hook exists) and, for Next.js, requires a running `next dev` with no compilation errors (`CLAUDE_LITE_COMMIT_GUARD=0` turns it off)
- `bash-trim`: keeps head, tail and error lines of long Bash output
- `read-guard`: denies Reads of files over 300 lines without `limit <= 300`
- `edit-check`: prettier/eslint/biome (project `node_modules/.bin`), gofmt, ruff, shellcheck; rejects new comments
- `fallow-stop`: after a `.ts/.js` edit and at Stop, when Fallow is installed, blocks with up to 15 new findings
- `tdd-guard`: no code edit until a test in the same scope was edited and a test command ran; third strike passes
  (off by default; `CLAUDE_LITE_TDD=1` turns it on; state in `~/.cache/claude-lite/tdd`)

Decisions log to `~/.cache/claude-lite/hooks.log` (followed by `cl logs`).

## Environment variables

| Variable                     | Purpose                                                                                                                                                                              | Required                                                                             | Default                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `CLAUDE_LITE_EFFORT`         | Effort level for `cl ollama` (`low`, `medium` or `xhigh` on Qwen3.8; needs thinking on); `--effort` overrides it                                                                     | Optional                                                                             | The size's `effort`, else unset                                                  |
| `CLAUDE_LITE_HOME`           | The claude-lite checkout that hook commands and config paths resolve against; the `claude` rc function and `cl ollama` set it on launch                                              | Optional when you run `cl` yourself; hook commands need it, and the launchers set it | The checkout containing the binary (`dist/..`), or the repo when run from source |
| `CLAUDE_LITE_NO_PERMISSIONS` | Comma list of launch paths (`anthropic`, `ollama`) that omit claude-lite's `permissions` block (`~/.claude/settings.json` rules still apply); `cl ollama --permissions` overrides it | Optional                                                                             | Unset, so the block is kept                                                      |
| `CLAUDE_LITE_NO_SANDBOX`     | Comma list of launch paths (`anthropic`, `ollama`) that omit the `sandbox` block; `cl ollama --sandbox` overrides it                                                                 | Optional                                                                             | Unset, so the block is kept                                                      |
| `CLAUDE_LITE_COMMIT_GUARD`   | `0` turns off commit-guard                                                                                                                                                           | Optional                                                                             | Unset, so commit-guard is on                                                     |
| `CLAUDE_LITE_TDD`            | `1` turns on tdd-guard                                                                                                                                                               | Optional                                                                             | Unset, so tdd-guard is off                                                       |
| `CLAUDE_LITE_THINKING`       | `on` or `off` sets thinking for `cl ollama`; `--think`/`--no-think` override it                                                                                                      | Optional                                                                             | The size's `thinking`                                                            |
| `CLAUDE_LITE_STATE_DIR`      | Where tdd-guard keeps its per-session state                                                                                                                                          | Optional                                                                             | `~/.cache/claude-lite/tdd`                                                       |
| `HOME`                       | The user home for install targets and `hooks.log`                                                                                                                                    | Optional                                                                             | `os.homedir()`                                                                   |
| `PATH`                       | `install` warns when `~/.local/bin` is missing from it                                                                                                                               | Optional                                                                             | Empty, so you get the warning                                                    |
| `ANTHROPIC_API_KEY`          | `cl ollama` removes it from the child env so `claude` talks to Ollama                                                                                                                | Optional                                                                             | None                                                                             |

## Develop

`bun test`, `bun run lint`, `bun run typecheck`, `bun run build`. Hooks are pure `decide(event)` functions; I/O is in `src/hooks/run-hook.ts`.

## Dropped from claude-custom

Console, Go TUIs, model picker, benches/evals, messages proxy, incidents, lease/fit/ladder, handoff relaunch,
rule cards, nudges, friction budget, repeat cache, telemetry, MCP servers, drafts, Qwen Code, GGUF sizes,
digest pinning, sync beacon, hook Seatbelt sandbox. Claude Code's own sandbox block stays in the generated settings.
