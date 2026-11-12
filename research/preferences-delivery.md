# Delivering config/PREFERENCES.md to one launch

Question: how can PREFERENCES.md reach a session without the global `~/.claude/CLAUDE.md` @-import?

Sources: `claude --help` (CLI 2.1.322 on this machine), and the official docs at code.claude.com/docs:

- CLI reference: https://code.claude.com/docs/en/cli-reference
- Memory: https://code.claude.com/docs/en/memory
- Settings: https://code.claude.com/docs/en/settings
- Context window: https://code.claude.com/docs/en/context-window
- Output styles: https://code.claude.com/docs/en/output-styles
- Hooks: https://code.claude.com/docs/en/hooks (only a summary was read; see the SessionStart note)
- Plugin manifest: https://code.claude.com/docs/en/plugins-reference

Nothing below was tested against a live session. "Unconfirmed" marks facts the docs do not settle.

## Background

- CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt (memory doc, "Claude isn't following my CLAUDE.md"). Today's @-import therefore lands in the message stream, not the system prompt.
- Project-root CLAUDE.md is re-injected from disk after `/compact`; nested CLAUDE.md reloads on demand (context-window doc, "What survives compaction").

## Mechanisms

### 1. `--append-system-prompt-file <path>`

- Lands in: the system prompt, appended after the default prompt (CLI reference, "System prompt flags").
- Stacks with `--system-prompt-file`: yes. The docs say to pass an append flag together with a replacement flag to replace the default and still append. This works with `cl ollama`'s `--system-prompt-file` as long as the CLI is 2.1.283 or later (installed: 2.1.322).
- Survives compaction: yes. The context-window table says "System prompt and output style: both still apply."
- Survives `/clear`: unconfirmed. The docs do not say. The flag is a launch argument, so it should stay in effect for the process.
- Resume: `--system-prompt-snapshot` defaults to `on`. The prompt is recorded on the first request and reused on `--continue` or `--resume`, even when the file changed. Pass `--system-prompt-snapshot off` to rebuild each request.
- Cost: input tokens on every request. No token figure is documented. Measure with `/context`.
- Caveat: `--exclude-dynamic-system-prompt-sections` is ignored when `--system-prompt-file` is set.

### 2. `--append-system-prompt <text>`

Same behavior as (1), with the text inline. Use it for short text only. A file is a better fit for PREFERENCES.md.

### 3. `--settings` with `claudeMdExcludes`

- Only removes CLAUDE.md files. It cannot add one. `claudeMdExcludes` can be set at user, project, local, or managed layers, and arrays merge across layers (memory doc). `--settings` can set any key a user settings file can set (settings doc), so the key is accepted there.
- No settings key was found that adds a CLAUDE.md path. The memory doc lists only `claudeMdExcludes`, `--add-dir`, and the env var in (4).
- Not a delivery mechanism.

### 4. `--add-dir` with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`

- Without the env var, CLAUDE.md files in added directories are not loaded (memory doc, "Load from additional directories").
- With it set, the directory's `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, and `.claude/rules/*.md` load (rules with a `paths` field excepted). `CLAUDE.local.md` is skipped when `local` is excluded from `--setting-sources`.
- Lands in: the CLAUDE.md/memory channel, i.e. the user message stream.
- The file must be named `CLAUDE.md`. `PREFERENCES.md` would need a `CLAUDE.md` that `@`-imports it, or a symlink.
- Survives compaction: unconfirmed. Only project-root CLAUDE.md is documented as re-injected. An added directory's CLAUDE.md is neither project-root nor nested.
- Caveat: `--add-dir` grants file access to that directory. `--restricted` confines file tools to the working directories, including `--add-dir` directories.
- Setting the env var through an `env` block in `--settings` is unconfirmed; the timing relative to memory loading is not documented.

### 5. Other environment variables

- `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` (above) is the only variable found that loads extra instructions.
- `CLAUDE_CONFIG_DIR` relocates the whole user config directory, including settings, sessions and plugins (settings doc). A per-launch config directory with its own CLAUDE.md would work in principle, but auth and other side effects are not documented, so this is unconfirmed and heavy.

