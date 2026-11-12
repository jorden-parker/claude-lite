import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ChatReply, ChatRequest, OllamaApi } from "../src/ollama/api.ts";
import {
  bench,
  formatBench,
  promptSpeedTask,
  runBench,
  summarize,
  TASKS,
  TOOLS,
} from "../src/ollama/bench.ts";
import { loadSizes } from "../src/ollama/sizes.ts";

const home = join(import.meta.dir, "..");
const historyDir = () => join(mkdtempSync(join(tmpdir(), "bench-history-")), "history");
const task = (name: string) => TASKS.find((candidate) => candidate.name === name)!;
const say = (content: string): ChatMessage => ({ role: "assistant", content });
const call = (name: string, args: Record<string, unknown>): ChatMessage => ({
  role: "assistant",
  content: "",
  tool_calls: [{ function: { name, arguments: args } }],
});

test("read-file passes only on a single Read of src/cli.ts", () => {
  expect(task("read-file").check(call("Read", { file_path: "src/cli.ts" }))).toBeNull();
  expect(task("read-file").check(call("Read", { file_path: "/repo/src/cli.ts" }))).toBeNull();
  expect(task("read-file").check(call("Bash", { command: "cat src/cli.ts" }))).toContain("Bash");
  expect(task("read-file").check(say("It dispatches commands."))).toContain("none");
});

test("edit-rename needs an exact old_string and both new names without comments", () => {
  const good = call("Edit", {
    file_path: "src/sum.ts",
    old_string: "export function calc(items: number[]): number {\n  let t = 0;",
    new_string: "export function sumOf(items: number[]): number {\n  let total = 0;",
  });
  expect(task("edit-rename").check(good)).toBeNull();
  const stale = call("Edit", { old_string: "function compute(", new_string: "sumOf total" });
  expect(task("edit-rename").check(stale)).toContain("not in the file");
  const commented = call("Edit", {
    old_string: "return t;",
    new_string: "return total; // sumOf",
  });
  expect(task("edit-rename").check(commented)).toContain("comment");
});

test("code-no-comments rejects tools, comments and a missing 400-year rule", () => {
  const good = say(
    "```ts\nfunction isLeapYear(year: number): boolean {\n  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;\n}\n```",
  );
  expect(task("code-no-comments").check(good)).toBeNull();
  expect(
    task("code-no-comments").check(say("function isLeapYear(y) { return y % 4 === 0; }")),
  ).toContain("400");
  expect(
    task("code-no-comments").check(
      say("// leap\nfunction isLeapYear(y) { return y % 400 === 0; }"),
    ),
  ).toContain("comment");
  expect(task("code-no-comments").check(call("Write", {}))).toContain("tool");
});

test("direct-answer wants a short sentence about commits and no tool", () => {
  expect(
    task("direct-answer").check(say("It prints the last five commits, one per line.")),
  ).toBeNull();
  expect(task("direct-answer").check(say("word ".repeat(70) + "commit"))).toContain("words");
  expect(task("direct-answer").check(call("Bash", { command: "git log" }))).toContain("tool");
});

test("bounded-search wants a grep for the name", () => {
  expect(
    task("bounded-search").check(call("Bash", { command: "git grep -n renderSettings" })),
  ).toBeNull();
  expect(
    task("bounded-search").check(call("Bash", { command: "rg renderSettings src" })),
  ).toBeNull();
  expect(
    task("bounded-search").check(call("Bash", { command: "cat src/ollama/settings.ts" })),
  ).toContain("no search");
  expect(task("bounded-search").check(call("Read", { file_path: "src" }))).toContain("Read");
});

test("write-test wants a bun test file with the expectation", () => {
  const good = call("Write", {
    file_path: "test/leap.test.ts",
    content:
      'import { expect, test } from "bun:test";\nimport { isLeapYear } from "../src/leap.ts";\n\ntest("2000", () => {\n  expect(isLeapYear(2000)).toBe(true);\n});\n',
  });
  expect(task("write-test").check(good)).toBeNull();
  expect(task("write-test").check(call("Write", { file_path: "leap.ts", content: "" }))).toContain(
    "wrote",
  );
  expect(
    task("write-test").check(
      call("Write", { file_path: "test/leap.test.ts", content: "import 'bun:test'" }),
    ),
  ).toContain("expectation");
});

test("long-prompt task passes on any non-empty answer", () => {
  expect(promptSpeedTask("# Title").check(say("The heading says Title."))).toBeNull();
  expect(promptSpeedTask("# Title").check(say("  "))).toContain("empty");
});

test("tools cover the four Claude Code tools the launcher enables", () => {
  expect(TOOLS.map((entry) => entry.function.name)).toEqual(["Bash", "Read", "Edit", "Write"]);
});

const reply = (message: ChatMessage, evalCount: number): ChatReply => ({
  message,
  eval_count: evalCount,
  eval_duration: 1e9,
  prompt_eval_count: 100,
  prompt_eval_duration: 0.5e9,
  load_duration: 2e9,
});

const scriptedApi = (answer: (request: ChatRequest) => ChatReply) => {
  const requests: ChatRequest[] = [];
  const api: OllamaApi = {
    load: async () => null,
    chat: async (request) => {
      requests.push(request);
      return answer(request);
    },
  };
  return { api, requests };
};

