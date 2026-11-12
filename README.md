# claude-lite

A small TypeScript + Bun take on claude-custom: guard hooks, an Ollama launcher, and an installer. No UI.

## Install, update, uninstall

    bun install && bun run build
    dist/claude-lite install     # CLAUDE.md @-import, `claude` rc function, ~/.local/bin/cl link (backs up each file)

    cl build                     # compile dist/claude-lite in the lite home
    cl update                    # git pull --ff-only, bun install, build, install
    cl uninstall                 # removes only what install added
    cl disable                   # sets CLAUDE_LITE_WRAP=0 in each shell rc: `claude` runs plain Claude Code in new shells
    cl enable                    # removes what disable added
    cl doctor                    # checks the build, blocks, link, hook config, Ollama health and agent-browser; prints the effective sandbox state and permission mode
    cl logs                      # follows hook decisions and the Ollama logs from its plists or Ollama.app
    cl stats                     # summarizes hooks.log: decisions, blocks, crashes and hidden lines per hook, and the top block reasons
    cl servers                   # finds duplicate Ollama servers on port 11434; checks the server responds; sets the server env (keep-alive, flash attention, q8 KV cache) and writes a login agent that sets it again after a reboot
    cl settings                  # prints merged personal + local settings JSON for claude --settings
    cl config                    # screen for every setting: Claude model, effort, sandbox, permission mode, preferences; Ollama size (or auto), thinking, effort, output tokens, sandbox, permission mode, system prompt
    cl fix-servers               # keeps Ollama.app; moves leftover Ollama LaunchAgents to ~/.Trash
    cl bench [size]              # measures a size's model: tool-use quality on fixed tasks, tokens/s, load time
    cl <command> --help          # usage for one command

The `claude` rc function adds claude-lite's settings and hooks on every launch. Set `CLAUDE_LITE_WRAP=0` to run plain Claude Code instead: for one launch (`CLAUDE_LITE_WRAP=0 claude`), for a shell (`export CLAUDE_LITE_WRAP=0`, or `set -gx CLAUDE_LITE_WRAP 0` in fish), or for good with `cl disable`, which writes that export into each shell rc (`cl enable` removes it). `command claude` also skips the function for one launch. Only `cl uninstall` removes the `~/.claude/CLAUDE.md` @-import.

`install` also sets up tab completion for zsh, bash and fish (for each shell whose rc file exists); it completes only the next valid word and reads sizes live via `cl __complete`; `update` refreshes it and `uninstall` removes it.

Put machine-local overrides in gitignored `config/local-claude.json`; `cl settings` deep-merges it over `config/claude.json` on every launch (arrays replace, e.g. `{"sandbox":{"enabled":false},"permissions":{"ask":[]}}`).

Both launch paths add the paths and environment variables in `config/sandbox-secrets.json` to the sandbox's `denyRead` list and denied credentials, so a secret listed there is hidden from `claude` and from `cl ollama` alike.

To turn off the sandbox or claude-lite's permission rules, use Claude's own keys in `config/local-claude.json`: `{"sandbox":{"enabled":false}}`, or `{"permissions":{"deny":[],"ask":[]}}` (your `~/.claude/settings.json` rules still apply). `cl ollama` takes the same keys in gitignored `config/local-ollama.json`, deep-merged over `config/ollama.json`.

### Upgrading an older install

An older binary has no `update` and no `cl`. Run once, then open a new shell; after that `cl update` works:

    git pull && bun install && bun run build && dist/claude-lite install

## Launch on Ollama

    claude-lite ollama [27b|35b|9b] [--print-config] [--think|--no-think] [--effort <level>] [claude args]
    claude-lite ollama --print-config 27b   # print Modelfile + settings, no launch
    claude-lite ollama 35b --think -p "hi"

- `--print-config`: print the Modelfile and settings instead of launching
- `--think` / `--no-think`: turn thinking on or off for this launch
- `--effort <level>`: thinking effort sent to the model; needs thinking on. Qwen3.8 accepts `low`, `medium` or `xhigh` (`high` and `max` fall back to `medium`); Qwen3.6 only does on/off
- Every other argument, such as `-p`, passes through to `claude`

