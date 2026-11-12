import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareBench, latestBench, saveBench } from "./bench-history.ts";
import {
  type ChatMessage,
  type ChatReply,
  fetchApi,
  type OllamaApi,
  type ToolCall,
} from "./api.ts";
import { resolveSize, type Size } from "./sizes.ts";
import { unboundedGitLogReason } from "./git-log-guard.ts";

const defineTool = (name: string, description: string, properties: Record<string, unknown>) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required: Object.keys(properties) },
  },
});

export const TOOLS = [
  defineTool("Bash", "Run a shell command and return its output", {
    command: { type: "string", description: "The command to run" },
  }),
  defineTool("Read", "Read a file from the repository", {
    file_path: { type: "string", description: "Path of the file to read" },
  }),
  defineTool("Edit", "Replace one exact string in a file with another", {
    file_path: { type: "string" },
    old_string: { type: "string", description: "Exact text to replace" },
    new_string: { type: "string", description: "Replacement text" },
  }),
  defineTool("Write", "Create or overwrite a file", {
    file_path: { type: "string" },
    content: { type: "string" },
  }),
];

export type Verdict = string | null;
export type BenchTask = {
  name: string;
  prompt: string;
  history?: ChatMessage[];
  check: (message: ChatMessage) => Verdict;
};

const RENAME_SOURCE = `export function calc(items: number[]): number {
  let t = 0;
  for (const item of items) t += item;
  return t;
}
`;

const toolCallsOf = (message: ChatMessage): ToolCall[] => message.tool_calls ?? [];
const expectOnlyCall = (message: ChatMessage, name: string): ToolCall | string => {
  const made = toolCallsOf(message);
  if (made.length !== 1)
    return `expected one ${name} call, got ${made.map((c) => c.function.name).join(",") || "none"}`;
  return made[0].function.name === name
    ? made[0]
    : `called ${made[0].function.name} instead of ${name}`;
};
const argumentText = (call: ToolCall, key: string) => String(call.function.arguments[key] ?? "");
const hasComment = (code: string) => /(^|\s)\/\/|\/\*|^\s*#(?!!)/m.test(code);
const wordCount = (content: string) => content.trim().split(/\s+/).filter(Boolean).length;

const DENIED_COMMAND = "git log";
const deniedCall: ChatMessage = {
  role: "assistant",
  content: "",
  tool_calls: [{ function: { name: "Bash", arguments: { command: DENIED_COMMAND } } }],
};

