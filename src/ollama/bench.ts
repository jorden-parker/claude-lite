import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { mlxBenchChat } from "../mlx-bench.ts";
import { engineEvidence, logOffset, sampleModelMemory } from "../bench-runtime.ts";
import { withMlxBenchServer } from "../mlx.ts";
import { join } from "node:path";
import { compareBench, latestBench, saveBench } from "./bench-history.ts";
import {
  type ChatMessage,
  type ChatReply,
  type ChatRequest,
  fetchApi,
  isRemoteHost,
  ollamaUrl,
  type OllamaApi,
  type ToolCall,
} from "./api.ts";
import { modelParameters } from "./modelfile.ts";
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

type Verdict = string | null;
type BenchTask = {
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
    return `expected one ${name} call, got ${made.map((toolCall) => toolCall.function.name).join(",") || "none"}`;
  return made[0].function.name === name
    ? made[0]
    : `called ${made[0].function.name} instead of ${name}`;
};
const argumentText = (call: ToolCall, key: string) => String(call.function.arguments[key] ?? "");
const hasComment = (code: string) => /(^|\s)\/\/|\/\*|^\s*#(?!!)/m.test(code);
const wordCount = (content: string) => content.trim().split(/\s+/).filter(Boolean).length;

const searchesIgnoredPaths = (command: string) => {
  if (/\bgit\s+grep\b/.test(command)) return /--no-index|--no-exclude-standard/.test(command);
  if (/\brg\b/.test(command)) return /--no-ignore|\s-u+\b/.test(command);
  return true;
};

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
    name: "ignored-search",
    prompt:
      "Find where the zod package in node_modules defines ZodError. node_modules is gitignored.",
    check: (message) => {
      const call = expectOnlyCall(message, "Bash");
      if (typeof call === "string") return call;
      const command = argumentText(call, "command");
      if (!/grep|rg\b/.test(command)) return `no search in: ${command}`;
      if (!/ZodError/.test(command)) return "search misses the name";
      return searchesIgnoredPaths(command) ? null : `search skips ignored files: ${command}`;
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

type TaskResult = {
  name: string;
  failure: Verdict;
  evalCount: number;
  evalSeconds: number;
  promptCount: number;
  promptSeconds: number;
  loadSeconds?: number;
  firstTokenSeconds?: number;
  toolCallSeconds?: number;
  turnSeconds?: number;
  cachedTokens?: number;
};

type BenchResult = {
  model: string;
  thinking: boolean;
  effort?: string;
  tasks: TaskResult[];
  backend?: string;
  engine?: string;
  engineEvidence?: string | null;
  peakSampledModelBytes?: number;
};

const toSeconds = (nanoseconds = 0) => nanoseconds / 1e9;

function scoreTask(task: Pick<BenchTask, "name" | "check">, reply: ChatReply): TaskResult {
  return {
    name: task.name,
    failure: reply.tool_call_error ?? task.check(reply.message),
    evalCount: reply.eval_count ?? 0,
    evalSeconds: toSeconds(reply.eval_duration),
    promptCount: reply.prompt_eval_count ?? 0,
    promptSeconds: toSeconds(reply.prompt_eval_duration),
    loadSeconds: reply.load_duration === undefined ? undefined : toSeconds(reply.load_duration),
    firstTokenSeconds: reply.first_token_seconds,
    toolCallSeconds: reply.tool_call_seconds,
    cachedTokens: reply.cached_tokens,
  };
}

export async function runBench(
  size: Size,
  systemPrompt: string,
  tasks: BenchTask[],
  api: Pick<OllamaApi, "chat">,
  runs = 1,
): Promise<BenchResult> {
  const results: TaskResult[] = [];
  const repeated = Array.from({ length: runs }, () => tasks).flat();
  for (const task of repeated) {
    const started = performance.now();
    const reply = await api.chat({
      model: size.model,
      think: size.thinking ? (size.effort ?? true) : false,
      tools: TOOLS,
      options: modelParameters(size),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: task.prompt },
        ...(task.history ?? []),
      ],
    });
    results.push({ ...scoreTask(task, reply), turnSeconds: (performance.now() - started) / 1000 });
  }
  return { model: size.model, thinking: size.thinking, effort: size.effort, tasks: results };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const tokensPerSecond = (count: number, secondsTaken: number) =>
  secondsTaken > 0 ? count / secondsTaken : null;