Pulls the base model and creates the `-cc` model when missing or when its parameters no longer match the size, loads it, then runs `claude` with settings from
`config/ollama.json` (which denies `Agent`) and `config/system-prompt.md`. Sizes live in `config/sizes.json`; each records the `memory_gb`
Ollama needs to load it (its own estimate at the size's context). The default size is `27b` when that fits
the machine (Ollama gets about 70% of RAM on Apple Silicon), otherwise the largest size that fits: `9b` on 16 GB.
When the load fails, for example because the model needs more memory, the launcher prints Ollama's reason and the
sizes that do fit instead of starting `claude` against a model that cannot answer.
It also loads no MCP servers (`--strict-mcp-config`) and turns off every plugin your `~/.claude/settings.json` enables:
their tools, skills and SessionStart output made the first request about 93k tokens, past the model's context.

Each size sets thinking and effort. Later layers win:

| Setting  | `config/sizes.json` | `config/local-sizes.json` | Env var                        | Flag                     |
| -------- | ------------------- | ------------------------- | ------------------------------ | ------------------------ |
| thinking | `false`             | ✓                         | `CLAUDE_LITE_THINKING=on\|off` | `--think` / `--no-think` |
| effort   | unset               | ✓                         | `CLAUDE_LITE_EFFORT=<level>`   | `--effort <level>`       |

`config/local-sizes.json` is gitignored and survives `cl update`, e.g. `{"27b": {"thinking": true, "effort": "low"}}`. Add `--print-config` to see the resulting Modelfile and settings without launching.

Needs Ollama ≥ 0.40.12; `cl ollama` refuses to launch on an older server and `cl doctor` reports it. MLX runs one request at a time, so two sessions on one model take turns; switching sizes reloads the model and clears its prompt cache (`cl servers` sets `OLLAMA_MAX_LOADED_MODELS=1`).

Set `OLLAMA_HOST` (for example `OLLAMA_HOST=studio.local:11434 cl ollama 35b`) to use an Ollama server on another machine. The launcher then checks, pulls and loads on that server, points `claude` at it, adds the host to the sandbox's allowed domains and picks the default size without looking at this machine's memory.

### Measure a size

    cl bench [27b|35b|9b] [--think|--no-think] [--effort <level>] [--runs <n>] [--compare] [--json]

Runs the size's model through Ollama's chat API with the launcher's system prompt and tool schemas for Bash, Read,
Edit and Write, then prints a PASS/FAIL line per task with its speed and time to first token, `quality passed/total`, generation and prompt tokens per
second and load time. The tasks check what Claude Code needs from a local model: picking the right tool, an `Edit`
whose `old_string` exists, code without comments, a short direct answer, a bounded `grep` instead of `cat`, a
test file, and a bounded retry after bash-guard denies `git log` (scored with the real hook). `--json` prints the raw per-task numbers. `--runs <n>` repeats every task and prints a pass count per task. Every run is saved under `~/.cache/claude-lite/bench`, and `--compare` prints the change from the previous run of the same model. Use it before and after changing a size's base model,
parameters or `config/system-prompt.md`; thinking and effort layer the same way as for `cl ollama`.

## Hooks (`claude-lite hook <name>`, wired by `config/hooks.json`)

- `bash-guard`: denies unbounded `git log`/`git diff`/`find`/`cat <lockfile>` unless piped to head/tail/wc/grep/sed -n
- `commit-guard`: before `git commit`, denies `--no-verify`, `HUSKY=0` and `-c core.hooksPath`, runs the project's `lint`/`typecheck`/`test` scripts (unless a pre-commit hook exists) and, for Next.js, requires a running `next dev` with no compilation errors (`CLAUDE_LITE_COMMIT_GUARD=0` turns it off)
- `bash-trim`: keeps head, tail and error lines of long Bash output
- `read-guard`: denies Reads of text files over 300 lines or 5 MB without `limit <= 300`
- `edit-check`: prettier/eslint/biome (project `node_modules/.bin`), gofmt, ruff, shellcheck; rejects new comments, including Python docstrings and lines added inside a block comment, and new vague or too-short names such as `tmp`, `data` or a two-letter identifier
- `browser-check`: at Stop, blocks once when a UI file (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.astro`, `.html`, CSS) was edited after the last browser console read (`agent-browser console` or `errors`, Playwright MCP, or Claude in Chrome); `cl doctor` checks that [agent-browser](https://agent-browser.dev/) (`brew install agent-browser`) runs
- `fallow-stop`: after a `.ts/.js` edit and at Stop, when Fallow is installed, blocks with up to 15 new findings
- `tdd-guard`: no code edit until a test in the same scope was edited and a test command ran; third strike passes
  (off by default; `CLAUDE_LITE_TDD=1` turns it on; state in `~/.cache/claude-lite/tdd`)

Decisions log to `~/.cache/claude-lite/hooks.log` (followed by `cl logs`).

## Environment variables

| Variable                   | Purpose                                                                                                                                                                       | Required                                                                             | Default                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `CLAUDE_LITE_EFFORT`       | Effort level for `cl ollama` (`low`, `medium` or `xhigh` on Qwen3.8; needs thinking on); `--effort` overrides it                                                              | Optional                                                                             | The size's `effort`, else unset                                                  |
| `CLAUDE_LITE_HOME`         | The claude-lite checkout that hook commands and config paths resolve against; the `claude` rc function and `cl ollama` set it on launch                                       | Optional when you run `cl` yourself; hook commands need it, and the launchers set it | The checkout containing the binary (`dist/..`), or the repo when run from source |
| `CLAUDE_LITE_WRAP`         | `0` makes the `claude` rc function run plain `claude`, without claude-lite's settings and hooks                                                                               | Optional                                                                             | Unset, so `claude` is wrapped                                                    |
| `CLAUDE_LITE_COMMIT_GUARD` | `0` turns off commit-guard                                                                                                                                                    | Optional                                                                             | Unset, so commit-guard is on                                                     |
| `CLAUDE_LITE_TDD`          | `1` turns on tdd-guard                                                                                                                                                        | Optional                                                                             | Unset, so tdd-guard is off                                                       |
| `CLAUDE_LITE_THINKING`     | `on` or `off` sets thinking for `cl ollama`; `--think`/`--no-think` override it                                                                                               | Optional                                                                             | The size's `thinking`                                                            |
| `CLAUDE_LITE_STATE_DIR`    | Where tdd-guard keeps its per-session state                                                                                                                                   | Optional                                                                             | `~/.cache/claude-lite/tdd`                                                       |
| `OLLAMA_HOST`              | Address of the Ollama server for `cl ollama` and `cl bench`: `host`, `host:port` or a URL; a remote host skips the local memory check and joins the sandbox's allowed domains | Optional                                                                             | `localhost:11434`                                                                |
| `HOME`                     | The user home for install targets and `hooks.log`                                                                                                                             | Optional                                                                             | `os.homedir()`                                                                   |
| `PATH`                     | `install` warns when `~/.local/bin` is missing from it                                                                                                                        | Optional                                                                             | Empty, so you get the warning                                                    |
| `ANTHROPIC_API_KEY`        | `cl ollama` removes it from the child env so `claude` talks to Ollama                                                                                                         | Optional                                                                             | None                                                                             |

## Develop

`bun test`, `bun run lint`, `bun run typecheck`, `bun run build`. Hooks are pure `decide(event)` functions; I/O is in `src/hooks/run-hook.ts`.

## Dropped from claude-custom

Console, Go TUIs, model picker, evals, messages proxy, incidents, lease/fit/ladder, handoff relaunch,
rule cards, nudges, friction budget, repeat cache, telemetry, MCP servers, drafts, Qwen Code, GGUF sizes,
digest pinning, sync beacon, hook Seatbelt sandbox. Claude Code's own sandbox block stays in the generated settings.
