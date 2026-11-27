# claude-lite

An Ollama launcher for Claude Code, in TypeScript and Bun. Hooks, rules and styles now live in the claude-kit marketplace; `claude` itself is never wrapped.

## Install, update, uninstall

    bun install && bun run build
    dist/claude-lite install     # ~/.local/bin/cl link and shell completion for zsh, bash and fish (backs up each rc file it changes)

    cl build                     # compile dist/claude-lite in the lite home
    cl update                    # git pull --ff-only, bun install, build, install
    cl uninstall                 # removes what install added and the server env login agent that cl servers writes
    cl doctor                    # checks the build, shell completion, the cl link, config files, Ollama version, one startup source and the server env, and the last `cl mlx` log, which fails when oMLX stored no prompt cache; prints the Ollama sandbox and permission mode
    cl logs                      # follows the Ollama logs (launchd plists or Ollama.app) and the cl mlx log
    cl servers                   # finds duplicate Ollama servers on port 11434; checks the server responds; sets the server env (keep-alive, one parallel request, flash attention, q8 KV cache, one loaded model; flash attention and the q8 KV cache reach only GGUF sizes like `9b`, not the MLX `27b` and `35b`) and writes a login agent that sets it again after a reboot
    cl stop                      # kills the cl mlx oMLX server and every Ollama process (reopen Ollama before cl ollama)
    cl fix-servers               # keeps Ollama.app; moves leftover Ollama LaunchAgents to ~/.Trash
    cl list                      # every size with its `cl ollama` and `cl mlx` start commands, the default, what does not fit memory, and the client flags
    cl config                    # screen for the default size, sandbox, permission mode, system prompt, and every size's thinking, effort, output tokens and client
    cl ollama [size]             # launches Claude Code on a local model (see below)
    cl mlx [size]                # same, but the model runs on oMLX instead of Ollama
    cl serve [size]              # starts the oMLX server on port 8435 without claude and stays up until Ctrl-C
    cl bench [size]              # measures a size's model: tool-use quality on fixed tasks, tokens/s, load time
    cl <command> --help          # usage for one command

`install` also sets up tab completion for zsh, bash and fish (for each shell whose rc file exists); it completes only the next valid word and reads sizes live via `cl __complete`; `update` refreshes it and `uninstall` removes it.

### Upgrading from the `claude` wrapper

Older versions wrapped `claude` through an rc function and a CLAUDE.md import. Run that version's `uninstall` first, then `git pull && bun install && bun run build && dist/claude-lite install`. Uninstall also strips any leftover claude-lite block from `~/.claude/CLAUDE.md` and the shell rc files.

## Launch on Ollama

    claude-lite ollama [27b|35b|9b|40b] [--print-config] [--think|--no-think] [--qwen|--opencode] [--effort <level>] [claude args]
    claude-lite ollama --print-config 27b   # print Modelfile + settings, no launch
    claude-lite ollama 35b --think -p "hi"