export function summarize(result: BenchResult) {
  const { tasks } = result;
  const passed = tasks.filter((task) => task.failure === null).length;
  const loadTimes = tasks.map((task) => task.loadSeconds).filter((time) => time !== undefined);
  return {
    passed,
    total: tasks.length,
    generationTokensPerSecond: tokensPerSecond(
      sum(tasks.filter((task) => task.evalSeconds > 0).map((task) => task.evalCount)),
      sum(tasks.map((task) => task.evalSeconds)),
    ),
    promptTokensPerSecond: tokensPerSecond(
      sum(tasks.filter((task) => task.promptSeconds > 0).map((task) => task.promptCount)),
      sum(tasks.map((task) => task.promptSeconds)),
    ),
    loadSeconds: loadTimes.length ? Math.max(...loadTimes) : null,
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
  const speed = `${tokensPerSecond(first.evalCount, first.evalSeconds)?.toFixed(1) ?? "n/a"} t/s`;
  const firstToken =
    first.firstTokenSeconds === undefined
      ? ""
      : `, first token ${first.firstTokenSeconds.toFixed(1)} s`;
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
    `generation ${summary.generationTokensPerSecond?.toFixed(1) ?? "n/a"} t/s, prompt ${summary.promptTokensPerSecond?.toFixed(0) ?? "n/a"} t/s, load ${summary.loadSeconds === null ? "n/a" : summary.loadSeconds.toFixed(1) + " s"}`,
  ].join("\n");
}

const BENCH_WORDS = ["--json", "--compare", "--runs", "--backend", "--engine", "--long-context"];

function parseBenchArgs(args: string[]) {
  const runsAt = args.indexOf("--runs");
  const backendAt = args.indexOf("--backend");
  const engineAt = args.indexOf("--engine");
  const sizeArgs = args.filter(
    (arg, i) =>
      !BENCH_WORDS.includes(arg) &&
      !(runsAt >= 0 && i === runsAt + 1) &&
      !(backendAt >= 0 && i === backendAt + 1) &&
      !(engineAt >= 0 && i === engineAt + 1),
  );
  return {
    asJson: args.includes("--json"),
    shouldCompare: args.includes("--compare"),
    runs: runsAt < 0 ? 1 : Number(args[runsAt + 1]),
    longContext: args.includes("--long-context"),
    engineOverride: engineAt < 0 ? undefined : (args[engineAt + 1] ?? ""),
    backend: backendAt < 0 ? "ollama" : args[backendAt + 1],
    sizeArgs,
  };
}

const defaultHistoryDir = () =>
  join(process.env.HOME ?? homedir(), ".cache", "claude-lite", "bench");

const COLOR_PANELS =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PsQkAAAzDsPz/dHpCp2wCzwalybTxvgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+Dq47PDiz8p6GQAAAABJRU5ErkJggg==";

function readsFile(file: string) {
  return (message: ChatMessage): Verdict => {
    const call = expectOnlyCall(message, "Read");
    if (typeof call === "string") return call;
    return argumentText(call, "file_path").split("/").at(-1) === file
      ? null
      : `expected Read of ${file}`;
  };
}

