import { expect, test } from "bun:test";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigState, saveConfigState } from "../src/config-screen.ts";
import { type LauncherApi, ollamaUrl } from "../src/ollama/api.ts";
import { launch, loadFailureHint, type Runner } from "../src/ollama/launch.ts";
import { modelParameters, renderModelfile } from "../src/ollama/modelfile.ts";
import { renderSettings } from "../src/ollama/settings.ts";
import { loadSizes, type Size } from "../src/ollama/sizes.ts";

const home = join(import.meta.dir, "..");
const okApi: LauncherApi = {
  load: async () => null,
  chat: async () => {
    throw new Error("not used");
  },
  parameters: async () => null,
};
const failingApi = (message: string): LauncherApi => ({ ...okApi, load: async () => message });
const GIB = 1024 ** 3;
const settingsPathOf = (argv: string[]) => argv[argv.indexOf("--settings") + 1];
const OPENCODE_VERSION_PROBE = 'opencode --version > "$1"';

const recorder = (failShow: boolean, failCurl = false) => {
  const calls: string[][] = [];
  const envs: any[] = [];
  const written: any[] = [];
  const run: Runner = async (argv, env) => {
    calls.push(argv);
    envs.push(env);
    if (argv[0] === "claude") written.push(JSON.parse(readFileSync(settingsPathOf(argv), "utf8")));
    if (argv[2] === OPENCODE_VERSION_PROBE) writeFileSync(argv[4], "2.1.2\n");
    if (failCurl && argv[0] === "curl") return 7;
    return failShow && argv[1] === "show" ? 1 : 0;
  };
  return { calls, envs, run, written };
};

test("modelfile has base and parameters", () => {
  const text = renderModelfile({
    base: "b",
    model: "m",
    context: 100,
    output_tokens: 10,
    parameters: { top_k: 20 },
    thinking: false,
  });
  expect(text).toBe(
    "FROM b\nPARAMETER num_ctx 100\nPARAMETER num_predict 10\nPARAMETER top_k 20\n",
  );
});

test("existing model skips pull and create", async () => {
  const { calls, envs, run } = recorder(false);
  expect(await launch(home, ["35b", "-p", "hi"], run, okApi)).toBe(0);
  expect(calls.map((call) => call[1])).toEqual(["-sf", "show", "--settings"]);
  const claude = calls[2];
  expect(claude[0]).toBe("claude");
  expect(claude.slice(-2)).toEqual(["-p", "hi"]);
  expect(claude[claude.indexOf("--model") + 1]).toBe("qwen3.6-35b-128k-cc");
  expect(envs[2].ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:11434");
  expect(envs[2].ANTHROPIC_API_KEY).toBeUndefined();
});

test("missing model pulls and creates", async () => {
  const { calls, run } = recorder(true);
  await launch(home, ["27b"], run, okApi);
  expect(calls.map((call) => call[1])).toEqual(["-sf", "show", "pull", "create", "--settings"]);
  expect(calls[2][2]).toBe("qwen3.8:27b-dflash2-nvfp4");
});

test("existing model with other parameters is recreated without a pull", async () => {
  const { calls, run } = recorder(false);
  const staleApi: LauncherApi = { ...okApi, parameters: async () => ({ num_ctx: 4096 }) };
  expect(await launch(home, ["27b"], run, staleApi)).toBe(0);
  expect(calls.map((call) => call[1])).toEqual(["-sf", "show", "create", "--settings"]);
});

test("existing model with matching parameters is kept", async () => {
  const { calls, run } = recorder(false);
  const matching = modelParameters(loadSizes(home)["27b"]);
  const currentApi: LauncherApi = { ...okApi, parameters: async () => matching };
  expect(await launch(home, ["27b"], run, currentApi)).toBe(0);
  expect(calls.map((call) => call[1])).toEqual(["-sf", "show", "--settings"]);
});

test("launch loads no MCP servers", async () => {
  const { calls, run } = recorder(false);
  await launch(home, [], run, okApi);
  expect(calls.at(-1)).toContain("--strict-mcp-config");
});

test("launch writes the ollama settings with only the compaction hook", async () => {
  const { written, run } = recorder(false);
  await launch(home, [], run, okApi);
  expect(Object.keys(written[0].hooks)).toEqual(["PreCompact"]);
});

test("launch keeps user plugins and disables only built-in ones", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "claude-config-"));
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({ enabledPlugins: { "a@m": true, "b@m": false, "c@builtin": true } }),
  );
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const { written, run } = recorder(false);
    await launch(home, [], run, okApi);
    expect(written[0].enabledPlugins).toEqual({ "c@builtin": false });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("launch stops when the ollama server does not respond", async () => {
  const { calls, run } = recorder(false, true);
  expect(await launch(home, [], run, okApi)).toBe(1);
  expect(calls.map((call) => call[0])).toEqual(["curl"]);
});

