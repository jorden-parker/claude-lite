import { expect, test } from "bun:test";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  hubCacheDir,
  isRepoInHubCache,
  launchMlx,
  modelSettingsDocument,
  mlxLogPath,
  mlxUrl,
  omlxDataDir,
  readMlxLogHealth,
  serveMlx,
  servedModelId,
  spawnServer,
  withMlxBenchServer,
} from "../src/mlx.ts";
import type { Runner } from "../src/ollama/launch.ts";
import type { MlxBenchDependencies } from "../src/mlx.ts";
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
  hasSplash?: boolean;
};

function harness({
  servedReplies = [null, [SERVED_35B]],
  doesServerDie = false,
  hasOmlx = true,
  hasSplash = false,
}: HarnessOptions = {}) {
  const events: string[] = [];
  const calls: string[][] = [];
  const envs: any[] = [];
  const written: any[] = [];
  const serverCommands: string[][] = [];
  const modelSettingsWrites: { path: string; document: any }[] = [];
  const sessionsDir = mkdtempSync(join(tmpdir(), "claude-lite-mlx-sessions-"));
  const sessionsDuringClaude: string[][] = [];
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
      sessionsDuringClaude.push(readdirSync(sessionsDir));
      written.push(JSON.parse(readFileSync(settingsPathOf(argv), "utf8")));
      return 0;
    }
    events.push("download");
    return 0;
  };
  const startServer = (argv: string[]) => {
    events.push("serve");
    serverCommands.push(argv);
    const { promise, resolve } = Promise.withResolvers<number>();
    if (doesServerDie) resolve(1);
    return {
      exited: promise,
      stop: () => {
        events.push("stop");
        resolve(0);
      },
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
    sessionsDir,
    sessionsDuringClaude,
    dependencies: {
      sessionsDir,
      run,
      startServer,
      unload,
      servedModels,
      isOmlxInstalled: () => hasOmlx,
      isSplashInstalled: () => hasSplash,
      isRepoCached: () => false,
      writeModelSettings,
      awaitShutdown: async () => 0,
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
    "--memory-guard",
    "aggressive",
  ]);
});