export const TASKS: BenchTask[] = [
  {
    name: "read-file",
    prompt: "Show me what src/cli.ts does.",
    check: (message) => {
      const call = expectOnlyCall(message, "Read");
      if (typeof call === "string") return call;
      return argumentText(call, "file_path").endsWith("src/cli.ts")
        ? null
        : `read ${argumentText(call, "file_path")}`;
    },
  },
  {
    name: "edit-rename",
    prompt: `In src/sum.ts, rename the function calc to sumOf and its variable t to total. The file currently reads:\n\n${RENAME_SOURCE}`,
    check: (message) => {
      const call = expectOnlyCall(message, "Edit");
      if (typeof call === "string") return call;
      const after = argumentText(call, "new_string");
      if (!RENAME_SOURCE.includes(argumentText(call, "old_string")))
        return "old_string is not in the file";
      if (!after.includes("sumOf") || !after.includes("total"))
        return "new_string misses a new name";
      return hasComment(after) ? "new_string adds a comment" : null;
    },
  },
  {
    name: "code-no-comments",
    prompt:
      "Reply with only a TypeScript function isLeapYear(year: number): boolean. No prose, no code comments.",
    check: (message) => {
      if (toolCallsOf(message).length) return "called a tool";
      if (!/isLeapYear/.test(message.content)) return "no isLeapYear";
      if (!/% ?400/.test(message.content)) return "no 400-year rule";
      return hasComment(message.content) ? "contains a comment" : null;
    },
  },
  {
    name: "direct-answer",
    prompt: "In one sentence, what does `git log --oneline -5` print?",
    check: (message) => {
      if (toolCallsOf(message).length) return "called a tool";
      if (!/commit/i.test(message.content)) return "does not mention commits";
      return wordCount(message.content) <= 60 ? null : `${wordCount(message.content)} words`;
    },
  },
  {
    name: "bounded-search",
    prompt: "Find which file defines the function renderSettings in this repository.",
    check: (message) => {
      const call = expectOnlyCall(message, "Bash");
      if (typeof call === "string") return call;
      const command = argumentText(call, "command");
      if (!/grep|rg\b/.test(command)) return `no search in: ${command}`;
      return /renderSettings/.test(command) ? null : "search misses the name";
    },
  },
  {
    name: "write-test",
    prompt:
      "Create test/leap.test.ts with one bun test that expects isLeapYear(2000) from ../src/leap.ts to be true.",
    check: (message) => {
      const call = expectOnlyCall(message, "Write");
      if (typeof call === "string") return call;
      const content = argumentText(call, "content");
      if (!argumentText(call, "file_path").endsWith("test/leap.test.ts"))
        return `wrote ${argumentText(call, "file_path")}`;
      if (!/bun:test/.test(content)) return "does not import bun:test";
      if (!/expect\(isLeapYear\(2000\)\)\.toBe\(true\)/.test(content.replace(/\s/g, "")))
        return "no toBe(true) expectation";
      return hasComment(content) ? "contains a comment" : null;
    },
  },
  {
    name: "deny-recovery",
    prompt: "Show me the recent commits in this repository.",
    history: [
      deniedCall,
      { role: "tool", content: `Denied by a hook: ${unboundedGitLogReason(DENIED_COMMAND)}` },
    ],
    check: (message) => {
      const call = expectOnlyCall(message, "Bash");
      if (typeof call === "string") return call;
      const command = argumentText(call, "command");
      if (command.trim() === DENIED_COMMAND) return "retried the denied command unchanged";
      return unboundedGitLogReason(command) === null ? null : `still denied: ${command}`;
    },
  },
];

export const promptSpeedTask = (document: string): BenchTask => ({
  name: "long-prompt",
  prompt: `Here is a README. Answer in one sentence: what does its first heading say?\n\n${document}`,
  check: (message) => (message.content.trim() ? null : "empty answer"),
});

export type TaskResult = {
  name: string;
  failure: Verdict;
  evalCount: number;
  evalSeconds: number;
  promptCount: number;
  promptSeconds: number;
  loadSeconds: number;
  firstTokenSeconds: number;
};

export type BenchResult = {
  model: string;
  thinking: boolean;
  effort?: string;
  tasks: TaskResult[];
};

const toSeconds = (nanoseconds = 0) => nanoseconds / 1e9;

function scoreTask(task: BenchTask, reply: ChatReply): TaskResult {
  return {
    name: task.name,
    failure: task.check(reply.message),
    evalCount: reply.eval_count ?? 0,
    evalSeconds: toSeconds(reply.eval_duration),
    promptCount: reply.prompt_eval_count ?? 0,
    promptSeconds: toSeconds(reply.prompt_eval_duration),
    loadSeconds: toSeconds(reply.load_duration),
    firstTokenSeconds: reply.first_token_seconds ?? 0,
  };
}

export async function runBench(
  size: Size,
  systemPrompt: string,
  tasks: BenchTask[],
  api: OllamaApi,
  runs = 1,
): Promise<BenchResult> {
  const results: TaskResult[] = [];
  const repeated = Array.from({ length: runs }, () => tasks).flat();
  for (const task of repeated) {
    const reply = await api.chat({
      model: size.model,
      think: size.thinking ? (size.effort ?? true) : false,
      tools: TOOLS,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: task.prompt },
        ...(task.history ?? []),
      ],
    });
    results.push(scoreTask(task, reply));
  }
  return { model: size.model, thinking: size.thinking, effort: size.effort, tasks: results };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const tokensPerSecond = (count: number, secondsTaken: number) =>
  secondsTaken > 0 ? count / secondsTaken : 0;

export function summarize(result: BenchResult) {
  const { tasks } = result;
  const passed = tasks.filter((task) => task.failure === null).length;
  return {
    passed,
    total: tasks.length,
    generationTokensPerSecond: tokensPerSecond(
      sum(tasks.map((task) => task.evalCount)),
      sum(tasks.map((task) => task.evalSeconds)),
    ),
    promptTokensPerSecond: tokensPerSecond(
      sum(tasks.map((task) => task.promptCount)),
      sum(tasks.map((task) => task.promptSeconds)),
    ),
    loadSeconds: Math.max(...tasks.map((task) => task.loadSeconds), 0),
  };
}