test("settings deny only the project's own dist, not node_modules docs", async () => {
  const { deny } = (await Bun.file(join(home, "config", "ollama.json")).json()).permissions;
  expect(deny).not.toContain("Read(**/dist/**)");
  expect(deny).toContain("Read(./dist/**)");
});

test("launch plan helpers stay internal to the launcher", async () => {
  expect(Object.keys(await import("../src/ollama/launch.ts"))).not.toContain("buildPlan");
});

test("ollama sandbox can read skills inside the denied ~/.claude", async () => {
  const { filesystem } = (await Bun.file(join(home, "config", "ollama.json")).json()).sandbox;
  expect(filesystem.denyRead).toContain("~/.claude");
  expect(filesystem.allowRead).toContain("~/.claude/skills");
});

async function writtenSettings(variable: string, optOut: string) {
  const previous = process.env[variable];
  process.env[variable] = optOut;
  try {
    const { written, run } = recorder(false);
    await launch(home, [], run, okApi);
    return written[0];
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
}

test.each(["CLAUDE_LITE_NO_PERMISSIONS", "CLAUDE_LITE_NO_SANDBOX"])(
  "retired %s=ollama keeps permissions and sandbox",
  async (variable) => {
    const written = await writtenSettings(variable, "ollama");
    expect(written.permissions.deny).toContain("Agent");
    expect(written.sandbox).toBeDefined();
  },
);

const sizeWith = (overrides: Partial<Size>): Size => ({
  base: "b",
  model: "m",
  context: 100,
  output_tokens: 10,
  parameters: {},
  thinking: false,
  ...overrides,
});
const disabledBody = JSON.stringify({ thinking: { type: "disabled" } });

test("thinking off sends the disabled body and no effort", () => {
  const settings = renderSettings({ env: {} }, sizeWith({ thinking: false }));
  expect(settings.env.CLAUDE_CODE_EXTRA_BODY).toBe(disabledBody);
  expect(settings.effortLevel).toBeUndefined();
});

test("thinking on with an effort sends it as output_config", () => {
  const base = { env: { CLAUDE_CODE_EXTRA_BODY: disabledBody } };
  const settings = renderSettings(base, sizeWith({ thinking: true, effort: "low" }));
  expect(settings.env.CLAUDE_CODE_EXTRA_BODY).toBe(
    JSON.stringify({ output_config: { effort: "low" } }),
  );
  expect(settings.effortLevel).toBe("low");
});

test("thinking on without an effort drops the base body", () => {
  const base = { env: { CLAUDE_CODE_EXTRA_BODY: disabledBody } };
  const settings = renderSettings(base, sizeWith({ thinking: true }));
  expect(settings.env.CLAUDE_CODE_EXTRA_BODY).toBeUndefined();
});

function homeWithLocalSizes(localSizes: string) {
  const tempHome = mkdtempSync(join(tmpdir(), "claude-lite-sizes-"));
  mkdirSync(join(tempHome, "config"));
  copyFileSync(join(home, "config", "sizes.json"), join(tempHome, "config", "sizes.json"));
  writeFileSync(join(tempHome, "config", "local-sizes.json"), localSizes);
  return tempHome;
}

test("local-sizes.json overrides one field of one size", () => {
  const sizes = loadSizes(homeWithLocalSizes(JSON.stringify({ "27b": { thinking: true } })));
  expect(sizes["27b"].thinking).toBe(true);
  expect(sizes["27b"].model).toBe("qwen3.8-27b-dflash-cc");
  expect(sizes["35b"].thinking).toBe(false);
});

test("invalid local-sizes.json is ignored", () => {
  expect(loadSizes(homeWithLocalSizes("{not json"))).toEqual(loadSizes(home));
});

test("--think turns thinking on and is not passed to claude", async () => {
  const { calls, run, written } = recorder(false);
  await launch(home, ["27b", "--think", "-p", "hi"], run, okApi);
  expect(calls.at(-1)).not.toContain("--think");
  expect(written[0].env.CLAUDE_CODE_EXTRA_BODY).toBeUndefined();
});

test("--no-think turns thinking off and is not passed to claude", async () => {
  const { calls, run, written } = recorder(false);
  await launch(home, ["27b", "--no-think"], run, okApi);
  expect(calls.at(-1)).not.toContain("--no-think");
  expect(written[0].env.CLAUDE_CODE_EXTRA_BODY).toBe(disabledBody);
});

test("--qwen runs qwen against the Ollama /v1 endpoint instead of claude", async () => {
  const { calls, envs, run } = recorder(false);
  expect(await launch(home, ["27b", "--qwen", "-p", "hi"], run, okApi)).toBe(0);
  const model = loadSizes(home)["27b"].model;
  expect(calls.some((argv) => argv[0] === "claude")).toBe(false);
  expect(calls.at(-1)).toEqual(["qwen", "--model", model, "-p", "hi"]);
  expect(envs.at(-1).OPENAI_BASE_URL).toBe(`${ollamaUrl()}/v1`);
  expect(envs.at(-1).OPENAI_MODEL).toBe(model);
});

test("--opencode runs opencode on the Ollama /v1 endpoint instead of claude", async () => {
  const { calls, envs, run } = recorder(false);
  expect(await launch(home, ["27b", "--opencode", "run", "hi"], run, okApi)).toBe(0);
  const model = loadSizes(home)["27b"].model;
  expect(calls.some((argv) => argv[0] === "claude")).toBe(false);
  expect(calls.at(-1)).toEqual(["opencode", "--standalone", "run", "hi"]);
  const config = JSON.parse(envs.at(-1).OPENCODE_CONFIG_CONTENT);
  expect(config.model).toBe(`claude-lite/${model}`);
  expect(config.providers["claude-lite"].settings.baseURL).toBe(`${ollamaUrl()}/v1`);
});

test("renderSettings keeps the base sandbox and permissions unchanged", () => {
  const base = { sandbox: { enabled: true }, permissions: { deny: ["x"] } };
  const settings = renderSettings(base, sizeWith({}));
  expect(settings.sandbox).toEqual(base.sandbox);
  expect(settings.permissions).toEqual(base.permissions);
});

test("local-ollama.json overlays ollama.json on launch", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "claude-lite-ollama-"));
  cpSync(join(home, "config"), join(tempHome, "config"), { recursive: true });
  writeFileSync(
    join(tempHome, "config", "local-ollama.json"),
    JSON.stringify({ sandbox: { enabled: false }, permissions: { deny: [] } }),
  );
  const { run, written } = recorder(false);
  await launch(tempHome, ["27b"], run, okApi);
  expect(written[0].sandbox.enabled).toBe(false);
  expect(written[0].permissions.deny).toEqual([]);
});

