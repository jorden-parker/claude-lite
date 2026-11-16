import { homedir } from "node:os";
import { claudeKitHooks, createClaudeKitPlugin, runClaudeHook } from "./opencode-hooks.ts";

const sessionId = `opencode-${process.pid}-${Date.now()}`;

export default createClaudeKitPlugin(claudeKitHooks(homedir()), runClaudeHook, sessionId);
