import { expect, test } from "bun:test";
import { runQwen } from "../src/qwen.ts";

const launchEnvironment = async (inheritedNodeOptions?: string) => {
  const previous = process.env.NODE_OPTIONS;
  if (inheritedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = inheritedNodeOptions;
  let captured: Record<string, string | undefined> = {};
  try {
    await runQwen(
      { model: "qwen", url: "http://127.0.0.1:11434", args: [] },
      async (_argv, env) => {
        captured = env ?? {};
        return 0;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
  return captured;
};

test("qwen starts with the max listeners warning disabled", async () => {
  const environment = await launchEnvironment();
  expect(environment.NODE_OPTIONS).toBe("--disable-warning=MaxListenersExceededWarning");
});

test("qwen keeps inherited node options", async () => {
  const environment = await launchEnvironment("--max-old-space-size=4096");
  expect(environment.NODE_OPTIONS).toBe(
    "--max-old-space-size=4096 --disable-warning=MaxListenersExceededWarning",
  );
});