const launchWithMode = async (mode: string, claudeArgs: string[] = []) => {
  const tempHome = mkdtempSync(join(tmpdir(), "claude-lite-ollama-"));
  cpSync(join(home, "config"), join(tempHome, "config"), { recursive: true });
  const state = loadConfigState(tempHome);
  const chosen = { ...state, ollamaOverlay: { permissions: { defaultMode: mode } } };
  saveConfigState(tempHome, chosen);
  const { calls, run, written } = recorder(false);
  await launch(tempHome, ["27b", ...claudeArgs], run, okApi);
  return { argv: calls.at(-1)!, permissions: written[0].permissions };
};
const modeFlagOf = (argv: string[]) =>
  argv.includes("--permission-mode") ? argv[argv.indexOf("--permission-mode") + 1] : undefined;

test.each(["acceptEdits", "plan", "auto", "bypassPermissions"])(
  "permission mode %s saved by cl config reaches claude as a flag and a setting",
  async (mode) => {
    const { argv, permissions } = await launchWithMode(mode);
    expect(modeFlagOf(argv)).toBe(mode);
    expect(permissions.defaultMode).toBe(mode);
  },
);

test("auto mode drops the base disableAutoMode, and other modes keep it", async () => {
  expect((await launchWithMode("auto")).permissions.disableAutoMode).toBeUndefined();
  expect((await launchWithMode("plan")).permissions.disableAutoMode).toBe("disable");
});

test("the default permission mode adds no flag", async () => {
  const { calls, run } = recorder(false);
  await launch(home, ["27b"], run, okApi);
  expect(calls.at(-1)).not.toContain("--permission-mode");
});

const MODE_OVERRIDES = [
  ["--permission-mode", "plan"],
  ["--permission-mode=plan"],
  ["--dangerously-skip-permissions"],
];

