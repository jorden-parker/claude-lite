import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchMlx, mlxUrl } from "../src/mlx.ts";
import type { Runner } from "../src/ollama/launch.ts";

const home = join(import.meta.dir, "..");
const settingsPathOf = (argv: string[]) => argv[argv.indexOf("--settings") + 1];

const MODEL_35B = "mlx-community/Qwen3.6-35B-A3B-4bit";

type HarnessOptions = { servedReplies?: (string[] | null)[]; doesServerDie?: boolean };

function harness({
  servedReplies = [null, [MODEL_35B]],
  doesServerDie = false,
}: HarnessOptions = {}) {
  const events: string[] = [];
  const calls: string[][] = [];
  const envs: any[] = [];
  const written: any[] = [];
  const serverCommands: string[][] = [];
  let probeCount = 0;
  const servedModels = async () => {
    events.push("probe");
    return servedReplies[Math.min(probeCount++, servedReplies.length - 1)];
  };
  const run: Runner = async (argv, env) => {
    calls.push(argv);
    envs.push(env);
    if (argv[0] === "lsof") {
      events.push("lsof");
      return 0;
    }
    if (argv[0] === "claude") {
      events.push("claude");
      written.push(JSON.parse(readFileSync(settingsPathOf(argv), "utf8")));
      return 0;
    }
    events.push("download");
    return 0;
  };
  const startServer = (argv: string[]) => {
    events.push("serve");
    serverCommands.push(argv);
    return {
      exited: doesServerDie ? Promise.resolve(1) : new Promise<number>(() => {}),
      stop: () => events.push("stop"),
    };
  };
  const unload = async () => {
    events.push("unload");
    return [];
  };
  return {
    events,
    calls,
    envs,
    written,
    serverCommands,
    dependencies: { run, startServer, unload, servedModels, pollDelayMs: 0 },
  };
}

test("mlx downloads, unloads ollama, serves, waits, runs claude, then stops the server", async () => {
  const { events, calls, envs, written, serverCommands, dependencies } = harness();
  expect(await launchMlx(home, ["35b", "-p", "hi"], dependencies)).toBe(0);
  expect(events).toEqual(["probe", "download", "unload", "serve", "probe", "claude", "stop"]);
  const claude = calls.at(-1)!;
  expect(claude[claude.indexOf("--model") + 1]).toBe(MODEL_35B);
  expect(claude.slice(-2)).toEqual(["-p", "hi"]);
  expect(envs.at(-1).ANTHROPIC_BASE_URL).toBe(mlxUrl());
  expect(envs.at(-1).ANTHROPIC_API_KEY).toBeUndefined();
  expect(written[0].env.ANTHROPIC_BASE_URL).toBe(mlxUrl());
  const server = serverCommands[0];
  expect(server).toContain("mlx-community/Qwen3.6-35B-A3B-4bit");
  expect(server[server.indexOf("--tool-call-parser") + 1]).toBe("qwen3_xml");
  expect(server[server.indexOf("--port") + 1]).toBe(new URL(mlxUrl()).port);
});

test("mlx --qwen runs qwen against the vllm-mlx /v1 endpoint instead of claude", async () => {
  const { calls, envs, dependencies } = harness();
  expect(await launchMlx(home, ["35b", "--qwen", "-p", "hi"], dependencies)).toBe(0);
  expect(calls.some((argv) => argv[0] === "claude")).toBe(false);
  expect(calls.at(-1)).toEqual(["qwen", "--model", MODEL_35B, "-p", "hi"]);
  expect(envs.at(-1).OPENAI_BASE_URL).toBe(`${mlxUrl()}/v1`);
  expect(envs.at(-1).OPENAI_MODEL).toBe(MODEL_35B);
});

test("mlx reuses a server already serving the size's model and leaves it running", async () => {
  const { events, calls, dependencies } = harness({ servedReplies: [[MODEL_35B]] });
  expect(await launchMlx(home, ["35b"], dependencies)).toBe(0);
  expect(events).toEqual(["probe", "unload", "claude"]);
  expect(calls.at(-1)![0]).toBe("claude");
});

test("mlx names what holds the port when it serves something else", async () => {
  const { events, calls, dependencies } = harness({ servedReplies: [["other-model"]] });
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    expect(await launchMlx(home, ["35b"], dependencies)).toBe(1);
  } finally {
    console.error = original;
  }
  expect(events).toEqual(["probe", "lsof"]);
  expect(calls[0]).toContain(`-iTCP:${new URL(mlxUrl()).port}`);
  expect(errors[0]).toContain("other-model");
});