test("runBench sends the system prompt, tools and thinking mode, then summarizes", async () => {
  const size = { ...loadSizes(home)["9b"], thinking: true, effort: "low" };
  const { api, requests } = scriptedApi((request) =>
    reply(
      request.messages[1].content.includes("src/cli.ts")
        ? call("Read", { file_path: "src/cli.ts" })
        : say("no idea"),
      20,
    ),
  );
  const result = await runBench(size, "be brief", [task("read-file"), task("direct-answer")], api);
  expect(requests[0].messages[0]).toEqual({ role: "system", content: "be brief" });
  expect(requests[0].tools).toBe(TOOLS);
  expect(requests[0].think).toBe("low");
  expect(result.tasks.map((task) => task.failure === null)).toEqual([true, false]);
  const summary = summarize(result);
  expect(summary).toMatchObject({ passed: 1, total: 2, loadSeconds: 2 });
  expect(summary.generationTokensPerSecond).toBeCloseTo(20);
  expect(summary.promptTokensPerSecond).toBeCloseTo(200);
  const text = formatBench(result);
  expect(text).toContain("qwen3.5-9b-mtp-cc (thinking low)");
  expect(text).toContain("PASS read-file (20.0 t/s)");
  expect(text).toContain("FAIL direct-answer: does not mention commits");
  expect(text).toContain("quality 1/2");
});

test("thinking off sends think false", async () => {
  const { api, requests } = scriptedApi(() => reply(say("x"), 1));
  await runBench(loadSizes(home)["9b"], "", [task("direct-answer")], api);
  expect(requests[0].think).toBe(false);
});

test("bench runs every task plus the long prompt and prints json on request", async () => {
  const { api, requests } = scriptedApi(() => reply(say("commit"), 1));
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    expect(await bench(home, ["9b", "--json"], api, historyDir())).toBe(0);
  } finally {
    console.log = original;
  }
  expect(requests.length).toBe(TASKS.length + 1);
  expect(requests.at(-1)!.messages[1].content).toContain("# claude-lite");
  const parsed = JSON.parse(lines[0]);
  expect(parsed.summary.total).toBe(TASKS.length + 1);
});

test("bench rejects claude args", async () => {
  const { api } = scriptedApi(() => reply(say(""), 1));
  expect(await bench(home, ["9b", "-p", "hi"], api)).toBe(2);
});

test("bench exits 1 with the server's reason when the model cannot answer", async () => {
  const api: OllamaApi = {
    load: async () => null,
    chat: async () => {
      throw new Error("model requires 16.9 GiB but only 11.3 GiB are available");
    },
  };
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    expect(await bench(home, ["27b"], api)).toBe(1);
  } finally {
    console.error = original;
  }
  expect(errors[0]).toBe(
    "qwen3.8-27b-dflash-cc did not answer: model requires 16.9 GiB but only 11.3 GiB are available",
  );
});

test("runBench repeats every task and formatBench shows pass counts per task", async () => {
  let asked = 0;
  const { api, requests } = scriptedApi(() =>
    reply(say(asked++ === 0 ? "the last commits" : "nothing"), 10),
  );
  const result = await runBench(loadSizes(home)["9b"], "", [task("direct-answer")], api, 2);
  expect(requests).toHaveLength(2);
  expect(result.tasks.map((entry) => entry.failure === null)).toEqual([true, false]);
  const text = formatBench(result);
  expect(text).toContain("1/2 direct-answer: does not mention commits");
  expect(text).toContain("quality 1/2");
});

test("bench saves each run and --compare prints the change from the previous one", async () => {
  const dir = historyDir();
  const total = TASKS.length + 1;
  const { api, requests } = scriptedApi(() => reply(say("commit"), 1));
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => printed.push(line);
  try {
    expect(await bench(home, ["9b", "--runs", "2"], api, dir)).toBe(0);
    expect(await bench(home, ["9b", "--compare"], api, dir)).toBe(0);
    expect(await bench(home, ["9b", "--json", "--compare"], api, dir)).toBe(0);
    expect(await bench(home, ["9b", "--runs", "2.5"], api, dir)).toBe(2);
  } finally {
    console.log = originalLog;
  }
  expect(requests).toHaveLength(4 * total);
  expect(readdirSync(dir)).toHaveLength(3);
  expect(printed[2]).toContain("compared with ");
  expect(printed[2]).toContain(`quality 4/${2 * total} -> 2/${total}`);
  expect(JSON.parse(printed[3]).comparison).toContain(`quality 2/${total} -> 2/${total}`);
});

test("deny-recovery passes only when the next call gets past bash-guard", () => {
  const recovery = task("deny-recovery");
  expect(recovery.check(call("Bash", { command: "git log --oneline -n 20" }))).toBeNull();
  expect(recovery.check(call("Bash", { command: "git log" }))).toContain("unchanged");
  expect(recovery.check(call("Bash", { command: "git log --stat" }))).toContain("still denied");
  expect(recovery.check(call("Read", { file_path: "CHANGELOG.md" }))).toContain("Read");
});

test("runBench replays the denied call and the hook's reason before the model answers", async () => {
  const { api, requests } = scriptedApi(() => reply(say("nothing"), 1));
  await runBench(loadSizes(home)["9b"], "", [task("deny-recovery")], api);
  const [, , denied, refusal] = requests[0].messages;
  expect(denied.tool_calls?.[0].function.arguments).toEqual({ command: "git log" });
  expect(refusal.role).toBe("tool");
  expect(refusal.content).toContain("Unbounded git log");
});

test("bench reports the time to the first token when the api measures it", async () => {
  const { api } = scriptedApi(() => ({
    ...reply(call("Read", { file_path: "src/cli.ts" }), 20),
    first_token_seconds: 0.42,
  }));
  const result = await runBench(loadSizes(home)["9b"], "", [task("read-file")], api);
  expect(result.tasks[0].firstTokenSeconds).toBe(0.42);
  expect(formatBench(result)).toContain("PASS read-file (20.0 t/s, first token 0.4 s)");
});
