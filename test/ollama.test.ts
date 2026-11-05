import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, type Runner } from "../src/ollama/launch.ts";
import { renderModelfile } from "../src/ollama/modelfile.ts";
import { renderSettings } from "../src/ollama/settings.ts";
import { loadSizes, type Size } from "../src/ollama/sizes.ts";

const home = join(import.meta.dir, "..");
const recorder = (failShow: boolean, failCurl = false) => {
  const calls: string[][] = [];
  const envs: any[] = [];
  const run: Runner = async (argv, env) => {
    calls.push(argv);
    envs.push(env);
    if (failCurl && argv[0] === "curl") return 7;
    return failShow && argv[1] === "show" ? 1 : 0;
  };
  return { calls, envs, run };
};

test("modelfile has base and parameters", () => {
  const text = renderModelfile({
    base: "b",
    model: "m",
    context: 100,
    output_tokens: 10,
    parameters: { top_k: 20 },
    thinking: false,
    permissions: true,
    sandbox: true,
  });
  expect(text).toBe(
    "FROM b\nPARAMETER num_ctx 100\nPARAMETER num_predict 10\nPARAMETER top_k 20\n",
  );
});

test("existing model skips pull and create", async () => {
  const { calls, envs, run } = recorder(false);
  expect(await launch(home, ["35b", "-p", "hi"], run)).toBe(0);
  expect(calls.map((c) => c[1])).toEqual(["-sf", "show", "--settings"]);
  const claude = calls[2];
  expect(claude[0]).toBe("claude");
  expect(claude.slice(-2)).toEqual(["-p", "hi"]);
  expect(claude[claude.indexOf("--model") + 1]).toBe("qwen3.6-35b-64k-cc");
  expect(envs[2].ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
  expect(envs[2].ANTHROPIC_API_KEY).toBeUndefined();
});

test("missing model pulls and creates, default size 27b", async () => {
  const { calls, run } = recorder(true);
  await launch(home, [], run);
  expect(calls.map((c) => c[1])).toEqual(["-sf", "show", "pull", "create", "--settings"]);
  expect(calls[2][2]).toBe("qwen3.8:27b-dflash2-nvfp4");
});

test("launch stops when the ollama server does not respond", async () => {
  const { calls, run } = recorder(false, true);
  expect(await launch(home, [], run)).toBe(1);
  expect(calls.map((c) => c[0])).toEqual(["curl"]);
});

test("personal settings carry the same hooks as hooks.json", async () => {
  const read = async (name: string) => await Bun.file(join(home, "config", name)).json();
  expect((await read("personal-settings.json")).hooks).toEqual(await read("hooks.json"));
});

test("settings deny only the project's own dist, not node_modules docs", async () => {
  for (const name of ["personal-settings.json", "ollama-base.json"]) {
    const { deny } = (await Bun.file(join(home, "config", name)).json()).permissions;
    expect(deny).not.toContain("Read(**/dist/**)");
    expect(deny).toContain("Read(./dist/**)");
  }
});

test("launch plan helpers stay internal to the launcher", async () => {
  expect(Object.keys(await import("../src/ollama/launch.ts"))).not.toContain("buildPlan");
});

test("ollama sandbox can read skills inside the denied ~/.claude", async () => {
  const { filesystem } = (await Bun.file(join(home, "config", "ollama-base.json")).json()).sandbox;
  expect(filesystem.denyRead).toContain("~/.claude");
  expect(filesystem.allowRead).toContain("~/.claude/skills");
});

async function writtenSettings(variable: string, optOut: string) {
  const previous = process.env[variable];
  process.env[variable] = optOut;
  try {
    const { calls, run } = recorder(false);
    await launch(home, [], run);
    const claude = calls.at(-1)!;
    return await Bun.file(claude[claude.indexOf("--settings") + 1]).json();
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
}

test("CLAUDE_LITE_NO_PERMISSIONS=ollama drops permissions and keeps sandbox", async () => {
  const written = await writtenSettings("CLAUDE_LITE_NO_PERMISSIONS", "ollama");
  expect(written.permissions).toBeUndefined();
  expect(written.sandbox).toBeDefined();
});

test("CLAUDE_LITE_NO_SANDBOX=ollama drops sandbox and keeps permissions", async () => {
  const written = await writtenSettings("CLAUDE_LITE_NO_SANDBOX", "ollama");
  expect(written.sandbox).toBeUndefined();
  expect(written.permissions.deny).toContain("Agent");
});

test("CLAUDE_LITE_NO_PERMISSIONS=anthropic keeps the ollama Agent deny", async () => {
  const written = await writtenSettings("CLAUDE_LITE_NO_PERMISSIONS", "anthropic");
  expect(written.permissions.deny).toContain("Agent");
});

const sizeWith = (overrides: Partial<Size>): Size => ({
  base: "b",
  model: "m",
  context: 100,
  output_tokens: 10,
  parameters: {},
  thinking: false,
  permissions: true,
  sandbox: true,
  ...overrides,
});
const disabledBody = JSON.stringify({ thinking: { type: "disabled" } });

test("thinking off sends the disabled body and no effort", () => {
  const settings = renderSettings({ env: {} }, {}, sizeWith({ thinking: false }));
  expect(settings.env.CLAUDE_CODE_EXTRA_BODY).toBe(disabledBody);
  expect(settings.effortLevel).toBeUndefined();
});

test("thinking on with an effort sends it as output_config", () => {
  const base = { env: { CLAUDE_CODE_EXTRA_BODY: disabledBody } };
  const settings = renderSettings(base, {}, sizeWith({ thinking: true, effort: "low" }));
  expect(settings.env.CLAUDE_CODE_EXTRA_BODY).toBe(
    JSON.stringify({ output_config: { effort: "low" } }),
  );
  expect(settings.effortLevel).toBe("low");
});

test("thinking on without an effort drops the base body", () => {
  const base = { env: { CLAUDE_CODE_EXTRA_BODY: disabledBody } };
  const settings = renderSettings(base, {}, sizeWith({ thinking: true }));
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
  const { calls, run } = recorder(false);
  await launch(home, ["27b", "--think", "-p", "hi"], run);
  const claude = calls.at(-1)!;
  expect(claude).not.toContain("--think");
  const written = await Bun.file(claude[claude.indexOf("--settings") + 1]).json();
  expect(written.env.CLAUDE_CODE_EXTRA_BODY).toBeUndefined();
});

test("--no-think turns thinking off and is not passed to claude", async () => {
  const { calls, run } = recorder(false);
  await launch(home, ["27b", "--no-think"], run);
  const claude = calls.at(-1)!;
  expect(claude).not.toContain("--no-think");
  const written = await Bun.file(claude[claude.indexOf("--settings") + 1]).json();
  expect(written.env.CLAUDE_CODE_EXTRA_BODY).toBe(disabledBody);
});

test("renderSettings leaves out permissions or sandbox when the size turns it off", () => {
  const base = { sandbox: { enabled: true }, permissions: { deny: ["x"] } };
  const noPermissions = renderSettings(base, {}, sizeWith({ permissions: false }));
  expect(noPermissions.permissions).toBeUndefined();
  expect(noPermissions.sandbox).toEqual(base.sandbox);
  const noSandbox = renderSettings(base, {}, sizeWith({ sandbox: false }));
  expect(noSandbox.sandbox).toBeUndefined();
  expect(noSandbox.permissions?.deny).toContain("Agent");
});

test("--no-sandbox --no-permissions writes neither block and passes neither flag", async () => {
  const { calls, run } = recorder(false);
  await launch(home, ["27b", "--no-sandbox", "--no-permissions"], run);
  const claude = calls.at(-1)!;
  expect(claude).not.toContain("--no-sandbox");
  expect(claude).not.toContain("--no-permissions");
  for (const flag of ["--setting-sources", "--permission-mode", "--dangerously-skip-permissions"]) {
    expect(claude).not.toContain(flag);
  }
  const written = await Bun.file(claude[claude.indexOf("--settings") + 1]).json();
  expect(written.sandbox).toBeUndefined();
  expect(written.permissions).toBeUndefined();
});