- `--print-config`: print the Modelfile and settings instead of launching
- `--think` / `--no-think`: turn thinking on or off for this launch
- `--effort <level>`: thinking effort sent to the model; needs thinking on. Qwen3.8 accepts `low`, `medium` or `xhigh` (`high` and `max` fall back to `medium`); Qwen3.6 only does on/off
- `--qwen`: run Qwen Code instead of `claude` (see [Qwen Code](#qwen-code))
- `--opencode`: run OpenCode instead of `claude` (see [OpenCode](#opencode))
- Every other argument, such as `-p`, passes through to `claude`

Pulls the base model and creates the `-cc` model when missing or when its parameters no longer match the size, loads it, then runs `claude` with settings from
`config/ollama.json` (which denies `Agent`) and `config/system-prompt.md`. Sizes live in `config/sizes.json`; each records the `memory_gb`
Ollama needs to load it (its own estimate at the size's context). The default size is `35b` when that fits
the machine (Ollama gets about 70% of RAM on Apple Silicon, or the `iogpu.wired_limit_mb` you set with `sudo sysctl` when it is positive), otherwise the largest size that fits: `9b` on 16 GB.
`40b` is [Recursive Flint](https://huggingface.co/RecursiveSI/flint) (Apache 2.0, October 2026), a coding MoE with about 2.5B of its 40B parameters active per token, run with its card's thinking-mode sampling (temperature 1.0, top_p 0.95, top_k 20). It needs a 48 GB Mac and is never the default: pick it with `cl ollama 40b` or `cl mlx 40b`. Its `memory_gb` of 27 is an estimate (23 GB weights plus the KV cache of its 14 full-attention layers), so run `cl bench 40b` and correct it from Ollama's load report.
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

Sandbox and permission mode come from `config/ollama.json`, with gitignored `config/local-ollama.json` deep-merged over it (arrays replace, e.g. `{"sandbox":{"enabled":false},"permissions":{"deny":[],"ask":[]}}`). `cl config` writes that file. A permission mode other than `default` is also passed to `claude` as `--permission-mode`, because `claude` ignores `bypassPermissions` from a settings file, and `auto` drops the base `disableAutoMode` so it can apply and sets `CLAUDE_CODE_AUTO_MODE_MODEL` to the size's model, so the local model is also the auto mode classifier; a `--permission-mode` or `--dangerously-skip-permissions` you pass after the size wins. The launcher adds the paths and environment variables in `config/sandbox-secrets.json` to the sandbox's `denyRead` list and denied credentials.

### Qwen Code

`--qwen` (on `ollama` and `mlx`) runs Qwen Code's `qwen` command after the same server and model setup, with `OPENAI_BASE_URL=<server>/v1`, `OPENAI_API_KEY=claude-lite` and `OPENAI_MODEL=<model>` set. Install it with `npm i -g @qwen-code/qwen-code`.

Qwen Code runs without claude-lite's permissions, sandbox, secret denies and system prompt, and `cl bench` stays claude-only. Configure Qwen Code's own permissions and sandbox in `~/.qwen/settings.json`.

### OpenCode

`--opencode` (on `ollama` and `mlx`) runs `opencode` after the same server and model setup. It sets `OPENCODE_CONFIG_CONTENT` to an inline config with a `claude-lite` OpenAI-compatible provider at `<server>/v1` and `model` set to `claude-lite/<model>`; that config overrides your global and project `opencode.json` for those keys only. Arguments after the flags pass to `opencode` (for example `cl ollama 27b --opencode run "hi"`). Install it with `npm i -g opencode-ai`.

It also passes `--standalone`, so OpenCode starts a private server that reads this config. Without it OpenCode 2 connects to its shared background service, which keeps the config, and so the model, of whichever launch started it. Passing your own `--server` or `--standalone` skips this.

It needs OpenCode 2.0 or newer and exits 1 otherwise: older versions ignore the `providers` key, and OpenCode falls back to the newest model it can reach, which can be a cloud model.

The config also adds `config/opencode-instructions.md` to `instructions`, which tells OpenCode to browse with [agent-browser](https://agent-browser.dev/) (`brew install agent-browser`) instead of its web fetch tool.

Flint (`40b`) is text-only, so its `"vision_size": "9b"` in `config/sizes.json` gives every client an `image-reader` subagent that runs the `9b` Qwen model, with the same description and prompt (`src/image-reader.ts`). Flint hands that subagent an image path and gets a description back. `--opencode` declares Flint with text-only input and adds the subagent to its config. `claude` gets it through `--agents`, with `Agent` added to its tools and taken off the deny list for that launch, the `9b` model added to `availableModels`, and a line appended to the system prompt; this also lets Flint start Claude Code's built-in subagents. `--qwen` gets it as `~/.qwen/agents/image-reader.md`, written for the session and removed when `qwen` exits, plus the same appended line; a file of your own at that path is left alone and the subagent is skipped. `cl ollama` pulls and creates the `9b` model first and `cl mlx` downloads its MLX repo. On Ollama the two models need about 36 GB together, so a 48 GB Mac may swap them for each image; on MLX they fit together.

It also loads `src/opencode-plugin.ts` through the config's `plugins` key. The plugin runs your [claude-kit](https://github.com/jorden-parker/claude-kit) Claude Code hooks for OpenCode's tools, using the newest installed version of each plugin under `~/.claude/plugins/cache/claude-kit`. Each script gets the same JSON on stdin that Claude Code would send, and an `exit 2` or a `deny` decision blocks the tool call with the script's message:

- `edit` and `write`: `tdd-require-red`, `no-comments` and `naming-check`. The last two run before the edit and block it, where Claude Code reports them after the edit lands.
- `bash`: `bash-guard`, `commit-guard` and `fallow-gate` before the command; `tdd-record-test-run` after it, so a failing test unlocks the TDD gate.
- `read`: `read-guard`.

Not ported: the Stop gates (`tdd-green-gate`, `verify-before-finish-gate`, `naming-review-gate`, `browser-check`), `bash-trim`, and the SessionStart rule printers. OpenCode has no hook that blocks a turn from finishing, and the scripts that read Claude Code's transcript find none. Each `opencode` launch counts as one hook session. OpenCode's after-tool event has no call id, so results are paired with calls in the order they started; parallel tool calls can mix them up.

Like Qwen Code, OpenCode runs without claude-lite's permissions, sandbox, secret denies and system prompt. Configure its own permissions in `~/.config/opencode/opencode.json`.

## Launch on MLX directly

    claude-lite mlx [27b|35b|9b|40b] [--print-config] [--think|--no-think] [--qwen|--opencode] [--effort <level>] [claude args]
    claude-lite mlx 35b --print-config   # print the server command, model settings and settings, no launch
    claude-lite serve [27b|35b|9b|40b] [--print-config]

Runs the size's `mlx` model (an `mlx-community` 4-bit build named in `config/sizes.json`) through [oMLX](https://github.com/jundot/omlx) 0.7.3 or newer, which serves the Anthropic Messages API that `claude` needs, instead of Ollama. oMLX is not on PyPI, so install it with Homebrew (or the macOS app, as long as it puts `omlx` on PATH):

    brew tap jundot/omlx https://github.com/jundot/omlx
    brew install jundot/omlx/omlx --with-custom-kernel   # needs full Xcode
    brew install jundot/omlx/omlx                        # without Xcode: Qwen3.5-family models silently run on a much slower generic path

Check that a Homebrew install has the kernels with `/opt/homebrew/opt/omlx/libexec/bin/python -c "from omlx.custom_kernels import native_kernel_status; print(native_kernel_status())"`. Nothing is installed into the repo.

1. Checks that `omlx` is on PATH, then `127.0.0.1:8435/v1/models` (`CLAUDE_LITE_MLX_PORT` changes the port; 11435 is taken by Ollama's llama.cpp runner). An oMLX already serving the size's model (a second `cl mlx` session on the same size, or one left by an interrupted run) is reused and keeps running after `claude` exits; stop it with `cl stop`. oMLX batches the sessions' requests, so two sessions generate at the same time. Anything else on the port stops the launch, and `lsof` names the process.
2. Downloads the model, and the size's drafter (its `mlx_dflash` draft for native DFlash2 or Splash, or its `mlx_draft` drafter for MTP), with `uvx --from huggingface_hub hf download` (cached in `~/.cache/huggingface`; shows progress the first time). It downloads only repos missing from that cache or left incomplete; to fetch a newer upstream revision of a cached repo, run `hf download <repo>` by hand. oMLX reads that Hugging Face cache and serves the model under the id `org--name`, the repo id with each `/` replaced by `--` (for example `mlx-community--Qwen3.6-35B-A3B-4bit`); `claude` and `qwen` are given that id.
3. Unloads every model loaded in a local Ollama (`/api/ps`, then `keep_alive: 0`) so they don't share memory with MLX; Ollama being down or idle is fine.
4. Writes `~/.cache/claude-lite/omlx/model_settings.json` with an entry for every mlx size, keyed by that id: its context, output tokens and sampling, with `force_sampling` on so the size's sampling wins over what `claude` sends, and thinking from the size or `--think`/`--no-think`. A size using MTP (with its model's `-MTP-4bit` drafter, for example `mlx-community/Qwen3.8-27B-MTP-4bit`, 0.3 GB) also gets `vlm_mtp_enabled` and `vlm_mtp_draft_model`, so oMLX drafts tokens with that multi-token-prediction head and the model only verifies them: same output, faster decode. oMLX logs `VLM MTP drafter loaded` when it takes, and ignores the setting with a warning when it can't load the drafter. In automatic mode, a size with `mlx_dflash` (the `27b`, with `incoai/Qwen3.8-27B-DFlash2`, 3.8 GB, and the default `35b`, with `incoai/Qwen3.6-35B-A3B-DFlash2`, 1.1 GB) is served through [Splash](https://github.com/incoai/splash) instead when `splash` is on PATH (`brew install incoai/tap/splash`, 1.3.0 or newer, M3 or later): its entry gets `external_engine: "splash"` and `dflash_draft_model` and no MTP keys, because oMLX's MTP settings do not apply while Splash serves the model. oMLX then starts `splash serve` itself and forwards requests to it, so `claude`, `--qwen` and `--opencode` keep the same port and model id. In automatic mode without `splash`, the size uses the MTP drafter. The 27B preset selects native DFlash2 by default. oMLX does not fall back on its own: if Splash is installed but cannot serve the model (too old, or the draft is missing), the first request fails with oMLX's reason. The file is rewritten on every start, so edits to it or in the oMLX admin UI are overwritten; change the size in `config/sizes.json` or `config/local-sizes.json` instead.
5. Starts `omlx serve --base-path ~/.cache/claude-lite/omlx --host 127.0.0.1 --port 8435 --paged-ssd-cache-max-size 20GB --memory-guard aggressive` in the background. The data dir holds the settings and the SSD prompt cache, capped at 20 GB. `aggressive` keeps only about 2% of RAM free for other apps and may compress half their memory, so the 35b fits under oMLX's memory ceiling; the default `balanced` tier refuses it when other apps hold a lot of RAM. The server log is `~/.cache/claude-lite/mlx-server.log`.
6. Waits for `/v1/models` to list the id (if it does not, the model is not an MLX model in the Hugging Face cache and the launch stops), runs `claude` with the same settings, system prompt and tools as `cl ollama`, and stops the server when `claude` exits, unless another `cl mlx` session still uses it (each session leaves its pid in `~/.cache/claude-lite/omlx/sessions`); the server then keeps running until `cl stop`. Closing the terminal of the session that started the server can still end it for the others.

`cl serve` runs the steps above up to the ready check, then prints `oMLX ready at http://127.0.0.1:8435, serving <id>; Ctrl-C stops it` and stays in the foreground for other apps to use the server, without `claude`. Ctrl-C (or the server exiting) stops the server it started. A `cl mlx` session started meanwhile reuses it and leaves it running. An oMLX already serving the size's model is reused and `cl serve` exits 0 at once.

`cl bench 27b --backend mlx` measures oMLX in a temporary server with its own port, log and prompt cache.

#### T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) has no official local model support, but a Claude provider instance can point at `cl serve 27b` through `config/t3-code-27b.json`, a Claude settings file with only an `env` block. This setup is untested end to end.

1. Run `scripts/t3-code-setup.sh`. It copies that file to `~/.claude_local/settings.json` and prints the values for the next steps. It exits 1 and changes nothing when a different `settings.json` is already there.
2. Run `cl serve 27b` and leave it running.
3. In T3 Code, open **Settings → Providers → Add provider**, pick **Claude**, and on the **Config** step set **Binary path** to `claude`, **CLAUDE_CONFIG_DIR path** to `~/.claude_local` and **Launch arguments** to the `--append-system-prompt-file` line the script printed.
4. Click **Refresh provider status**; the instance's **Status** row should show **Custom API endpoint**.
5. On the instance's page, under **Models → Add custom model**, add `mlx-community--Qwen3.8-27B-4bit`, then pick it in a new thread.

The settings must be the config folder's `settings.json` (or the instance's **Variables**): T3 Code 0.1.10 looks for `ANTHROPIC_BASE_URL` only there when it checks the instance, ignores a `--settings` launch argument for that check, and reports an instance with no endpoint and no login as not authenticated.

T3 Code starts `claude` itself, so the launcher's sandbox, permissions, secret denies and tool list do not apply. The file assumes port 8435: with `CLAUDE_LITE_MLX_PORT` set, change `ANTHROPIC_BASE_URL` in `~/.claude_local/settings.json`. `test/t3-code.test.ts` fails when the file no longer matches the `27b` size in `config/sizes.json`.

#### Speed notes

None of these numbers were measured with claude-lite. Time a real task before and after.

- **Splash is the biggest lever.** Its [README](https://github.com/incoai/splash#performance) reports, on an M5 Pro with 48 GB and short prompts, 210 tok/s for Qwen3.6-35B-A3B (1.7x the next-fastest engine it measured) and 74 tok/s for Qwen3.8-27B (2.0x). Those are vendor numbers. With `splash` installed, `cl mlx 35b` uses it and `27b` can opt in; `40b` (Flint) stays on oMLX's own engine, because Splash serves Flint only as a GGUF.
- **The model matters more than the runtime.** One [M4 Max test](https://www.youtube.com/watch?v=DKgtZ2atxlY) of Ollama, LM Studio, llama.cpp and MLX found the tool changes speed by about 15% at most and the model by three to four times. `35b` and `40b` are mixture-of-experts models with about 3B parameters active per token; `27b` is dense and slower.
- **Animated wallpaper.** One [report](https://x.com/heyvictortorres/status/2112558446872596767) on an M2 Max with oMLX saw the same model run about 40% slower while an animated Aerial wallpaper was playing. If speed drops for no reason, switch to a still wallpaper and compare.

#### 27B on an M4 Pro with 48 GB

Both `cl mlx 27b` and `cl serve 27b` use native DFlash2 by default. The tracked 27B preset selects the IncoAI drafter with 4-bit draft quantization, groups of 64 and a five-token block. Start a fresh server after updating. The settings target oMLX 0.8.4. [oMLX DFlash settings](https://github.com/jundot/omlx/blob/v0.8.4/docs/experimental/dflash_mlx_integration.md)

For a per-machine override, set the 27B `mlx_engine` in `config/local-sizes.json` to `mtp`, `splash` or `auto`. Automatic selection uses Splash when installed and MTP otherwise. The official Splash build requires macOS 26.4 or later on M3 and newer Macs. [Splash requirements](https://github.com/incoai/splash/blob/1.7.3/README.md#quick-start)

A published 20-core M4 Pro MacBook Pro run reached 45.3 generated tokens/s on native DFlash2. At 16K tokens, the first answer started after 126.8 s and a follow-up using the cached prefix started after 1.26 s. Those measurements used oMLX 0.7.1rc1. [Raw M4 Pro run](https://github.com/nace-ai/kapitsa/blob/main/bench/results/2026-10-17/q38-27b-omlx-best-20261017-222043.json)

Ollama already uses `qwen3.8:27b-dflash2-nvfp4`. Its MLX runner verifies seven draft proposals for this model. Ollama 0.40.18 is a suitable comparison version and includes the large-vocabulary sampling improvement from 0.40.14. [Ollama DFlash2 measurements](https://github.com/ollama/ollama/pull/19149) · [Sampling improvement](https://github.com/ollama/ollama/pull/19392)

#### Known oMLX issues

- [jundot/omlx#3317](https://github.com/jundot/omlx/issues/3317): in some versions oMLX skips every prompt-cache store on Qwen3.8-27B. `cl doctor` fails the `mlx prompt cache in use` check when the log has skipped stores and no successful ones.
- [jundot/omlx#3462](https://github.com/jundot/omlx/issues/3462): a short tool-call reply may store nothing.
- [jundot/omlx#3539](https://github.com/jundot/omlx/issues/3539): the same skip-every-store symptom on these Qwen hybrid models.

### Measure a size

    cl bench [27b|35b|9b|40b] [--backend ollama|mlx] [--engine splash|dflash|mtp] [--long-context] [--think|--no-think] [--effort <level>] [--runs <n>] [--compare] [--json]

Runs the size's model through Ollama's chat API with the launcher's system prompt and tool schemas for Bash, Read,
Edit and Write, then prints a PASS/FAIL line per task with its speed and time to first token, `quality passed/total`, generation and prompt tokens per
second and load time. The tasks check what Claude Code needs from a local model: picking the right tool, an `Edit`
whose `old_string` exists, code without comments, a short direct answer, a bounded `grep` instead of `cat`, a
test file, and a bounded retry after a denied unbounded `git log` (the denial is the rule in `src/ollama/git-log-guard.ts`). `--json` prints the raw per-task numbers. `--runs <n>` repeats every task and prints a pass count per task. Every run is saved under `~/.cache/claude-lite/bench`, and `--compare` prints the change from the previous run of the same model. Use it before and after changing a size's base model,
parameters or `config/system-prompt.md`; thinking and effort layer the same way as for `cl ollama`. The benchmark applies the size’s context, output limit and sampling through Ollama request options or oMLX model settings, including overrides from `config/local-sizes.json`.

#### Compare the 27B engines

If `cl mlx 27b` keeps reading files with Thinking off, check the tool names in the Claude Code transcript. Each visible `Read` is a file request the model chose. The launcher prompt asks it to search with `git grep` and read matching lines. A long pause _between_ tool calls can come from processing the growing conversation again. `cl doctor` checks the last launcher log for skipped prompt-cache stores. In benchmark JSON, check `cachedTokens` and the time to the first output on `coding-16k-follow-up`.

`cl mlx 27b --print-config` shows the settings for a fresh launch. The 27B entry should have `enable_thinking` set to `false`, and the Claude settings should request disabled thinking. If a server was already running when you changed `cl config`, a new session can reuse its earlier model settings. Close sessions using that server and restart it before comparing.

Run each engine on the work Mac with the others idle. The MLX benchmark starts and cleans up a private server. It uses the same weights cache as the launcher. The engine flag applies to this benchmark invocation. For the Ollama run, first create the configured alias with `cl ollama 27b` if needed.

```sh
cl bench 27b --backend mlx --engine mtp --runs 5
cl bench 27b --backend mlx --engine dflash --runs 5 --compare
cl bench 27b --backend mlx --engine splash --runs 5 --compare
cl bench 27b --backend ollama --runs 5
```

Each 27B run includes approximately 4K and 16K tokens of synthetic source. Each trial varies an identifier near the start and then replays the observed Read call with a short tool result. The follow-up must read the imported file. A separate image checks both panel colors in order. Use `--long-context` to add one 48K pair under your usual app load. Use `--json` to see per-request measurements, the selected engine, runtime evidence when available, and configuration. An unconfirmed run lacks evidence that its drafter ran. Peak sampled model memory comes from the serving API and excludes process memory that API does not count.

Compare median turn time, time to first output and time to a complete tool call at both prompt lengths. The medians use successful turns. Keep a native DFlash setting on the work Mac if it cuts median coding-turn time by at least 10%, the tool and image checks pass at least as often as before, and cached follow-ups stay within 10% of the baseline. For a close result, alternate one run per engine in each of five rounds to control for temperature and background work. Bench history is kept separately by backend for comparison.

#### A/B test speed tweaks

    scripts/bench-variants.sh [size] [runs]

Defaults to `27b` and 3 runs. Benches the size three times, once each for the baseline, `temperature` 0.4 and a 32k context, prints `ollama ps` after each so you can read memory use, and then restores `config/local-sizes.json` to what it was (or deletes it if it did not exist). Keep a variant only if generation tokens/s rises and `quality passed/total` does not drop. The size's model must already exist: run `cl ollama <size>` once first.

## Environment variables

| Variable                   | Purpose                                                                                                                                                                       | Required | Default                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `CLAUDE_LITE_EFFORT`       | Effort level for `cl ollama` (`low`, `medium` or `xhigh` on Qwen3.8; needs thinking on); `--effort` overrides it                                                              | Optional | The size's `effort`, else unset                                                  |
| `CLAUDE_LITE_HOME`         | The claude-lite checkout that `config/` paths resolve against                                                                                                                 | Optional | The checkout containing the binary (`dist/..`), or the repo when run from source |
| `CLAUDE_CONFIG_DIR`        | The Claude config directory whose `settings.json` lists the built-in plugins `cl ollama` turns off                                                                            | Optional | `~/.claude`                                                                      |
| `CLAUDE_LITE_MLX_PORT`     | Port `cl mlx` serves oMLX on and points `claude` at                                                                                                                           | Optional | `8435`                                                                           |
| `CLAUDE_LITE_THINKING`     | `on` or `off` sets thinking for `cl ollama`; `--think`/`--no-think` override it                                                                                               | Optional | The size's `thinking`                                                            |
| `OLLAMA_HOST`              | Address of the Ollama server for `cl ollama` and `cl bench`: `host`, `host:port` or a URL; a remote host skips the local memory check and joins the sandbox's allowed domains | Optional | `127.0.0.1:11434`                                                                |
| `HOME`                     | The user home for install targets, the Ollama logs and the bench history                                                                                                      | Optional | `os.homedir()`                                                                   |
| `PATH`                     | `install` warns when `~/.local/bin` is missing from it                                                                                                                        | Optional | Empty, so you get the warning                                                    |
| `ANTHROPIC_API_KEY`        | `cl ollama` removes it from the child env so `claude` talks to Ollama                                                                                                         | Optional | None                                                                             |
| `EDITOR`                   | Editor for the system prompt row in `cl config`, used when `VISUAL` is unset                                                                                                  | Optional | `vi`                                                                             |
| `VISUAL`                   | Editor for the system prompt row in `cl config`, preferred over `EDITOR`                                                                                                      | Optional | `EDITOR`, else `vi`                                                              |
| `HF_HUB_CACHE` / `HF_HOME` | Where `cl mlx` looks for already-downloaded models (`HF_HUB_CACHE`, else `$HF_HOME/hub`); repos found there are not downloaded again                                          | Optional | `~/.cache/huggingface/hub`                                                       |

## Develop

`bun test`, `bun run lint`, `bun run typecheck`, `bun run build`.

## Dropped from claude-custom

Console, Go TUIs, model picker, evals, messages proxy, incidents, lease/fit/ladder, handoff relaunch,
rule cards, nudges, friction budget, repeat cache, telemetry, MCP servers, drafts, Qwen Code, GGUF sizes,
digest pinning, sync beacon, hook Seatbelt sandbox, the guard hooks and the `claude` wrapper.
