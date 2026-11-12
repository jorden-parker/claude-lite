# claude-lite

An Ollama launcher for Claude Code, in TypeScript and Bun. Hooks, rules and styles now live in the claude-kit marketplace; `claude` itself is never wrapped.

## Install, update, uninstall

    bun install && bun run build
    dist/claude-lite install     # ~/.local/bin/cl link and shell completion for zsh, bash and fish (backs up each rc file it changes)

    cl build                     # compile dist/claude-lite in the lite home
    cl update                    # git pull --ff-only, bun install, build, install
    cl uninstall                 # removes what install added and the server env login agent that cl servers writes
    cl doctor                    # checks the build, shell completion, the cl link, config files, Ollama version, one startup source and the server env; prints the Ollama sandbox and permission mode
    cl logs                      # follows the Ollama logs (launchd plists or Ollama.app) and the cl mlx log
    cl servers                   # finds duplicate Ollama servers on port 11434; checks the server responds; sets the server env (keep-alive, one parallel request, flash attention, q8 KV cache, one loaded model; flash attention and the q8 KV cache reach only GGUF sizes like `9b`, not the MLX `27b` and `35b`) and writes a login agent that sets it again after a reboot
    cl fix-servers               # keeps Ollama.app; moves leftover Ollama LaunchAgents to ~/.Trash
    cl config                    # screen for the Ollama default size, thinking, effort, output tokens, sandbox, permission mode and system prompt
    cl ollama [size]             # launches Claude Code on a local model (see below)
    cl mlx [size]                # same, but the model runs on vllm-mlx instead of Ollama
    cl bench [size]              # measures a size's model: tool-use quality on fixed tasks, tokens/s, load time
    cl <command> --help          # usage for one command

`install` also sets up tab completion for zsh, bash and fish (for each shell whose rc file exists); it completes only the next valid word and reads sizes live via `cl __complete`; `update` refreshes it and `uninstall` removes it.

### Upgrading from the `claude` wrapper

Older versions wrapped `claude` through an rc function and a CLAUDE.md import. Run that version's `uninstall` first, then `git pull && bun install && bun run build && dist/claude-lite install`. Uninstall also strips any leftover claude-lite block from `~/.claude/CLAUDE.md` and the shell rc files.

## Launch on Ollama

    claude-lite ollama [27b|35b|9b] [--print-config] [--think|--no-think] [--qwen] [--effort <level>] [claude args]
    claude-lite ollama --print-config 27b   # print Modelfile + settings, no launch
    claude-lite ollama 35b --think -p "hi"