### 6. `--plugin-dir` with a SessionStart hook

- `--plugin-dir` loads a plugin for this session only (CLI reference).
- A plugin's root `CLAUDE.md` is not loaded. `claude plugin validate` warns about it. A plugin's `settings.json` applies only `agent` and `subagentStatusLine` (plugins-reference). Instructions must come from a skill, a hook, or an output style.
- SessionStart hook output: `hookSpecificOutput.additionalContext`, or plain stdout with exit 0 (hooks summary, not the full SessionStart section).
- Re-fires on `clear` and `compact` sources, and on resume (hooks summary; context-window table lists SessionStart hooks matching `compact`). So it survives `/clear` and compaction.
- Size cap: 10,000 characters for `additionalContext` and plain stdout, per the hooks summary. Longer output goes to a file, and Claude sees only a 2,000-character preview. A script that reads `config/PREFERENCES.md` must stay under the cap.
- Lands in: "inserted into the conversation at the point where the hook fired," the start of the conversation (hooks summary). Whether it is a system-prompt section or a user message is unconfirmed.
- Cost: tokens every session, plus a process spawn on each start/clear/compact.
- Caveat: `--bare` skips hooks. `mcp_tool` hooks do not run on SessionStart.
- Whether `--settings` can carry SessionStart hooks is unconfirmed (the hooks summary did not reach that part).

### 7. Output styles

- Selected with the `outputStyle` key, which can go in `--settings` (user-level key, so it qualifies). Values are case-sensitive; the file name is the style name unless `name` is set.
- Styles live in `~/.claude/output-styles`, `.claude/output-styles` (project), or a plugin's `outputStyles` path (output-styles doc).
- Lands in: the system prompt. The context-window doc lists "output style" with the system prompt when it discusses compaction.
- Survives compaction: yes. Survives `/clear`: unconfirmed.
- Replaces Claude Code's software-engineering section unless frontmatter `keep-coding-instructions: true` is set. Without that, `cl claude` sessions lose coding guidance. Also only applies on the full system prompt (`CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=0`).
- Plugin output styles with `force-for-plugin: true` apply automatically when the plugin is enabled.
- Caveat: `/output-style` writes `.claude/settings.local.json`. Avoid it for per-launch use.
- Selecting a plugin-shipped style through `--settings` `outputStyle` is inferred from the docs and unconfirmed.

### 8. Skills (not a launch-time option)

Skill bodies load when invoked or matched, not at launch (output-styles doc, "Choose between an output style and other features"). `cl ollama` allows the Skill tool, but a skill would not be always-on. Not a fit for "every session."

## Stacking and placement summary

| Mechanism                        | Lands in                                    | Stacks with `--system-prompt-file` | Survives compaction | Survives `/clear` |
| -------------------------------- | ------------------------------------------- | ---------------------------------- | ------------------- | ----------------- |
| `--append-system-prompt-file`    | system prompt                               | yes (documented)                   | yes                 | unconfirmed       |
| `--append-system-prompt`         | system prompt                               | yes (documented)                   | yes                 | unconfirmed       |
| `--add-dir` + env var            | CLAUDE.md / user message                    | yes                                | unconfirmed         | unconfirmed       |
| `--plugin-dir` SessionStart hook | unconfirmed (start-of-conversation context) | yes                                | yes (documented)    | yes (documented)  |
| `outputStyle` via `--settings`   | system prompt                               | yes                                | yes                 | unconfirmed       |

## Surprises

- The current @-import is in the message stream, not the system prompt. Moving to an append flag changes the placement and the resume behavior.
- `--system-prompt-snapshot` defaults to `on`, so `--continue` keeps the PREFERENCES text from the first launch.
- Plugins cannot ship a root CLAUDE.md that loads. Only skills, hooks, and output styles carry instructions.
- `--bare` disables CLAUDE.md discovery and hooks. `--restricted` ignores user and project settings files, but `--settings` still applies.
- No documented mechanism places PREFERENCES.md in the memory section per launch other than `--add-dir`, which needs the env var and a file named `CLAUDE.md`.