async function codingProbes(
  size: Size,
  system: string,
  chat: OllamaApi["chat"],
  runs: number,
  longContext: boolean,
) {
  const tasks: TaskResult[] = [];
  const base = {
    model: size.model,
    tools: TOOLS,
    think: size.thinking ? (size.effort ?? true) : false,
    options: modelParameters(size),
  };
  async function measure(name: string, messages: ChatMessage[], check: BenchTask["check"]) {
    const started = performance.now();
    let reply: ChatReply;
    try {
      reply = await chat({ ...base, messages });
    } catch (error) {
      if (name !== "vision-colors" && !name.startsWith("coding-48k")) throw error;
      reply = { message: { role: "assistant", content: "" }, tool_call_error: String(error) };
    }
    const task = {
      ...scoreTask({ name, check }, reply),
      turnSeconds: (performance.now() - started) / 1000,
    };
    tasks.push(task);
    return { message: reply.message, passed: task.failure === null };
  }
  const systemMessage: ChatMessage = { role: "system", content: system };
  for (const length of longContext ? [4, 16, 48] : [4, 16]) {
    for (let run = 0; run < (length === 48 ? 1 : runs); run++) {
      // The Qwen tokenizer encodes each four-digit route declaration in 18 tokens.
      const rows = Array.from(
        { length: Math.ceil((length * 1024 - 600) / 18) },
        (_, i) =>
          `export const route${String(i).padStart(4, "0")} = "/v1/${String(i).padStart(4, "0")}";`,
      ).join("\n");
      const messages: ChatMessage[] = [
        systemMessage,
        {
          role: "user",
          content: `Snapshot ${randomUUID()}. The following routes.ts is already in memory. Read router.ts next, then read the file it imports. Use one Read per turn.\n\n${rows}`,
        },
      ];
      const label = `coding-${length}k`;
      const first = await measure(label + "-fresh", messages, readsFile("router.ts"));
      if (!first.passed) {
        tasks.push(
          scoreTask(
            {
              name: label + "-follow-up",
              check: () => "first turn failed to request router.ts",
            },
            { message: first.message },
          ),
        );
        continue;
      }
      await measure(
        label + "-follow-up",
        [
          ...messages,
          first.message,
          { role: "tool", tool_name: "Read", content: 'export { router } from "./dispatch.ts";' },
        ],
        readsFile("dispatch.ts"),
      );
    }
  }
  await measure(
    "vision-colors",
    [
      systemMessage,
      {
        role: "user",
        content: "Name the two colors in this image from left to right, in two words.",
        images: [COLOR_PANELS],
      },
    ],
    (message) =>
      !toolCallsOf(message).length && /\bred\b[^\n]*\bblue\b/i.test(message.content)
        ? null
        : "expected red then blue",
  );
  return tasks;
}

