import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeHookPayload,
  claudeKitHooks,
  createClaudeKitPlugin,
  hookBlockReason,
  runClaudeHook,
  type ClaudeHook,
} from "../src/opencode-hooks.ts";

const PROJECT = "/work/project";

test("an OpenCode edit becomes the Claude Code Edit payload the hook scripts read", () => {
  const input = { filePath: `${PROJECT}/src/a.ts`, oldString: "old", newString: "new" };
  expect(claudeHookPayload("edit", input, PROJECT, "session-1")).toEqual({
    session_id: "session-1",
    cwd: PROJECT,
    tool_name: "Edit",
    tool_input: { file_path: `${PROJECT}/src/a.ts`, old_string: "old", new_string: "new" },
  });
});

test("an OpenCode write and bash map to Write content and Bash command", () => {
  expect(
    claudeHookPayload("write", { filePath: "/f.ts", content: "x" }, PROJECT, "s").tool_input,
  ).toEqual({ file_path: "/f.ts", content: "x" });
  expect(claudeHookPayload("bash", { command: "ls" }, PROJECT, "s")).toMatchObject({
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
});

test("a tool with no Claude Code counterpart has no payload", () => {
  expect(claudeHookPayload("webfetch", { url: "x" }, PROJECT, "s").tool_name).toBeUndefined();
});

test("exit 2 blocks with the script's stderr", () => {
  expect(hookBlockReason(2, "", "write a failing test first\n")).toBe("write a failing test first");
});

test("a deny decision on stdout blocks with its reason", () => {
  const denial = JSON.stringify({
    hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "use rg" },
  });
  expect(hookBlockReason(0, denial, "")).toBe("use rg");
});

test("a clean exit or a non-blocking failure lets the tool run", () => {
  expect(hookBlockReason(0, "", "")).toBeNull();
  expect(hookBlockReason(1, "not json", "crashed")).toBeNull();
});

test("runClaudeHook feeds the payload on stdin and passes the plugin root", () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), "claude-kit-hook-"));
  const script = join(pluginRoot, "block.sh");
  writeFileSync(
    script,
    '#!/bin/sh\npayload=$(cat)\necho "$CLAUDE_PLUGIN_ROOT $payload" >&2\nexit 2\n',
  );
  chmodSync(script, 0o755);
  const reason = runClaudeHook({ pluginRoot, command: [script] }, { tool_name: "Edit" });
  expect(reason).toBe(`${pluginRoot} {"tool_name":"Edit"}`);
});

const fakeKit = (versions: Record<string, string[]>) => {
  const userHome = mkdtempSync(join(tmpdir(), "claude-kit-home-"));
  for (const [plugin, pluginVersions] of Object.entries(versions))
    for (const version of pluginVersions)
      mkdirSync(join(userHome, ".claude/plugins/cache/claude-kit", plugin, version, "hooks"), {
        recursive: true,
      });
  return userHome;
};

test("claudeKitHooks uses the newest installed version of each plugin", () => {
  const userHome = fakeKit({ tdd: ["0.1.0", "0.10.0", "0.9.0"] });
  const tddRoot = join(userHome, ".claude/plugins/cache/claude-kit/tdd/0.10.0");
  expect(claudeKitHooks(userHome).before.Edit).toContainEqual({
    pluginRoot: tddRoot,
    command: [join(tddRoot, "hooks/tdd-require-red.sh")],
  });
  expect(claudeKitHooks(userHome).after.Bash).toEqual([
    { pluginRoot: tddRoot, command: [join(tddRoot, "hooks/tdd-record-test-run.sh")] },
  ]);
});

test("claudeKitHooks leaves out plugins that are not installed", () => {
  const userHome = fakeKit({ guards: ["0.1.0"] });
  const guardsRoot = join(userHome, ".claude/plugins/cache/claude-kit/guards/0.1.0");
  expect(claudeKitHooks(userHome).before.Edit).toEqual([]);
  expect(claudeKitHooks(userHome).before.Read).toEqual([
    { pluginRoot: guardsRoot, command: ["bun", join(guardsRoot, "hooks/run.ts"), "read-guard"] },
  ]);
});

type Callback = (event: Record<string, unknown>) => Promise<void> | void;

const fakeContext = () => {
  const callbacks: Record<string, Callback> = {};
  const context = {
    location: { directory: PROJECT },
    tool: {
      hook: async (name: string, callback: (event: never) => Promise<void> | void) => {
        callbacks[name] = callback as Callback;
        return {};
      },
    },
  };
  return { callbacks, context };
};

const blockingHook: ClaudeHook = { pluginRoot: "/kit/tdd", command: ["block"] };
const recordingHook: ClaudeHook = { pluginRoot: "/kit/tdd", command: ["record"] };

test("the plugin blocks a tool call when a before hook objects", async () => {
  const hooks = { before: { Edit: [blockingHook] }, after: {} };
  const plugin = createClaudeKitPlugin(hooks, () => "write a failing test first", "s");
  const { callbacks, context } = fakeContext();
  await plugin.setup(context);
  const edit = { tool: "edit", input: { filePath: `${PROJECT}/a.ts`, newString: "x" } };
  expect(() => callbacks["execute.before"](edit)).toThrow("write a failing test first");
});

test("the plugin lets tools without hooks run", async () => {
  const plugin = createClaudeKitPlugin({ before: {}, after: {} }, () => "never", "s");
  const { callbacks, context } = fakeContext();
  await plugin.setup(context);
  expect(() => callbacks["execute.before"]({ tool: "read", input: {} })).not.toThrow();
});

test("the plugin hands a finished bash call and its output to the after hooks", async () => {
  const seen: Record<string, unknown>[] = [];
  const hooks = { before: {}, after: { Bash: [recordingHook] } };
  const runHook = (_hook: ClaudeHook, payload: Record<string, unknown>) => {
    seen.push(payload);
    return null;
  };
  const plugin = createClaudeKitPlugin(hooks, runHook, "session-1");
  const { callbacks, context } = fakeContext();
  await plugin.setup(context);
  await callbacks["execute.before"]({ tool: "bash", input: { command: "bun test" } });
  await callbacks["execute.after"]({ status: "completed", result: "1 fail" });
  await callbacks["execute.before"]({ tool: "bash", input: { command: "bun test" } });
  await callbacks["execute.after"]({ status: "error", error: new Error("killed") });
  expect(seen).toEqual([
    {
      session_id: "session-1",
      cwd: PROJECT,
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: "1 fail",
    },
    {
      session_id: "session-1",
      cwd: PROJECT,
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: { exit_code: 1, stderr: "killed" },
    },
  ]);
});

test("the plugin file OpenCode loads default-exports a V2 plugin definition", async () => {
  const definition = (await import("../src/opencode-plugin.ts")).default;
  expect(definition.id).toBe("claude-lite-claude-kit");
  expect(typeof definition.setup).toBe("function");
});
