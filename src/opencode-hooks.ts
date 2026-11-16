import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export type ClaudeHook = { pluginRoot: string; command: string[] };
type HooksByTool = Partial<Record<string, ClaudeHook[]>>;
export type ClaudeKitHooks = { before: HooksByTool; after: HooksByTool };
type HookPayload = Record<string, unknown>;
type HookRunner = (hook: ClaudeHook, payload: HookPayload) => string | null;

const CLAUDE_TOOL_NAMES: Record<string, string> = {
  edit: "Edit",
  write: "Write",
  bash: "Bash",
  read: "Read",
};

const CLAUDE_INPUT_FIELDS: Record<string, string> = {
  filePath: "file_path",
  oldString: "old_string",
  newString: "new_string",
  content: "content",
  command: "command",
};

const BLOCKING_EXIT_CODE = 2;

export function claudeHookPayload(
  openCodeTool: string,
  input: Record<string, unknown>,
  directory: string,
  sessionId: string,
): HookPayload {
  const toolInput = Object.fromEntries(
    Object.entries(CLAUDE_INPUT_FIELDS)
      .filter(([openCodeField]) => input[openCodeField] !== undefined)
      .map(([openCodeField, claudeField]) => [claudeField, input[openCodeField]]),
  );
  return {
    session_id: sessionId,
    cwd: directory,
    tool_name: CLAUDE_TOOL_NAMES[openCodeTool],
    tool_input: toolInput,
  };
}

function denialReason(stdout: string): string | null {
  try {
    const decision = JSON.parse(stdout)?.hookSpecificOutput;
    return decision?.permissionDecision === "deny"
      ? String(decision.permissionDecisionReason)
      : null;
  } catch {
    return null;
  }
}

export function hookBlockReason(exitCode: number | null, stdout: string, stderr: string) {
  if (exitCode === BLOCKING_EXIT_CODE) return stderr.trim();
  return denialReason(stdout.trim());
}

export const runClaudeHook: HookRunner = ({ pluginRoot, command }, payload) => {
  const [program, ...programArguments] = command;
  const result = spawnSync(program, programArguments, {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
  });
  return hookBlockReason(result.status, result.stdout ?? "", result.stderr ?? "");
};

const compareVersions = (first: string, second: string) => {
  const firstParts = first.split(".").map(Number);
  const secondParts = second.split(".").map(Number);
  for (let i = 0; i < Math.max(firstParts.length, secondParts.length); i++) {
    const difference = (firstParts[i] ?? 0) - (secondParts[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

function newestPluginRoot(userHome: string, plugin: string): string | null {
  const pluginDirectory = join(userHome, ".claude/plugins/cache/claude-kit", plugin);
  try {
    const newest = readdirSync(pluginDirectory).sort(compareVersions).at(-1);
    return newest ? join(pluginDirectory, newest) : null;
  } catch {
    return null;
  }
}

export function claudeKitHooks(userHome: string): ClaudeKitHooks {
  const roots = {
    codeStyle: newestPluginRoot(userHome, "code-style"),
    tdd: newestPluginRoot(userHome, "tdd"),
    qualityGates: newestPluginRoot(userHome, "quality-gates"),
    guards: newestPluginRoot(userHome, "guards"),
  };
  const script = (pluginRoot: string | null, name: string): ClaudeHook[] =>
    pluginRoot ? [{ pluginRoot, command: [join(pluginRoot, "hooks", name)] }] : [];
  const guard = (name: string): ClaudeHook[] =>
    roots.guards
      ? [{ pluginRoot: roots.guards, command: ["bun", join(roots.guards, "hooks/run.ts"), name] }]
      : [];
  const fileChecks = [
    ...script(roots.tdd, "tdd-require-red.sh"),
    ...script(roots.codeStyle, "no-comments.sh"),
    ...script(roots.codeStyle, "naming-check.sh"),
  ];
  return {
    before: {
      Edit: fileChecks,
      Write: fileChecks,
      Bash: [
        ...guard("bash-guard"),
        ...guard("commit-guard"),
        ...script(roots.qualityGates, "fallow-gate.sh"),
      ],
      Read: guard("read-guard"),
    },
    after: { Bash: script(roots.tdd, "tdd-record-test-run.sh") },
  };
}

type ToolEvent = { tool: string; input: Record<string, unknown> };
type ToolOutcome = { status: string; result?: unknown; error?: Error };
type ToolCallback = (event: ToolEvent & ToolOutcome) => Promise<void> | void;
type PluginContext = {
  location: { directory: string };
  tool: { hook: (name: string, callback: ToolCallback) => Promise<unknown> };
};

const toolResponse = (outcome: ToolOutcome) =>
  outcome.status === "error"
    ? { exit_code: 1, stderr: outcome.error?.message ?? "" }
    : outcome.result;

export function createClaudeKitPlugin(
  hooks: ClaudeKitHooks,
  runHook: HookRunner,
  sessionId: string,
) {
  return {
    id: "claude-lite-claude-kit",
    async setup(context: PluginContext) {
      const directory = context.location.directory;
      const startedCallsInStartOrder: HookPayload[] = [];
      await context.tool.hook("execute.before", (event: ToolEvent) => {
        const payload = claudeHookPayload(event.tool, event.input, directory, sessionId);
        const toolName = payload.tool_name as string | undefined;
        for (const hook of (toolName && hooks.before[toolName]) || []) {
          const reason = runHook(hook, payload);
          if (reason) throw new Error(reason);
        }
        startedCallsInStartOrder.push(payload);
      });
      await context.tool.hook("execute.after", (outcome: ToolOutcome) => {
        const payload = startedCallsInStartOrder.shift();
        const toolName = payload?.tool_name as string | undefined;
        if (!payload || !toolName) return;
        for (const hook of hooks.after[toolName] ?? [])
          runHook(hook, { ...payload, tool_response: toolResponse(outcome) });
      });
    },
  };
}
