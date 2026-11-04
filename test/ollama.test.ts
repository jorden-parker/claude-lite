import { expect, test } from "bun:test";
import { join } from "node:path";
import { launch, type Runner } from "../src/ollama/launch.ts";
import { renderModelfile } from "../src/ollama/modelfile.ts";

const home = join(import.meta.dir, "..");
const recorder = (failShow: boolean) => {
  const calls: string[][] = [];
  const envs: any[] = [];
  const run: Runner = async (argv, env) => {
    calls.push(argv);
    envs.push(env);
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
  expect(calls.map((c) => c[1])).toEqual(["show", "--settings"]);
  const claude = calls[1];
  expect(claude[0]).toBe("claude");
  expect(claude.slice(-2)).toEqual(["-p", "hi"]);
  expect(claude[claude.indexOf("--model") + 1]).toBe("qwen3.6-35b-cc");
  expect(envs[1].ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
  expect(envs[1].ANTHROPIC_API_KEY).toBeUndefined();
});

test("missing model pulls and creates, default size 27b", async () => {
  const { calls, run } = recorder(true);
  await launch(home, [], run);
  expect(calls.map((c) => c[1])).toEqual(["show", "pull", "create", "--settings"]);
  expect(calls[1][2]).toBe("qwen3.8:27b-mlx");
});

test("personal settings carry the same hooks as hooks.json", async () => {
  const read = async (name: string) => await Bun.file(join(home, "config", name)).json();
  expect((await read("personal-settings.json")).hooks).toEqual(await read("hooks.json"));
});

test("launch plan helpers stay internal to the launcher", async () => {
  expect(Object.keys(await import("../src/ollama/launch.ts"))).not.toContain("buildPlan");
});