test("mlx lets oMLX use most of RAM so the 35b fits under the memory guard's dynamic ceiling", async () => {
  const { serverCommands, dependencies } = harness();
  await launchMlx(home, ["35b"], dependencies);
  expect(serverCommands[0].slice(-2)).toEqual(["--memory-guard", "aggressive"]);
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
  expect(calls.at(-1)).toEqual(["opencode", "--standalone"]);
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

test("mlx leaves the server running while another live session uses it", async () => {
  const { events, sessionsDir, dependencies } = harness();
  writeFileSync(join(sessionsDir, String(process.ppid)), "");
  expect(await launchMlx(home, ["35b"], dependencies)).toBe(0);
  expect(events.at(-1)).toBe("claude");
});

test("mlx stops the server when the only other session file is from a dead process", async () => {
  const { events, sessionsDir, dependencies } = harness();
  writeFileSync(join(sessionsDir, "2147483646"), "");
  expect(await launchMlx(home, ["35b"], dependencies)).toBe(0);
  expect(events.at(-1)).toBe("stop");
});

test("reopening 27b during shutdown waits before probing and starts a fresh server", async () => {
  const first = harness({ servedReplies: [null, [SERVED_27B]] });
  const stopping = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number>();
  const closing = launchMlx(home, ["27b"], {
    ...first.dependencies,
    startServer: () => ({
      pid: process.pid,
      stop: () => stopping.resolve(),
      exited: exited.promise,
    }),
  });
  await stopping.promise;
  const second = harness({ servedReplies: [null, [SERVED_27B]] });
  const opening = launchMlx(home, ["27b"], {
    ...second.dependencies,
    sessionsDir: first.sessionsDir,
  });
  try {
    await Bun.sleep(10);
    expect(second.events).not.toContain("probe");
  } finally {
    exited.resolve(0);
  }
  expect(await closing).toBe(0);
  expect(await opening).toBe(0);
  expect(second.events).toContain("serve");
});

test("mlx records its session while claude runs, on a reused server too, and clears it after", async () => {
  const { sessionsDir, sessionsDuringClaude, dependencies } = harness({
    servedReplies: [[SERVED_35B]],
  });
  expect(await launchMlx(home, ["35b"], dependencies)).toBe(0);
  expect(sessionsDuringClaude).toEqual([[String(process.pid)]]);
  expect(readdirSync(sessionsDir)).toEqual([]);
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
  expect(errors.at(-1)).toContain("other-model");
  expect(errors.at(-1)).toContain(SERVED_35B);
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
  expect(errors.at(-1)).toContain(`oMLX does not list ${SERVED_35B}`);
  expect(errors.at(-1)).toContain(mlxLogPath(homedir()));
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
  expect(errors.at(-1)).toContain("brew install jundot/omlx/omlx");
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

test("serve starts the size's model, prints where it is ready, stops it on shutdown and never runs claude", async () => {
  const { events, calls, modelSettingsWrites, dependencies } = harness();
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    expect(await serveMlx(home, ["35b"], dependencies)).toBe(0);
  } finally {
    console.log = original;
  }
  expect(events).toContain("serve");
  expect(events.at(-1)).toBe("stop");
  expect(calls.map((argv) => argv[0])).not.toContain("claude");
  expect(modelSettingsWrites[0].document.models[SERVED_35B]).toBeDefined();
  expect(lines).toContain(`oMLX ready at ${mlxUrl()}, serving ${SERVED_35B}; Ctrl-C stops it`);
});

test("serve exits 0 without starting a server when oMLX already serves the model", async () => {
  const { events, serverCommands, dependencies } = harness({ servedReplies: [[SERVED_35B]] });
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    expect(await serveMlx(home, ["35b"], dependencies)).toBe(0);
  } finally {
    console.log = original;
  }
  expect(serverCommands).toEqual([]);
  expect(events).not.toContain("stop");
  expect(lines.join("\n")).toContain(`already serving ${SERVED_35B}`);
});

test("serve fails and names the port holder when something else serves it", async () => {
  const { events, serverCommands, dependencies } = harness({ servedReplies: [["other-model"]] });
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    expect(await serveMlx(home, ["35b"], dependencies)).toBe(1);
  } finally {
    console.error = original;
  }
  expect(events).toContain("lsof");
  expect(serverCommands).toEqual([]);
  expect(errors.at(-1)).toContain("already serves other-model");
});

test("serve returns 1 without downloading or starting anything when omlx is not installed", async () => {
  const { calls, serverCommands, dependencies } = harness({ hasOmlx: false });
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    expect(await serveMlx(home, ["35b"], dependencies)).toBe(1);
  } finally {
    console.error = original;
  }
  expect(calls).toEqual([]);
  expect(serverCommands).toEqual([]);
  expect(errors.at(-1)).toContain("brew install jundot/omlx/omlx");
});

test("serve returns 1 when oMLX exits before it lists the model", async () => {
  const { events, dependencies } = harness({ doesServerDie: true });
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    expect(await serveMlx(home, ["35b"], dependencies)).toBe(1);
  } finally {
    console.error = original;
  }
  expect(events).not.toContain("claude");
  expect(errors.at(-1)).toContain("oMLX exited before it was ready");
});

test("serve --print-config prints the server command and model settings without running", async () => {
  const { calls, events, modelSettingsWrites, dependencies } = harness();
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    expect(await serveMlx(home, ["35b", "--print-config"], dependencies)).toBe(0);
  } finally {
    console.log = original;
  }
  expect(calls).toEqual([]);
  expect(events).toEqual([]);
  expect(modelSettingsWrites).toEqual([]);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("omlx serve");
  expect(lines[1]).toContain(join(DATA_DIR, "model_settings.json"));
  expect(JSON.parse(lines[2]).models[SERVED_35B].max_context_window).toBe(131072);
});

test("serve refuses a size without an mlx model", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "claude-lite-serve-"));
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
    expect(await serveMlx(tempHome, ["9b"], dependencies)).toBe(1);
  } finally {
    console.error = original;
  }
  expect(calls).toEqual([]);
  expect(errors[0]).toContain("9b has no mlx model");
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
  const size = {
    ...table,
    mlx_draft: undefined,
    parameters: { temperature: 0.4, num_ctx: 32768 },
  };
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

test("modelSettingsDocument turns on MTP speculative decoding with a size's mlx_draft drafter", () => {
  const { size: table } = resolveSize(home, ["35b"], {});
  const size = { ...table, mlx_draft: "mlx-community/Drafter-MTP-4bit" };
  const document = modelSettingsDocument({ "35b": size }, size);
  expect(document.models[SERVED_35B].vlm_mtp_enabled).toBe(true);
  expect(document.models[SERVED_35B].vlm_mtp_draft_model).toBe("mlx-community/Drafter-MTP-4bit");
});

