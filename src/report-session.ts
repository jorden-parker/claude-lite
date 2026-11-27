export type ToolEvent = {
  name: string;
  at: string;
  result?: string;
  failed?: boolean;
  continued?: boolean;
};

export type ReportSession = {
  client: "Claude Code" | "Qwen Code" | "OpenCode";
  id: string;
  project: string;
  model?: string;
  lastActivity: string;
  live?: boolean;
  tools: ToolEvent[];
};

export type SessionInventory = {
  sessions: ReportSession[];
  warnings: string[];
};

export const slowToolMs = 60_000;

export function elapsedMs(event: ToolEvent) {
  return event.result ? Date.parse(event.result) - Date.parse(event.at) : undefined;
}

export function isFinding(event: ToolEvent) {
  return event.failed || !event.result || (elapsedMs(event) ?? 0) >= slowToolMs;
}

export function eventStatus(event: ToolEvent) {
  if (event.failed) return "Error returned";
  if (event.continued && !event.result) return "Continued without result";
  if (!event.result) return "No recorded result";
  return isFinding(event) ? "Slow result" : "Result returned";
}
