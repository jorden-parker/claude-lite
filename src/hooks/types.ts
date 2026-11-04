export type HookEvent = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  tool_response?: Record<string, any>;
};

export type HookResult = { output?: unknown; exitCode?: number; stderr?: string } | null;

export const deny = (reason: string, hookEventName = "PreToolUse"): HookResult => ({
  output: {
    hookSpecificOutput: { hookEventName, permissionDecision: "deny", permissionDecisionReason: reason },
  },
});