test("mlx downloads the default 27b native DFlash2 drafter after its model", async () => {
  const { calls, dependencies } = harness();
  await launchMlx(home, ["27b"], dependencies);
  const downloads = calls.filter((argv) => argv[0] === "uvx").map((argv) => argv.at(-1));
  expect(downloads).toEqual([MODEL_27B, DFLASH_27B]);
});

test("mlx skips hf download for repos already in the Hugging Face cache", async () => {
  const { calls, dependencies } = harness();
  await launchMlx(home, ["27b"], { ...dependencies, isRepoCached: (repo) => repo === MODEL_27B });
  const downloads = calls.filter((argv) => argv[0] === "uvx").map((argv) => argv.at(-1));
  expect(downloads).toEqual([DFLASH_27B]);
});

test("hubCacheDir prefers HF_HUB_CACHE, then HF_HOME, then the home default", () => {
  expect(hubCacheDir({ HF_HUB_CACHE: "/x" }, "/home/me")).toBe("/x");
  expect(hubCacheDir({ HF_HOME: "/hf" }, "/home/me")).toBe("/hf/hub");
  expect(hubCacheDir({}, "/home/me")).toBe("/home/me/.cache/huggingface/hub");
});

test("isRepoInHubCache needs a snapshot and no incomplete blob", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "claude-lite-hub-"));
  expect(isRepoInHubCache(cacheDir, "org/name")).toBe(false);
  const repoDir = join(cacheDir, "models--org--name");
  mkdirSync(join(repoDir, "snapshots", "abc123"), { recursive: true });
  mkdirSync(join(repoDir, "blobs"), { recursive: true });
  expect(isRepoInHubCache(cacheDir, "org/name")).toBe(true);
  writeFileSync(join(repoDir, "blobs", "deadbeef.incomplete"), "");
  expect(isRepoInHubCache(cacheDir, "org/name")).toBe(false);
});

test("every Qwen mlx size pairs its model with that model's MTP drafter", () => {
  const sizes = loadSizes(home);
  for (const size of Object.values(sizes).filter((candidate) => candidate.mlx?.includes("Qwen")))
    expect(size.mlx_draft).toBe(size.mlx!.replace(/-4bit$/, "-MTP-4bit"));
});

test("spawnServer keeps the server's stdout and stderr in order in one fresh log", async () => {
  const logFile = join(mkdtempSync(join(tmpdir(), "claude-lite-mlx-log-")), "server.log");
  writeFileSync(logFile, "previous run\n");
  const previousWriter = openSync(logFile, "a");
  const script =
    "echo starting; sleep 0.1; echo 'APIError: 500 out of memory' >&2; sleep 0.1; echo done";
  try {
    const server = spawnServer(["sh", "-c", script], logFile);
    await server.exited;
    writeFileSync(previousWriter, "Finished server process\n");
  } finally {
    closeSync(previousWriter);
  }
  expect(readFileSync(logFile, "utf8")).toBe("starting\nAPIError: 500 out of memory\ndone\n");
});

test("mlx --opencode on a size with a vision size downloads that size's model for the image-reader", async () => {
  const { calls, envs, dependencies } = harness({
    servedReplies: [null, ["mlx-community--flint-oQ4e"]],
  });
  expect(await launchMlx(home, ["40b", "--opencode"], dependencies)).toBe(0);
  expect(calls.map((argv) => argv.at(-1))).toContain("mlx-community/Qwen3.5-9B-4bit");
  const config = JSON.parse(envs.at(-1).OPENCODE_CONFIG_CONTENT);
  expect(config.agents["image-reader"].model).toBe("claude-lite/mlx-community--Qwen3.5-9B-4bit");
});

const MODEL_27B = "mlx-community/Qwen3.8-27B-4bit";
const SERVED_27B = "mlx-community--Qwen3.8-27B-4bit";
const DFLASH_27B = "incoai/Qwen3.8-27B-DFlash2";

test("the 27b size names the DFlash2 draft Splash pairs with Qwen3.8 27B", () => {
  expect(loadSizes(home)["27b"].mlx_dflash).toBe(DFLASH_27B);
});

test("modelSettingsDocument serves a size with mlx_dflash through Splash when Splash is installed", () => {
  const sizes = loadSizes(home);
  const settings = modelSettingsDocument(sizes, { ...sizes["27b"], mlx_engine: "auto" }, true)
    .models[SERVED_27B];
  expect(settings.external_engine).toBe("splash");
  expect(settings.dflash_draft_model).toBe("incoai--Qwen3.8-27B-DFlash2");
  expect(settings.vlm_mtp_enabled).toBeUndefined();
});

