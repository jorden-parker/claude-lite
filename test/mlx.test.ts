import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchMlx,
  modelSettingsDocument,
  mlxLogPath,
  mlxUrl,
  omlxDataDir,
  readMlxLogHealth,
  servedModelId,
} from "../src/mlx.ts";
import type { Runner } from "../src/ollama/launch.ts";
import { loadSizes, resolveSize } from "../src/ollama/sizes.ts";

const home = join(import.meta.dir, "..");
const settingsPathOf = (argv: string[]) => argv[argv.indexOf("--settings") + 1];

const OPENCODE_VERSION_PROBE = 'opencode --version > "$1"';
const MODEL_35B = "mlx-community/Qwen3.6-35B-A3B-4bit";
const SERVED_35B = "mlx-community--Qwen3.6-35B-A3B-4bit";
const DATA_DIR = omlxDataDir(homedir());

type HarnessOptions = {
  servedReplies?: (string[] | null)[];
  doesServerDie?: boolean;
  hasOmlx?: boolean;
};

function harness({
  servedReplies = [null, [SERVED_35B]],
  doesServerDie = false,
  hasOmlx = true,
}: HarnessOptions = {}) {
  const events: string[] = [];
  const calls: string[][] = [];
  const envs: any[] = [];
  const written: any[] = [];
  const serverCommands: string[][] = [];
  const modelSettingsWrites: { path: string; document: any }[] = [];
  let probeCount = 0;
  const servedModels = async () => {
    events.push("probe");
    return servedReplies[Math.min(probeCount++, servedReplies.length - 1)];
  };
  const run: Runner = async (argv, env) => {
    calls.push(argv);
    envs.push(env);
    if (argv[2] === OPENCODE_VERSION_PROBE) {
      writeFileSync(argv[4], "2.1.2\n");
      return 0;
    }
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
  const writeModelSettings = (path: string, document: unknown) => {
    events.push("write");
    modelSettingsWrites.push({ path, document });
  };
  return {
    events,
    calls,
    envs,
    written,
    serverCommands,
    modelSettingsWrites,
    dependencies: {
      run,
      startServer,
      unload,
      servedModels,
      isOmlxInstalled: () => hasOmlx,
      writeModelSettings,
      pollDelayMs: 0,
    },
  };
}

test("mlx downloads, unloads ollama, writes oMLX settings, serves, waits, runs claude, then stops the server", async () => {
  const { events, calls, envs, written, dependencies } = harness();
  expect(await launchMlx(home, ["35b", "-p", "hi"], dependencies)).toBe(0);
  expect(events).toEqual([
    "probe",
    "download",
    "unload",
    "write",
    "serve",
    "probe",
    "claude",
    "stop",
  ]);
  const claude = calls.at(-1)!;
  expect(claude[claude.indexOf("--model") + 1]).toBe(SERVED_35B);
  expect(claude.slice(-2)).toEqual(["-p", "hi"]);
  expect(envs.at(-1).ANTHROPIC_BASE_URL).toBe(mlxUrl());
  expect(envs.at(-1).ANTHROPIC_API_KEY).toBeUndefined();
  expect(written[0].env.ANTHROPIC_BASE_URL).toBe(mlxUrl());
});

test("mlx serves the size's model with oMLX on the mlx port", async () => {
  const { serverCommands, dependencies } = harness();
  await launchMlx(home, ["35b"], dependencies);
  expect(serverCommands[0]).toEqual([
    "omlx",
    "serve",
    "--base-path",
    DATA_DIR,
    "--host",
    "127.0.0.1",
    "--port",
    new URL(mlxUrl()).port,
    "--paged-ssd-cache-max-size",
    "20GB",
  ]);
});

test("mlx writes the model settings into the oMLX data dir before the server starts", async () => {
  const { modelSettingsWrites, serverCommands, dependencies } = harness();
  await launchMlx(home, ["35b", "--think"], dependencies);
  expect(modelSettingsWrites.length).toBe(1);
  expect(modelSettingsWrites[0].path).toBe(join(DATA_DIR, "model_settings.json"));
  expect(modelSettingsWrites[0].document.models[SERVED_35B].enable_thinking).toBe(true);
  expect(serverCommands.length).toBe(1);
});

test("mlx --qwen runs qwen against the oMLX /v1 endpoint with the served id", async () => {
  const { calls, envs, dependencies } = harness();
  expect(await launchMlx(home, ["35b", "--qwen", "-p", "hi"], dependencies)).toBe(0);
  expect(calls.some((argv) => argv[0] === "claude")).toBe(false);
  expect(calls.at(-1)).toEqual(["qwen", "--model", SERVED_35B, "-p", "hi"]);
  expect(envs.at(-1).OPENAI_BASE_URL).toBe(`${mlxUrl()}/v1`);
  expect(envs.at(-1).OPENAI_MODEL).toBe(SERVED_35B);
});

test("mlx --opencode runs opencode on the oMLX /v1 endpoint with the served id", async () => {
  const { calls, envs, dependencies } = harness();
  expect(await launchMlx(home, ["35b", "--opencode"], dependencies)).toBe(0);
  expect(calls.at(-1)).toEqual(["opencode"]);
  const config = JSON.parse(envs.at(-1).OPENCODE_CONFIG_CONTENT);
  expect(config.model).toBe(`claude-lite/${SERVED_35B}`);
  expect(config.providers["claude-lite"].settings.baseURL).toBe(`${mlxUrl()}/v1`);
});

test("mlx hands hf download the repo id, not the served id", async () => {
  const { calls, dependencies } = harness();
  await launchMlx(home, ["35b"], dependencies);
  expect(calls[0]).toEqual([
    "uvx",
    "--python",
    "3.12",
    "--from",
    "huggingface_hub",
    "hf",
    "download",
    MODEL_35B,
  ]);
});

test("mlx reuses a server already serving the size's model and leaves it running", async () => {
  const { events, calls, modelSettingsWrites, dependencies } = harness({
    servedReplies: [[SERVED_35B]],
  });
  expect(await launchMlx(home, ["35b"], dependencies)).toBe(0);
  expect(events).toEqual(["probe", "unload", "claude"]);
  expect(calls.at(-1)![0]).toBe("claude");
  expect(modelSettingsWrites).toEqual([]);
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
  expect(errors[0]).toContain(SERVED_35B);
});

test("mlx skips claude when the server exits before it is ready", async () => {
  const { events, dependencies } = harness({ servedReplies: [null], doesServerDie: true });
  expect(await launchMlx(home, ["35b"], dependencies)).toBe(1);
  expect(events).not.toContain("claude");
  expect(events.at(-1)).toBe("stop");
});

test("mlx returns 1 and stops the server when oMLX does not list the served id", async () => {
  const { events, dependencies } = harness({ servedReplies: [null, ["mlx-community--Other"]] });
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    expect(await launchMlx(home, ["35b"], dependencies)).toBe(1);
  } finally {
    console.error = original;
  }
  expect(events).not.toContain("claude");
  expect(events.at(-1)).toBe("stop");
  expect(errors[0]).toContain(`oMLX does not list ${SERVED_35B}`);
  expect(errors[0]).toContain(mlxLogPath(homedir()));
});

