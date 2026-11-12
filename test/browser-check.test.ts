import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, decideFromTranscript } from "../src/hooks/browser-check.ts";

const toolUse = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
const editUi = toolUse("Edit", { file_path: "/app/src/Page.tsx" });
const editServer = toolUse("Edit", { file_path: "/app/src/server.ts" });
const playwrightConsole = toolUse("mcp__playwright__browser_console_messages", {});
const chromeConsole = toolUse("mcp__claude-in-chrome__read_console_messages", {});
const navigateOnly = toolUse("mcp__playwright__browser_navigate", { url: "http://localhost" });
const agentBrowserConsole = toolUse("Bash", { command: "agent-browser console" });
const stop = { hook_event_name: "Stop" };
const blocks = (lines: string[]) => decide(stop, lines.join("\n"))?.exitCode === 2;

test("passes when no UI file was edited", () => expect(blocks([editServer])).toBe(false));

test("blocks a UI edit with no browser check", () => expect(blocks([editUi])).toBe(true));

test("blocks when the browser only navigated", () =>
  expect(blocks([editUi, navigateOnly])).toBe(true));

test("passes after Playwright console messages were read", () =>
  expect(blocks([editUi, navigateOnly, playwrightConsole])).toBe(false));

test("passes after Claude in Chrome console messages were read", () =>
  expect(blocks([editUi, chromeConsole])).toBe(false));

test("passes after agent-browser console was run", () =>
  expect(blocks([editUi, agentBrowserConsole])).toBe(false));

test("passes after agent-browser errors was run", () =>
  expect(blocks([editUi, toolUse("Bash", { command: "agent-browser errors" })])).toBe(false));

test("tells the agent the agent-browser commands", () =>
  expect(decide(stop, editUi)?.stderr).toContain("agent-browser console"));

test("blocks a UI edit made after the last console read", () =>
  expect(blocks([editUi, playwrightConsole, editUi])).toBe(true));

test("lets the agent stop on its second try", () =>
  expect(decide({ ...stop, stop_hook_active: true }, editUi)).toBeNull());

test("names the edited files in the reason", () =>
  expect(decide(stop, editUi)?.stderr).toContain("Page.tsx"));

test("ignores unparseable transcript lines", () =>
  expect(blocks(["not json", editServer])).toBe(false));

test("decideFromTranscript reads only the end of a long transcript", () => {
  const transcriptPath = join(mkdtempSync(join(tmpdir(), "bc-")), "session.jsonl");
  const filler = Array.from({ length: 50 }, () => editServer);
  writeFileSync(transcriptPath, [editUi, ...filler].join("\n"));
  const event = { hook_event_name: "Stop", transcript_path: transcriptPath };
  expect(decideFromTranscript(event)?.exitCode).toBe(2);
  expect(decideFromTranscript(event, 500)).toBeNull();
});