test("modelSettingsDocument keeps the MTP drafter and oMLX's own engine when Splash is missing", () => {
  const sizes = loadSizes(home);
  const settings = modelSettingsDocument(sizes, { ...sizes["27b"], mlx_engine: "auto" }, false)
    .models[SERVED_27B];
  expect(settings.external_engine).toBeUndefined();
  expect(settings.vlm_mtp_enabled).toBe(true);
});

test("native DFlash uses the oMLX 0.8.4 draft quantization setting names", () => {
  const sizes = loadSizes(home);
  const selected = sizes["27b"];
  expect(selected.mlx_engine).toBe("dflash");
  const settings = modelSettingsDocument(sizes, selected, false).models[SERVED_27B];
  expect(settings.dflash_enabled).toBe(true);
  expect(settings.dflash_draft_quant_enabled).toBe(true);
  expect(settings.dflash_draft_quant_weight_bits).toBe(4);
  expect(settings.dflash_draft_quant_group_size).toBe(64);
  expect(settings.external_engine).toBeUndefined();
  expect(settings.vlm_mtp_enabled).toBeUndefined();
});

test("model settings retain MTP for non-launched 9b while using Splash for 35b when available", () => {
  const sizes = loadSizes(home);
  const doc = modelSettingsDocument(sizes, sizes["27b"], true).models;
  expect(doc[servedModelId(sizes["9b"].mlx!)].vlm_mtp_enabled).toBe(true);
  expect(doc[servedModelId(sizes["35b"].mlx!)].external_engine).toBe("splash");
});

test("auto does not enable MTP when the selected size has no MTP repository", () => {
  const size = { ...loadSizes(home)["27b"], mlx_draft: undefined, mlx_engine: "auto" as const };
  const settings = modelSettingsDocument({ "27b": size }, size, false).models[SERVED_27B];
  expect(settings.vlm_mtp_enabled).toBeUndefined();
  expect(settings.vlm_mtp_draft_model).toBeUndefined();
});

test("modelSettingsDocument leaves a size without mlx_dflash on oMLX's own engine with Splash installed", () => {
  const sizes = loadSizes(home);
  const settings = modelSettingsDocument(sizes, sizes["9b"], true).models[
    servedModelId(sizes["9b"].mlx!)
  ];
  expect(settings.external_engine).toBeUndefined();
  expect(settings.vlm_mtp_enabled).toBe(true);
});

const DFLASH_35B = "incoai/Qwen3.6-35B-A3B-DFlash2";

test("the 35b size names the DFlash2 draft Splash pairs with Qwen3.6 35B-A3B", () => {
  expect(loadSizes(home)["35b"].mlx_dflash).toBe(DFLASH_35B);
});

test("mlx 35b with Splash is served through Splash and downloads its DFlash2 draft", async () => {
  const { calls, modelSettingsWrites, dependencies } = harness({
    hasSplash: true,
    servedReplies: [null, [SERVED_35B]],
  });
  expect(await launchMlx(home, ["35b"], dependencies)).toBe(0);
  const downloads = calls.filter((argv) => argv[0] === "uvx").map((argv) => argv.at(-1));
  expect(downloads).toEqual([MODEL_35B, DFLASH_35B]);
  const settings = modelSettingsWrites[0].document.models[SERVED_35B];
  expect(settings.external_engine).toBe("splash");
  expect(settings.dflash_draft_model).toBe("incoai--Qwen3.6-35B-A3B-DFlash2");
});

test("mlx with Splash downloads the DFlash2 draft instead of the MTP drafter", async () => {
  const { calls, dependencies } = harness({ hasSplash: true, servedReplies: [null, [SERVED_27B]] });
  expect(await launchMlx(home, ["27b"], dependencies)).toBe(0);
  const downloads = calls.filter((argv) => argv[0] === "uvx").map((argv) => argv.at(-1));
  expect(downloads).toEqual([MODEL_27B, DFLASH_27B]);
});