test("mlx returns 1 without downloading or starting anything when omlx is not installed", async () => {
  const { events, calls, serverCommands, modelSettingsWrites, dependencies } = harness({
    hasOmlx: false,
  });
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    expect(await launchMlx(home, ["35b"], dependencies)).toBe(1);
  } finally {
    console.error = original;
  }
  expect(events).toEqual([]);
  expect(calls).toEqual([]);
  expect(serverCommands).toEqual([]);
  expect(modelSettingsWrites).toEqual([]);
  expect(errors[0]).toContain("brew install jundot/omlx/omlx");
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

test("mlx --print-config prints the server command, settings path and settings without running", async () => {
  const { calls, events, modelSettingsWrites, dependencies } = harness();
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
  expect(modelSettingsWrites).toEqual([]);
  expect(lines[0]).toContain("omlx serve");
  expect(lines[1]).toContain(join(DATA_DIR, "model_settings.json"));
  expect(JSON.parse(lines[2]).models[SERVED_35B].max_context_window).toBe(131072);
  expect(JSON.parse(lines[3]).env.ANTHROPIC_BASE_URL).toBe(mlxUrl());
});

test("servedModelId turns the Hugging Face repo id into the id oMLX serves", () => {
  expect(servedModelId("mlx-community/Qwen3.8-27B-4bit")).toBe("mlx-community--Qwen3.8-27B-4bit");
});

test("modelSettingsDocument has an entry for every mlx size under its served id", () => {
  const sizes = loadSizes(home);
  const { size } = resolveSize(home, ["35b"], {});
  const document = modelSettingsDocument(sizes, size);
  const expected = Object.values(sizes)
    .filter((candidate) => candidate.mlx)
    .map((candidate) => servedModelId(candidate.mlx!));
  expect(Object.keys(document.models).sort()).toEqual(expected.sort());
  expect(document.version).toBe(1);
});

test("modelSettingsDocument lets the resolved size override its table entry", () => {
  const sizes = loadSizes(home);
  const { size } = resolveSize(home, ["35b", "--think"], {});
  const document = modelSettingsDocument(sizes, size);
  expect(sizes["35b"].thinking).toBe(false);
  expect(document.models[SERVED_35B].enable_thinking).toBe(true);
});

test("modelSettingsDocument emits only the sampling keys a size sets, with force_sampling on", () => {
  const { size: table } = resolveSize(home, ["35b"], {});
  const size = { ...table, parameters: { temperature: 0.4, num_ctx: 32768 } };
  const document = modelSettingsDocument({ "35b": size }, size);
  expect(document.models[SERVED_35B]).toEqual({
    max_context_window: size.context,
    max_tokens: size.output_tokens,
    temperature: 0.4,
    force_sampling: true,
    enable_thinking: size.thinking,
    preserve_thinking: true,
  });
});

test("mlxUrl defaults to port 8435, clear of Ollama's runner on 11435", () => {
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

const CACHE_STORED = (id: string) =>
  `INFO Using boundary cache snapshot for ${id}: storing 4096/5000 tokens (boundary)`;
const CACHE_SKIPPED = (id: string, reason: string) =>
  `INFO Skipping cache store for ${id}: reason=${reason} tokens=5000`;

test("readMlxLogHealth counts the successful cache stores", () => {
  const log = [CACHE_STORED(SERVED_35B), CACHE_STORED(SERVED_35B)].join("\n");
  expect(readMlxLogHealth(log)).toEqual({ cacheStores: 2, cacheSkipReasons: [] });
});

test("readMlxLogHealth lists the skip reasons in first-seen order without repeats", () => {
  const log = [
    CACHE_SKIPPED(SERVED_35B, "mismatch"),
    CACHE_SKIPPED(SERVED_35B, "too_short"),
    CACHE_SKIPPED(SERVED_35B, "mismatch"),
  ].join("\n");
  expect(readMlxLogHealth(log)).toEqual({
    cacheStores: 0,
    cacheSkipReasons: ["mismatch", "too_short"],
  });
});

test("readMlxLogHealth finds nothing in a clean log or an empty string", () => {
  const clean = "INFO server started\nINFO request completed";
  for (const log of [clean, ""])
    expect(readMlxLogHealth(log)).toEqual({ cacheStores: 0, cacheSkipReasons: [] });
});