test("a mode passed after the size wins over the configured one", async () => {
  for (const claudeArgs of MODE_OVERRIDES) {
    const { argv } = await launchWithMode("acceptEdits", claudeArgs);
    expect(argv).not.toContain("acceptEdits");
    expect(argv.slice(-claudeArgs.length)).toEqual(claudeArgs);
  }
});

test("launch removes its temp dir after claude exits", async () => {
  const { calls, run } = recorder(false);
  await launch(home, [], run, okApi);
  expect(existsSync(settingsPathOf(calls.at(-1)!))).toBe(false);
});

test("OLLAMA_HOST points the server check, claude and the sandbox at that server", async () => {
  const previous = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = "studio.local:11434";
  try {
    const { calls, envs, run, written } = recorder(false);
    expect(await launch(home, ["27b"], run, okApi)).toBe(0);
    expect(calls[0].at(-1)).toBe("http://studio.local:11434/api/version");
    expect(envs.at(-1).ANTHROPIC_BASE_URL).toBe("http://studio.local:11434");
    expect(written[0].env.ANTHROPIC_BASE_URL).toBe("http://studio.local:11434");
    expect(written[0].sandbox.network.allowedDomains).toContain("studio.local");
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = previous;
  }
});

test("launch stops with a hint when the model does not fit in memory", async () => {
  const { calls, run } = recorder(false);
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    expect(await launch(home, ["35b"], run, failingApi("model requires 22.0 GiB"))).toBe(1);
  } finally {
    console.error = original;
  }
  expect(calls.map((call) => call[0])).toEqual(["curl", "ollama"]);
  expect(errors[0]).toContain("qwen3.6-35b-128k-cc failed to load: model requires 22.0 GiB");
  expect(errors[1]).toContain("cl ollama");
});

test("load failure hint names the sizes that fit, or says none does", () => {
  expect(loadFailureHint(home, "27b", 16 * GIB, 0)).toBe(
    "sizes that fit this machine: cl ollama 9b",
  );
  expect(loadFailureHint(home, "35b", 64 * GIB, 0)).toContain("cl ollama 27b");
  expect(loadFailureHint(home, "9b", 8 * GIB, 0)).toContain("no configured size fits");
});

test("compaction asks the local model for a short summary without tool calls", async () => {
  const { hooks } = await Bun.file(join(home, "config", "ollama.json")).json();
  const [{ command }] = hooks.PreCompact[0].hooks;
  const instructions = Bun.spawnSync(["sh", "-c", command]).stdout.toString();
  expect(instructions).toContain("at most 600 words");
  expect(instructions).toContain("call no tools");
});

test("ollama settings leave the compaction threshold to the context window", async () => {
  const { env } = await Bun.file(join(home, "config", "ollama.json")).json();
  expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined();
});

test("--opencode on a size with a vision size creates that size's model and hands it to the image-reader", async () => {
  const { calls, envs, run } = recorder(false);
  expect(await launch(home, ["40b", "--opencode"], run, okApi)).toBe(0);
  expect(calls).toContainEqual(["ollama", "show", "qwen3.5-9b-mtp-cc"]);
  const config = JSON.parse(envs.at(-1).OPENCODE_CONFIG_CONTENT);
  expect(config.agents["image-reader"].model).toBe("claude-lite/qwen3.5-9b-mtp-cc");
});

test("a size with a vision size on claude creates that size's model and defines the image-reader on it", async () => {
  const { calls, run } = recorder(false);
  expect(await launch(home, ["40b"], run, okApi)).toBe(0);
  expect(calls).toContainEqual(["ollama", "show", "qwen3.5-9b-mtp-cc"]);
  const claude = calls.find((argv) => argv[0] === "claude")!;
  const agents = JSON.parse(claude[claude.indexOf("--agents") + 1]);
  expect(agents["image-reader"].model).toBe("qwen3.5-9b-mtp-cc");
});

test("--qwen on a size with a vision size creates that size's model and points qwen at the image-reader", async () => {
  const previous = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "claude-lite-home-"));
  try {
    const { calls, run } = recorder(false);
    expect(await launch(home, ["40b", "--qwen"], run, okApi)).toBe(0);
    expect(calls).toContainEqual(["ollama", "show", "qwen3.5-9b-mtp-cc"]);
    expect(calls.at(-1)).toContain("--append-system-prompt");
  } finally {
    process.env.HOME = previous;
  }
});