test("claude, qwen and opencode launch 27b on the same server command and model settings", async () => {
  const launches = [];
  for (const clientFlags of [[], ["--qwen"], ["--opencode"]]) {
    const { serverCommands, modelSettingsWrites, dependencies } = harness({
      hasSplash: true,
      servedReplies: [null, [SERVED_27B]],
    });
    expect(await launchMlx(home, ["27b", ...clientFlags], dependencies)).toBe(0);
    launches.push({ command: serverCommands[0], settings: modelSettingsWrites[0].document });
  }
  expect(launches[1]).toEqual(launches[0]);
  expect(launches[2]).toEqual(launches[0]);
  expect(launches[0].settings.models[SERVED_27B].dflash_enabled).toBe(true);
  expect(launches[0].settings.models[SERVED_27B].external_engine).toBeUndefined();
});

const SERVED_FLINT = "mlx-community--flint-oQ4e";
const SERVED_VISION = "mlx-community--Qwen3.5-9B-4bit";

async function withTemporaryHome<Result>(runWithHome: (userHome: string) => Promise<Result>) {
  const previous = process.env.HOME;
  const userHome = mkdtempSync(join(tmpdir(), "claude-lite-home-"));
  process.env.HOME = userHome;
  try {
    return await runWithHome(userHome);
  } finally {
    process.env.HOME = previous;
  }
}

test("mlx 40b on claude downloads the vision model and defines the image-reader on it", async () => {
  const { calls, dependencies } = harness({ servedReplies: [null, [SERVED_FLINT]] });
  expect(await launchMlx(home, ["40b"], dependencies)).toBe(0);
  expect(calls.map((argv) => argv.at(-1))).toContain("mlx-community/Qwen3.5-9B-4bit");
  const claude = calls.find((argv) => argv[0] === "claude")!;
  const agents = JSON.parse(claude[claude.indexOf("--agents") + 1]);
  expect(agents["image-reader"].model).toBe(SERVED_VISION);
});

test("mlx 40b --qwen downloads the vision model and writes the image-reader on it", async () => {
  await withTemporaryHome(async (userHome) => {
    const { calls, dependencies } = harness({ servedReplies: [null, [SERVED_FLINT]] });
    let agentFile = "";
    const run: Runner = async (argv, env) => {
      if (argv[0] === "qwen")
        agentFile = readFileSync(join(userHome, ".qwen", "agents", "image-reader.md"), "utf8");
      return await dependencies.run(argv, env);
    };
    expect(await launchMlx(home, ["40b", "--qwen"], { ...dependencies, run })).toBe(0);
    expect(calls.map((argv) => argv.at(-1))).toContain("mlx-community/Qwen3.5-9B-4bit");
    expect(agentFile).toContain(`model: ${SERVED_VISION}`);
  });
});

test("mlx 27b defines no image-reader because the model reads images itself", async () => {
  const { calls, dependencies } = harness({ servedReplies: [null, [SERVED_27B]] });
  expect(await launchMlx(home, ["27b"], dependencies)).toBe(0);
  expect(calls.find((argv) => argv[0] === "claude")).not.toContain("--agents");
});

function benchFixture(): {
  state: {
    argv?: string[];
    env?: Record<string, string | undefined>;
    log?: string;
    url?: string;
    model?: string;
    downloads: string[];
    stopped: boolean;
  };
  dependencies: MlxBenchDependencies;
} {
  let finish!: (code: number) => void;
  const serverExit = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const state: {
    argv?: string[];
    env?: Record<string, string | undefined>;
    log?: string;
    url?: string;
    model?: string;
    downloads: string[];
    stopped: boolean;
  } = {
    downloads: [],
    stopped: false,
  };
  return {
    state,
    dependencies: {
      isOmlxInstalled: () => true,
      isSplashInstalled: () => false,
      ollamaModels: async () => [],
      loadedOmlxModels: async () => undefined,
      isRepoCached: (repo: string) => repo === MODEL_27B,
      download: async (repo: string) => {
        state.downloads.push(repo);
        return 0;
      },
      allocatePort: async () => 49213,
      start: (argv: string[], log: string, env: Record<string, string | undefined>) => {
        state.argv = argv;
        state.env = env;
        state.log = log;
        return {
          exited: serverExit,
          stop: () => {
            state.stopped = true;
            finish(0);
          },
        };
      },
      wait: async (url: string, model: string) => {
        state.url = url;
        state.model = model;
      },
      sessionsDir: mkdtempSync(join(tmpdir(), "claude-lite-bench-sessions-")),
    },
  };
}

