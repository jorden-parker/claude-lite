import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { EDIT_TOOLS, type HookEvent, type HookResult } from "./types.ts";

const UI_FILE = /\.(?:[jt]sx|vue|svelte|astro|html|css|scss|sass|less)$/;
const CONSOLE_TOOL = /^mcp__(?:playwright|claude-in-chrome)__.*console/;
const AGENT_BROWSER_CONSOLE = /\bagent-browser\b.*\b(?:console|errors)\b/;

type ToolUse = { name?: string; input?: Record<string, any> };

function toolUsesIn(line: string): ToolUse[] {
  try {
    const content = JSON.parse(line)?.message?.content;
    return Array.isArray(content) ? content.filter((block) => block?.type === "tool_use") : [];
  } catch {
    return [];
  }
}

const readsConsole = (use: ToolUse) =>
  CONSOLE_TOOL.test(use.name ?? "") ||
  (use.name === "Bash" && AGENT_BROWSER_CONSOLE.test(use.input?.command ?? ""));

const editedUiFile = (use: ToolUse): string | null => {
  const path = use.input?.file_path;
  return EDIT_TOOLS.includes(use.name ?? "") && UI_FILE.test(path ?? "") ? path : null;
};

function uncheckedUiEdits(transcript: string): Set<string> {
  const edited = new Set<string>();
  for (const use of transcript.split("\n").flatMap(toolUsesIn)) {
    if (readsConsole(use)) edited.clear();
    const path = editedUiFile(use);
    if (path) edited.add(basename(path));
  }
  return edited;
}

export function decide(event: HookEvent, transcript: string): HookResult {
  if (event.stop_hook_active) return null;
  const files = [...uncheckedUiEdits(transcript)];
  if (files.length === 0) return null;
  return {
    exitCode: 2,
    stderr: `You edited ${files.join(", ")} but haven't checked it in a browser. Run: agent-browser open <url of the affected page>; agent-browser console; agent-browser errors --json; agent-browser screenshot <path>, then read the image. Fix what you find, then report the URL and what you saw. If agent-browser fails, say so plainly instead of claiming the change works.`,
  };
}

export function decideFromTranscript(event: HookEvent): HookResult {
  if (!event.transcript_path) return null;
  return decide(event, readFileSync(event.transcript_path, "utf8"));
}