function median(values: (number | undefined)[]) {
  const sorted = values.filter((n): n is number => n !== undefined && n > 0).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export async function bench(
  home: string,
  args: string[],
  api: OllamaApi = fetchApi,
  historyDir = defaultHistoryDir(),
  mlxServer = withMlxBenchServer,
): Promise<number> {
  const { asJson, shouldCompare, runs, sizeArgs, backend, longContext, engineOverride } =
    parseBenchArgs(args);
  if (backend !== "ollama" && backend !== "mlx") {
    console.error("bench --backend needs ollama or mlx");
    return 2;
  }
  if (
    engineOverride !== undefined &&
    (backend !== "mlx" ||
      (engineOverride !== "mtp" && engineOverride !== "dflash" && engineOverride !== "splash"))
  ) {
    console.error("bench --engine needs --backend mlx and mtp, dflash or splash");
    return 2;
  }
  const { name, size: resolvedSize, claudeArgs } = resolveSize(home, sizeArgs);
  const size: Size =
    engineOverride !== undefined ? { ...resolvedSize, mlx_engine: engineOverride } : resolvedSize;
  if (claudeArgs.length) {
    console.error(`bench takes no claude args: ${claudeArgs.join(" ")}`);
    return 2;
  }
  if (!Number.isInteger(runs) || runs < 1) {
    console.error("bench --runs needs a whole number of 1 or more");
    return 2;
  }
  if (longContext && name !== "27b") {
    console.error("--long-context applies to the 27b coding benchmark");
    return 2;
  }
  const systemPrompt = readFileSync(join(home, "config", "system-prompt.md"), "utf8");
  const readme = readFileSync(join(home, "README.md"), "utf8");
  const tasks = [...TASKS, promptSpeedTask(readme)];
  async function measure(url: string, model: string, engine: string, log?: string) {
    const startOffset = backend === "ollama" ? logOffset(log) : 0;
    let evidence: string | null = null;
    let checkedFirstRequest = false;
    const chat = async (request: ChatRequest) => {
      const reply = backend === "mlx" ? await mlxBenchChat(url, request) : await api.chat(request);
      if (!checkedFirstRequest) {
        evidence = engineEvidence(engine, log, startOffset);
        checkedFirstRequest = true;
      }
      return reply;
    };
    const measuredSize = { ...size, model };
    let peak: number | undefined;
    let pending: Promise<void> | undefined;
    const sample = () => {
      if (!pending)
        pending = sampleModelMemory(url, backend!, model)
          .then((bytes) => {
            if (bytes !== undefined) peak = Math.max(peak ?? 0, bytes);
          })
          .finally(() => {
            pending = undefined;
          });
    };
    const timer = backend === "mlx" || api === fetchApi ? setInterval(sample, 2000) : undefined;
    let result: BenchResult;
    try {
      result = await runBench(measuredSize, systemPrompt, tasks, { chat }, runs);
      if (name === "27b")
        result.tasks.push(
          ...(await codingProbes(measuredSize, systemPrompt, chat, runs, longContext)),
        );
      if (timer) {
        sample();
        await pending;
      }
    } finally {
      clearInterval(timer);
    }
    Object.assign(result, {
      backend,
      engine,
      engineEvidence: evidence ?? engineEvidence(engine, log, startOffset),
      peakSampledModelBytes: peak,
    });
    const turns = [...groupByName(result.tasks)]
      .filter(([key]) => key.startsWith("coding-"))
      .map(([task, attempts]) => {
        const passed = attempts.filter((a) => a.failure === null);
        return {
          task,
          firstTokenSeconds: median(passed.map((a) => a.firstTokenSeconds)),
          turnSeconds: median(passed.map((a) => a.turnSeconds)),
          toolCallSeconds: median(passed.map((a) => a.toolCallSeconds)),
        };
      });
    const record = {
      ...result,
      turns,
      configuration: {
        context: size.context,
        outputTokens: size.output_tokens,
        sampling: size.parameters,
        base: backend === "ollama" ? size.base : size.mlx,
      },
      summary: summarize(result),
    };
    const previous = shouldCompare ? latestBench(historyDir, model, backend) : null;
    const comparison = previous
      ? compareBench(previous, record)
      : `no earlier run of ${model} to compare with`;
    saveBench(historyDir, record, new Date());
    if (asJson)
      console.log(JSON.stringify(shouldCompare ? { ...record, comparison } : record, null, 2));
    else {
      const seconds = (n?: number) => (n === undefined ? "n/a" : n.toFixed(2) + " s");
      console.log(
        `${formatBench(result)}\n${backend} / ${engine}: ${result.engineEvidence ?? "engine unconfirmed"}`,
      );
      if (peak) console.log(`peak sampled model memory ${(peak / 1024 ** 3).toFixed(1)} GiB`);
      for (const turn of turns)
        console.log(
          `${turn.task} median: first token ${seconds(turn.firstTokenSeconds)}, usable tool call ${seconds(turn.toolCallSeconds)}, turn ${seconds(turn.turnSeconds)}`,
        );
      if (shouldCompare) console.log(comparison);
    }
    return 0;
  }
  try {
    if (backend === "mlx") return await mlxServer(name, size, measure);
    const log =
      api === fetchApi && !isRemoteHost()
        ? join(homedir(), ".ollama", "logs", "server.log")
        : undefined;
    return await measure(ollamaUrl(), size.model, "ollama", log);
  } catch (error) {
    console.error(
      `${backend === "mlx" ? (size.mlx ?? name) : size.model} did not answer: ${(error as Error).message}`,
    );
    return 1;
  }
}
