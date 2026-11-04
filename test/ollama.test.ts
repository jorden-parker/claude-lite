import { expect, test } from "bun:test";
import { join } from "node:path";
import { launch, type Runner } from "../src/ollama/launch.ts";
import { renderModelfile } from "../src/ollama/modelfile.ts";

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
  expect(claude[claude.indexOf("--model") + 1]).toBe("qwen3.6-35b-cc");
  expect(envs[2].ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
  expect(envs[2].ANTHROPIC_API_KEY).toBeUndefined();
});

test("missing model pulls and creates, default size 27b", async () => {
  const { calls, run } = recorder(true);
  await launch(home, [], run);
  expect(calls.map((c) => c[1])).toEqual(["-sf", "show", "pull", "create", "--settings"]);
  expect(calls[2][2]).toBe("qwen3.8:27b-mlx");
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