test("benchmark stages an isolated base, uses the standard HF cache, downloads a missing drafter, and waits for the served id", async () => {
  const { state, dependencies } = benchFixture();
  let callbackArgs: string[] = [];
  const result = await withMlxBenchServer(
    "27b",
    loadSizes(home)["27b"],
    async (...args) => {
      callbackArgs = args;
      return 0;
    },
    dependencies,
  );
  expect(result).toBe(0);
  expect(state.downloads).toEqual([DFLASH_27B]);
  expect(state.model).toBe(SERVED_27B);
  expect(callbackArgs.slice(0, 3)).toEqual(["http://127.0.0.1:49213", SERVED_27B, "dflash"]);
  expect(state.argv).toContain("--base-path");
  expect(state.argv).not.toContain("--model-dir");
  expect(state.env?.HF_HUB_CACHE).toBe(hubCacheDir(process.env, homedir()));
  expect(existsSync(state.argv![state.argv!.indexOf("--base-path") + 1])).toBe(false);
  expect(state.stopped).toBe(true);
});

test("benchmark refuses active Ollama models at the configured local OLLAMA_HOST", async () => {
  const previous = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = "localhost:11555";
  const { state, dependencies } = benchFixture();
  dependencies.ollamaModels = async (url: string) => {
    expect(url).toBe("http://localhost:11555");
    return ["busy-model"];
  };
  try {
    await expect(
      withMlxBenchServer("27b", loadSizes(home)["27b"], async () => 0, dependencies),
    ).rejects.toThrow("Ollama models are active");
    expect(state.argv).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = previous;
  }
});

test("benchmark checks loaded model count instead of rejecting a discoverable idle oMLX server", async () => {
  const { state, dependencies } = benchFixture();
  dependencies.loadedOmlxModels = async () => 2;
  await expect(
    withMlxBenchServer("27b", loadSizes(home)["27b"], async () => 0, dependencies),
  ).rejects.toThrow("2 model(s) are loaded");
  expect(state.argv).toBeUndefined();
});

test("benchmark removes its temporary base when startup throws", async () => {
  const { state, dependencies } = benchFixture();
  dependencies.start = (argv: string[], log: string) => {
    state.argv = argv;
    state.log = log;
    throw new Error("spawn failed");
  };
  await expect(
    withMlxBenchServer("27b", loadSizes(home)["27b"], async () => 0, dependencies),
  ).rejects.toThrow("spawn failed");
  expect(existsSync(state.argv![state.argv!.indexOf("--base-path") + 1])).toBe(false);
});

test("explicit engine reuse requires a live claude-lite child recorded as the port listener", async () => {
  const project = mkdtempSync(join(tmpdir(), "claude-lite-engine-reuse-"));
  mkdirSync(join(project, "config"), { recursive: true });
  cpSync(join(home, "config", "sizes.json"), join(project, "config", "sizes.json"));
  cpSync(join(home, "config", "ollama.json"), join(project, "config", "ollama.json"));
  writeFileSync(
    join(project, "config", "local-sizes.json"),
    JSON.stringify({ "27b": { mlx_engine: "dflash" } }),
  );
  const { dependencies, calls, serverCommands, sessionsDir } = harness({
    servedReplies: [[SERVED_27B]],
  });
  const managed = join(sessionsDir, "managed");
  mkdirSync(managed, { recursive: true });
  writeFileSync(
    join(managed, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      port: "8435",
      model: SERVED_27B,
      engine: "dflash",
    }),
  );
  expect(
    await launchMlx(project, ["27b"], {
      ...dependencies,
      listeningPids: () => [process.pid],
    }),
  ).toBe(0);
  expect(serverCommands).toHaveLength(0);
  expect(calls.some((argv) => argv[0] === "uvx")).toBe(false);
});

test("explicit engine reuse refuses a foreign server without a live process marker", async () => {
  const project = mkdtempSync(join(tmpdir(), "claude-lite-engine-foreign-"));
  mkdirSync(join(project, "config"), { recursive: true });
  cpSync(join(home, "config", "sizes.json"), join(project, "config", "sizes.json"));
  cpSync(join(home, "config", "ollama.json"), join(project, "config", "ollama.json"));
  writeFileSync(
    join(project, "config", "local-sizes.json"),
    JSON.stringify({ "27b": { mlx_engine: "dflash" } }),
  );
  const { dependencies, calls } = harness({ servedReplies: [[SERVED_27B]] });
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => errors.push(String(message));
  try {
    expect(await launchMlx(project, ["27b"], dependencies)).toBe(1);
  } finally {
    console.error = originalError;
  }
  expect(errors.join(" ")).toContain("engine cannot be verified");
  expect(calls.some((argv) => argv[0] === "uvx")).toBe(false);
});