- `--print-config`: print the Modelfile and settings instead of launching
- `--think` / `--no-think`: turn thinking on or off for this launch
- `--effort <level>`: thinking effort sent to the model; needs thinking on. Qwen3.8 accepts `low`, `medium` or `xhigh` (`high` and `max` fall back to `medium`); Qwen3.6 only does on/off
- `--qwen`: run Qwen Code instead of `claude` (see [Qwen Code](#qwen-code))
- Every other argument, such as `-p`, passes through to `claude`

Pulls the base model and creates the `-cc` model when missing or when its parameters no longer match the size, loads it, then runs `claude` with settings from
`config/ollama.json` (which denies `Agent`) and `config/system-prompt.md`. Sizes live in `config/sizes.json`; each records the `memory_gb`
Ollama needs to load it (its own estimate at the size's context). The default size is `35b` when that fits
the machine (Ollama gets about 70% of RAM on Apple Silicon, or the `iogpu.wired_limit_mb` you set with `sudo sysctl` when it is positive), otherwise the largest size that fits: `9b` on 16 GB.
When the load fails, for example because the model needs more memory, the launcher prints Ollama's reason and the
sizes that do fit instead of starting `claude` against a model that cannot answer.
It also loads no MCP servers (`--strict-mcp-config`) and turns off the built-in (`@builtin`) plugins your `~/.claude/settings.json` enables,
so your other plugins keep their slash commands and skills. Plugins add tools, skills and SessionStart output to the first request; turn heavy ones off in `~/.claude/settings.json` if it outgrows the model's context.

Each size sets thinking and effort. Later layers win:

| Setting  | `config/sizes.json` | `config/local-sizes.json` | Env var                        | Flag                     |
| -------- | ------------------- | ------------------------- | ------------------------------ | ------------------------ |
| thinking | `false`             | ✓                         | `CLAUDE_LITE_THINKING=on\|off` | `--think` / `--no-think` |
| effort   | unset               | ✓                         | `CLAUDE_LITE_EFFORT=<level>`   | `--effort <level>`       |

`config/local-sizes.json` is gitignored and survives `cl update`, e.g. `{"27b": {"thinking": true, "effort": "low"}}`. Add `--print-config` to see the resulting Modelfile and settings without launching.

Needs Ollama ≥ 0.40.12; `cl ollama` refuses to launch on an older server and `cl doctor` reports it. MLX runs one request at a time, so two sessions on one model take turns; switching sizes reloads the model and clears its prompt cache (`cl servers` sets `OLLAMA_MAX_LOADED_MODELS=1`).

Set `OLLAMA_HOST` (for example `OLLAMA_HOST=studio.local:11434 cl ollama 35b`) to use an Ollama server on another machine. The launcher then checks, pulls and loads on that server, points `claude` at it, adds the host to the sandbox's allowed domains and picks the default size without looking at this machine's memory.

Sandbox and permission mode come from `config/ollama.json`, with gitignored `config/local-ollama.json` deep-merged over it (arrays replace, e.g. `{"sandbox":{"enabled":false},"permissions":{"deny":[],"ask":[]}}`). `cl config` writes that file. The launcher adds the paths and environment variables in `config/sandbox-secrets.json` to the sandbox's `denyRead` list and denied credentials.

### Qwen Code

`--qwen` (on `ollama` and `mlx`) runs Qwen Code's `qwen` command after the same server and model setup, with `OPENAI_BASE_URL=<server>/v1`, `OPENAI_API_KEY=claude-lite` and `OPENAI_MODEL=<model>` set. Install it with `npm i -g @qwen-code/qwen-code`.

Qwen Code runs without claude-lite's permissions, sandbox, secret denies and system prompt, and `cl bench` stays claude-only. Configure Qwen Code's own permissions and sandbox in `~/.qwen/settings.json`.

## Launch on MLX directly

    claude-lite mlx [27b|35b|9b] [--print-config] [--think|--no-think] [--qwen] [--effort <level>] [claude args]
    claude-lite mlx 35b --print-config   # print the server command + settings, no launch

Runs the size's `mlx` model (an `mlx-community` 4-bit build named in `config/sizes.json`) through [vllm-mlx](https://github.com/waybarrios/vllm-mlx), which serves the Anthropic Messages API that `claude` needs, instead of Ollama. Needs [uv](https://docs.astral.sh/uv/); nothing is installed into the repo.

1. Checks `127.0.0.1:8435/v1/models` (`CLAUDE_LITE_MLX_PORT` changes the port; 11435 is taken by Ollama's llama.cpp runner). A vllm-mlx already serving the size's model (for example one left by an interrupted run) is reused and keeps running after `claude` exits; stop it with `pkill -f 'vllm-mlx.* serve'`. Anything else on the port stops the launch, and `lsof` names the process.
2. Downloads the model with `uvx --from huggingface_hub hf download` (cached in `~/.cache/huggingface`; shows progress the first time).
3. Unloads every model loaded in a local Ollama (`/api/ps`, then `keep_alive: 0`) so they don't share memory with MLX; Ollama being down or idle is fine.
4. Starts `uvx vllm-mlx@0.6.0 serve` in the background with the Qwen tool and reasoning parsers, a prefix cache capped at 4 entries and 8192 MB, the size's sampling as server defaults, and thinking off unless the size or `--think` turns it on; `preserve_thinking` is always on so earlier turns keep their cached prefix. Its log is `~/.cache/claude-lite/mlx-server.log`.
5. Waits for `/v1/models`, runs `claude` with the same settings, system prompt and tools as `cl ollama`, and stops the server when `claude` exits.

The tool and reasoning parsers assume a Qwen 3.5+ model; a size with another model family needs its own parsers. `cl bench` still measures only Ollama.

### Measure a size

    cl bench [27b|35b|9b] [--think|--no-think] [--effort <level>] [--runs <n>] [--compare] [--json]

Runs the size's model through Ollama's chat API with the launcher's system prompt and tool schemas for Bash, Read,
Edit and Write, then prints a PASS/FAIL line per task with its speed and time to first token, `quality passed/total`, generation and prompt tokens per
second and load time. The tasks check what Claude Code needs from a local model: picking the right tool, an `Edit`
whose `old_string` exists, code without comments, a short direct answer, a bounded `grep` instead of `cat`, a
test file, and a bounded retry after a denied unbounded `git log` (the denial is the rule in `src/ollama/git-log-guard.ts`). `--json` prints the raw per-task numbers. `--runs <n>` repeats every task and prints a pass count per task. Every run is saved under `~/.cache/claude-lite/bench`, and `--compare` prints the change from the previous run of the same model. Use it before and after changing a size's base model,
parameters or `config/system-prompt.md`; thinking and effort layer the same way as for `cl ollama`. The bench sends the size's parameters (context, output tokens, sampling) as request options, so overrides in `config/local-sizes.json` are measured.

#### A/B test speed tweaks

    scripts/bench-variants.sh [size] [runs]

Defaults to `27b` and 3 runs. Benches the size three times, once each for the baseline, `temperature` 0.4 and a 32k context, prints `ollama ps` after each so you can read memory use, and then restores `config/local-sizes.json` to what it was (or deletes it if it did not exist). Keep a variant only if generation tokens/s rises and `quality passed/total` does not drop. The size's model must already exist: run `cl ollama <size>` once first.

## Environment variables

| Variable               | Purpose                                                                                                                                                                       | Required | Default                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `CLAUDE_LITE_EFFORT`   | Effort level for `cl ollama` (`low`, `medium` or `xhigh` on Qwen3.8; needs thinking on); `--effort` overrides it                                                              | Optional | The size's `effort`, else unset                                                  |
| `CLAUDE_LITE_HOME`     | The claude-lite checkout that `config/` paths resolve against                                                                                                                 | Optional | The checkout containing the binary (`dist/..`), or the repo when run from source |
| `CLAUDE_CONFIG_DIR`    | The Claude config directory whose `settings.json` lists the built-in plugins `cl ollama` turns off                                                                            | Optional | `~/.claude`                                                                      |
| `CLAUDE_LITE_MLX_PORT` | Port `cl mlx` serves vllm-mlx on and points `claude` at                                                                                                                       | Optional | `8435`                                                                           |
| `CLAUDE_LITE_THINKING` | `on` or `off` sets thinking for `cl ollama`; `--think`/`--no-think` override it                                                                                               | Optional | The size's `thinking`                                                            |
| `OLLAMA_HOST`          | Address of the Ollama server for `cl ollama` and `cl bench`: `host`, `host:port` or a URL; a remote host skips the local memory check and joins the sandbox's allowed domains | Optional | `127.0.0.1:11434`                                                                |
| `HOME`                 | The user home for install targets, the Ollama logs and the bench history                                                                                                      | Optional | `os.homedir()`                                                                   |
| `PATH`                 | `install` warns when `~/.local/bin` is missing from it                                                                                                                        | Optional | Empty, so you get the warning                                                    |
| `ANTHROPIC_API_KEY`    | `cl ollama` removes it from the child env so `claude` talks to Ollama                                                                                                         | Optional | None                                                                             |
| `EDITOR`               | Editor for the system prompt row in `cl config`, used when `VISUAL` is unset                                                                                                  | Optional | `vi`                                                                             |
| `VISUAL`               | Editor for the system prompt row in `cl config`, preferred over `EDITOR`                                                                                                      | Optional | `EDITOR`, else `vi`                                                              |

## Develop

`bun test`, `bun run lint`, `bun run typecheck`, `bun run build`.

## Dropped from claude-custom

Console, Go TUIs, model picker, evals, messages proxy, incidents, lease/fit/ladder, handoff relaunch,
rule cards, nudges, friction budget, repeat cache, telemetry, MCP servers, drafts, Qwen Code, GGUF sizes,
digest pinning, sync beacon, hook Seatbelt sandbox, the guard hooks and the `claude` wrapper.