test("mlx skips claude when the server exits before it is ready", async () => {
  const { events, dependencies } = harness({ servedReplies: [null], doesServerDie: true });
  expect(await launchMlx(home, ["35b"], dependencies)).toBe(1);
  expect(events).not.toContain("claude");
  expect(events.at(-1)).toBe("stop");
});

test("mlx passes thinking off and the size's sampling as server defaults", async () => {
  const { serverCommands, dependencies } = harness();
  await launchMlx(home, ["35b"], dependencies);
  const server = serverCommands[0];
  const valueOf = (flag: string) => server[server.indexOf(flag) + 1];
  expect(valueOf("--default-chat-template-kwargs")).toBe(
    '{"enable_thinking":false,"preserve_thinking":true}',
  );
  expect(valueOf("--default-temperature")).toBe("0.7");
  expect(valueOf("--default-top-k")).toBe("20");
  expect(valueOf("--default-top-p")).toBe("0.8");
  expect(valueOf("--default-min-p")).toBe("0");
});

test("mlx --think leaves thinking to the model", async () => {
  const { serverCommands, dependencies } = harness();
  await launchMlx(home, ["35b", "--think"], dependencies);
  const server = serverCommands[0];
  expect(server[server.indexOf("--default-chat-template-kwargs") + 1]).toBe(
    '{"preserve_thinking":true}',
  );
});

test("mlx caps the prefix trie cache by entries and memory", async () => {
  const { serverCommands, dependencies } = harness();
  await launchMlx(home, ["35b"], dependencies);
  const server = serverCommands[0];
  const valueOf = (flag: string) => server[server.indexOf(flag) + 1];
  expect(valueOf("--prefix-trie-cache-size")).toBe("4");
  expect(valueOf("--prefix-trie-cache-memory-mb")).toBe("8192");
});

test("mlx skips the ollama unload when OLLAMA_HOST is another machine", async () => {
  const previous = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = "studio.local:11434";
  try {
    const { events, dependencies } = harness();
    expect(await launchMlx(home, ["35b"], dependencies)).toBe(0);
    expect(events).not.toContain("unload");
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = previous;
  }
});

test("mlx fails with a message for a size without an mlx model", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "claude-lite-mlx-"));
  cpSync(join(home, "config"), join(tempHome, "config"), { recursive: true });
  const sizesPath = join(tempHome, "config", "sizes.json");
  const sizes = JSON.parse(readFileSync(sizesPath, "utf8"));
  delete sizes["9b"].mlx;
  writeFileSync(sizesPath, JSON.stringify(sizes));
  writeFileSync(join(tempHome, "config", "local-sizes.json"), "{}");
  const { calls, dependencies } = harness();
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    expect(await launchMlx(tempHome, ["9b"], dependencies)).toBe(1);
  } finally {
    console.error = original;
  }
  expect(calls).toEqual([]);
  expect(errors[0]).toContain("9b has no mlx model");
});

test("mlx --print-config prints the server command and settings without running", async () => {
  const { calls, events, dependencies } = harness();
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    expect(await launchMlx(home, ["35b", "--print-config"], dependencies)).toBe(0);
  } finally {
    console.log = original;
  }
  expect(calls).toEqual([]);
  expect(events).toEqual([]);
  expect(lines[0]).toContain("vllm-mlx");
  expect(JSON.parse(lines[1]).env.ANTHROPIC_BASE_URL).toBe(mlxUrl());
});

test("mlx defaults to port 8435, clear of Ollama's runner on 11435", () => {
  expect(mlxUrl({})).toBe("http://127.0.0.1:8435");
});

test("CLAUDE_LITE_MLX_PORT moves the server and claude to that port", async () => {
  const previous = process.env.CLAUDE_LITE_MLX_PORT;
  process.env.CLAUDE_LITE_MLX_PORT = "9123";
  try {
    const { envs, serverCommands, dependencies } = harness();
    expect(await launchMlx(home, ["35b"], dependencies)).toBe(0);
    const server = serverCommands[0];
    expect(server[server.indexOf("--port") + 1]).toBe("9123");
    expect(envs.at(-1).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9123");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_LITE_MLX_PORT;
    else process.env.CLAUDE_LITE_MLX_PORT = previous;
  }
});

test("mlxUrl rejects a port that is not a number", () => {
  expect(() => mlxUrl({ CLAUDE_LITE_MLX_PORT: "abc" })).toThrow("CLAUDE_LITE_MLX_PORT");
});
