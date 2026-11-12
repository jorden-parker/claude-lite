import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchMlx, MLX_URL } from "../src/mlx.ts";
import type { Runner } from "../src/ollama/launch.ts";

const home = join(import.meta.dir, "..");
const settingsPathOf = (argv: string[]) => argv[argv.indexOf("--settings") + 1];

type HarnessOptions = { isPortBusy?: boolean; doesServerDie?: boolean };

function harness({ isPortBusy = false, doesServerDie = false }: HarnessOptions = {}) {
  const events: string[] = [];
  const calls: string[][] = [];
  const envs: any[] = [];
  const written: any[] = [];
  const serverCommands: string[][] = [];
  let curlCount = 0;
  const run: Runner = async (argv, env) => {
    calls.push(argv);
    envs.push(env);
    if (argv[0] === "curl") {
      events.push("curl");
      curlCount++;
      if (curlCount === 1) return isPortBusy ? 0 : 7;
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
    dependencies: { run, startServer, unload, pollDelayMs: 0 },
  };
}

test("mlx downloads, unloads ollama, serves, waits, runs claude, then stops the server", async () => {
  const { events, calls, envs, written, serverCommands, dependencies } = harness();
  expect(await launchMlx(home, ["35b", "-p", "hi"], dependencies)).toBe(0);
  expect(events).toEqual(["curl", "download", "unload", "serve", "curl", "claude", "stop"]);
  const claude = calls.at(-1)!;
  expect(claude[claude.indexOf("--model") + 1]).toBe("mlx-community/Qwen3.6-35B-A3B-4bit");
  expect(claude.slice(-2)).toEqual(["-p", "hi"]);
  expect(envs.at(-1).ANTHROPIC_BASE_URL).toBe(MLX_URL);
  expect(envs.at(-1).ANTHROPIC_API_KEY).toBeUndefined();
  expect(written[0].env.ANTHROPIC_BASE_URL).toBe(MLX_URL);
  const server = serverCommands[0];
  expect(server).toContain("mlx-community/Qwen3.6-35B-A3B-4bit");
  expect(server[server.indexOf("--tool-call-parser") + 1]).toBe("qwen3_xml");
  expect(server[server.indexOf("--port") + 1]).toBe(new URL(MLX_URL).port);
});

test("mlx stops before serving when the port is already in use", async () => {
  const { events, dependencies } = harness({ isPortBusy: true });
  expect(await launchMlx(home, ["35b"], dependencies)).toBe(1);
  expect(events).toEqual(["curl"]);
});

test("mlx skips claude when the server exits before it is ready", async () => {
  const { events, dependencies } = harness({ doesServerDie: true });
  expect(await launchMlx(home, ["35b"], dependencies)).toBe(1);
  expect(events).not.toContain("claude");
  expect(events.at(-1)).toBe("stop");
});

test("mlx passes thinking off and the size's sampling as server defaults", async () => {
  const { serverCommands, dependencies } = harness();
  await launchMlx(home, ["35b"], dependencies);
  const server = serverCommands[0];
  const valueOf = (flag: string) => server[server.indexOf(flag) + 1];
  expect(valueOf("--default-chat-template-kwargs")).toBe('{"enable_thinking":false}');
  expect(valueOf("--default-temperature")).toBe("0.7");
  expect(valueOf("--default-top-k")).toBe("20");
  expect(valueOf("--default-top-p")).toBe("0.8");
  expect(valueOf("--default-min-p")).toBe("0");
});

test("mlx --think leaves thinking to the model", async () => {
  const { serverCommands, dependencies } = harness();
  await launchMlx(home, ["35b", "--think"], dependencies);
  expect(serverCommands[0]).not.toContain("--default-chat-template-kwargs");
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
  expect(JSON.parse(lines[1]).env.ANTHROPIC_BASE_URL).toBe(MLX_URL);
});