function groupByName(tasks: TaskResult[]): Map<string, TaskResult[]> {
  const groups = new Map<string, TaskResult[]>();
  for (const task of tasks) groups.set(task.name, [...(groups.get(task.name) ?? []), task]);
  return groups;
}

function taskLine(attempts: TaskResult[]): string {
  const [first] = attempts;
  const failed = attempts.find((attempt) => attempt.failure !== null);
  if (attempts.length > 1) {
    const passed = attempts.filter((attempt) => attempt.failure === null).length;
    return `${passed}/${attempts.length} ${first.name}${failed ? `: ${failed.failure}` : ""}`;
  }
  if (failed) return `FAIL ${first.name}: ${failed.failure}`;
  const speed = `${tokensPerSecond(first.evalCount, first.evalSeconds).toFixed(1)} t/s`;
  const firstToken =
    first.firstTokenSeconds > 0 ? `, first token ${first.firstTokenSeconds.toFixed(1)} s` : "";
  return `PASS ${first.name} (${speed}${firstToken})`;
}

export function formatBench(result: BenchResult): string {
  const summary = summarize(result);
  const mode = result.thinking ? `thinking ${result.effort ?? "on"}` : "thinking off";
  const lines = [...groupByName(result.tasks).values()].map(taskLine);
  return [
    `${result.model} (${mode})`,
    ...lines,
    `quality ${summary.passed}/${summary.total}`,
    `generation ${summary.generationTokensPerSecond.toFixed(1)} t/s, prompt ${summary.promptTokensPerSecond.toFixed(0)} t/s, load ${summary.loadSeconds.toFixed(1)} s`,
  ].join("\n");
}

const BENCH_WORDS = ["--json", "--compare", "--runs"];

function parseBenchArgs(args: string[]) {
  const runsAt = args.indexOf("--runs");
  const isOwnWord = (arg: string, i: number) =>
    BENCH_WORDS.includes(arg) || (runsAt >= 0 && i === runsAt + 1);
  return {
    asJson: args.includes("--json"),
    shouldCompare: args.includes("--compare"),
    runs: runsAt < 0 ? 1 : Number(args[runsAt + 1]),
    sizeArgs: args.filter((arg, i) => !isOwnWord(arg, i)),
  };
}

const defaultHistoryDir = () =>
  join(process.env.HOME ?? homedir(), ".cache", "claude-lite", "bench");

export async function bench(
  home: string,
  args: string[],
  api: OllamaApi = fetchApi,
  historyDir = defaultHistoryDir(),
): Promise<number> {
  const { asJson, shouldCompare, runs, sizeArgs } = parseBenchArgs(args);
  const { size, claudeArgs } = resolveSize(home, sizeArgs);
  if (claudeArgs.length) {
    console.error(`bench takes no claude args: ${claudeArgs.join(" ")}`);
    return 2;
  }
  if (!Number.isInteger(runs) || runs < 1) {
    console.error("bench --runs needs a whole number of 1 or more");
    return 2;
  }
  const systemPrompt = readFileSync(join(home, "config", "system-prompt.md"), "utf8");
  const readme = readFileSync(join(home, "README.md"), "utf8");
  const tasks = [...TASKS, promptSpeedTask(readme)];
  let result: BenchResult;
  try {
    result = await runBench(size, systemPrompt, tasks, api, runs);
  } catch (error) {
    console.error(`${size.model} did not answer: ${(error as Error).message}`);
    return 1;
  }
  const record = { ...result, summary: summarize(result) };
  const previous = shouldCompare ? latestBench(historyDir, size.model) : null;
  const noEarlierRun = `no earlier run of ${size.model} to compare with`;
  const comparison = previous ? compareBench(previous, record) : noEarlierRun;
  saveBench(historyDir, record, new Date());
  if (asJson) {
    console.log(JSON.stringify(shouldCompare ? { ...record, comparison } : record, null, 2));
    return 0;
  }
  console.log(formatBench(result));
  if (shouldCompare) console.log(comparison);
  return 0;
}
