import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConfigState,
  loadConfigState,
  pressKey,
  renderConfig,
  saveConfigState,
  splitKeys,
} from "../src/config-screen.ts";
import { config } from "../src/install.ts";
import type { Size } from "../src/ollama/sizes.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

const sizeWith = (overrides: Partial<Size>): Size => ({
  base: "b",
  model: "m",
  context: 100,
  output_tokens: 10,
  parameters: {},
  thinking: false,
  ...overrides,
});

const initialState: ConfigState = {
  ollamaOverlay: {},
  ollamaBase: { sandbox: { enabled: true } },
  baseSizes: { "27b": sizeWith({}), "9b": sizeWith({ thinking: true }) },
  sizesOverlay: {},
  automaticSize: "27b",
  cursor: 0,
};

const ROW_INDEX = {
  defaultSize: 0,
  thinking: 1,
  ollamaEffort: 2,
  outputTokens: 3,
  ollamaSandbox: 4,
  ollamaPermissionMode: 5,
  systemPrompt: 6,
};

const pressAll = (state: ConfigState, keys: string[]) =>
  keys.reduce((current, key) => pressKey(current, key).state, state);

const pressOnRow = (state: ConfigState, row: number, keys: string[]) =>
  pressAll(state, [...Array(row).fill(DOWN), ...keys]);

const screenLine = (cursorMarker: string, label: string, value: string) =>
  `${cursorMarker} ${label.padEnd(20)}${value}`;

test("renders every ollama setting with the current values and the cursor", () => {
  expect(renderConfig(initialState)).toContain(
    [
      "Ollama",
      screenLine(">", "Default size", "auto (27b)"),
      screenLine(" ", "Thinking (27b)", "off"),
      screenLine(" ", "Effort (27b)", "unset"),
      screenLine(" ", "Output tokens (27b)", "10"),
      screenLine(" ", "Sandbox", "on"),
      screenLine(" ", "Permission mode", "default"),
      screenLine(" ", "System prompt", "config/system-prompt.md ↵"),
    ].join("\n"),
  );
});

test("the screen has no Claude rows", () => {
  const screen = renderConfig(initialState);
  expect(screen).not.toContain("Claude");
  expect(screen).not.toContain("Preferences");
  expect(screen).not.toContain("Model");
});

test("choosing a default size marks only that size in the sizes overlay", () => {
  const marked = { ...initialState, sizesOverlay: { "27b": { default: true, thinking: true } } };
  const state = pressOnRow(marked, ROW_INDEX.defaultSize, [RIGHT]);
  expect(state.sizesOverlay).toEqual({ "27b": { thinking: true }, "9b": { default: true } });
});

test("the default size cycles back to auto, which removes every mark", () => {
  const marked = { ...initialState, sizesOverlay: { "9b": { default: true, thinking: true } } };
  expect(renderConfig(marked)).toContain(screenLine(">", "Default size", "9b"));
  const stateWithAutoSize = pressOnRow(marked, ROW_INDEX.defaultSize, [RIGHT]);
  expect(stateWithAutoSize.sizesOverlay).toEqual({ "9b": { thinking: true } });
  expect(renderConfig(stateWithAutoSize)).toContain(screenLine(">", "Default size", "auto (27b)"));
});

test("output tokens cycle through the common limits as numbers in the size overlay", () => {
  const state = pressOnRow(initialState, ROW_INDEX.outputTokens, [RIGHT]);
  expect(state.sizesOverlay["27b"]).toEqual({ output_tokens: 4096 });
  expect(pressAll(state, [RIGHT]).sizesOverlay["27b"]).toEqual({ output_tokens: 8192 });
});

test("the footer explains that enter opens file rows", () => {
  expect(renderConfig(initialState)).toContain("↵ edit file");
});

test("size rows follow the chosen default size", () => {
  const state = pressOnRow(initialState, ROW_INDEX.defaultSize, [RIGHT, RIGHT]);
  expect(renderConfig(state)).toContain(screenLine(" ", "Thinking (9b)", "on"));
  const toggled = pressAll(state, [DOWN, RIGHT]);
  expect(toggled.sizesOverlay["9b"]).toEqual({ default: true, thinking: false });
});

test("ollama effort cycles from unset and back to unset removes the key", () => {
  const withEffort = pressOnRow(initialState, ROW_INDEX.ollamaEffort, [RIGHT]);
  expect(withEffort.sizesOverlay["27b"]).toEqual({ effort: "low" });
  expect(pressAll(withEffort, [LEFT]).sizesOverlay).toEqual({ "27b": {} });
});

test("ollama sandbox and permission mode go to the ollama overlay, not the size", () => {
  const sandboxOff = pressOnRow(initialState, ROW_INDEX.ollamaSandbox, [RIGHT]);
  expect(sandboxOff.ollamaOverlay).toEqual({ sandbox: { enabled: false } });
  const planMode = pressAll(sandboxOff, [DOWN, RIGHT, RIGHT]);
  expect(planMode.ollamaOverlay.permissions).toEqual({ defaultMode: "plan" });
  expect(planMode.sizesOverlay).toEqual({});
});

test("permission mode default removes defaultMode from the overlay", () => {
  const state = pressOnRow(initialState, ROW_INDEX.ollamaPermissionMode, [RIGHT]);
  expect(state.ollamaOverlay.permissions).toEqual({ defaultMode: "acceptEdits" });
  expect(pressAll(state, [LEFT]).ollamaOverlay.permissions).toEqual({});
});

test("sandbox falls back to the base value without an overlay", () => {
  expect(renderConfig(initialState)).toContain(screenLine(" ", "Sandbox", "on"));
});

test("enter on System prompt asks to edit its file, and other keys do nothing there", () => {
  const atSystemPrompt = pressOnRow(initialState, ROW_INDEX.systemPrompt, []);
  expect(pressKey(atSystemPrompt, "\r").edit).toBe("system-prompt.md");
  expect(pressKey(atSystemPrompt, RIGHT)).toEqual({ state: atSystemPrompt });
});

test("splitKeys separates arrow sequences, escape and plain keys that arrive together", () => {
  expect(splitKeys(`${DOWN}${DOWN}\rq\x1b`)).toEqual([DOWN, DOWN, "\r", "q", "\x1b"]);
});

test("the cursor stays inside the rows", () => {
  expect(pressAll(initialState, [UP]).cursor).toBe(0);
  expect(pressAll(initialState, Array(20).fill(DOWN)).cursor).toBe(ROW_INDEX.systemPrompt);
});

test("q and escape save, ctrl-c cancels, other keys keep going", () => {
  expect(pressKey(initialState, "q").exit).toBe("save");
  expect(pressKey(initialState, "\x1b").exit).toBe("save");
  expect(pressKey(initialState, "\x03").exit).toBe("cancel");
  expect(pressKey(initialState, "x").exit).toBeUndefined();
});

function liteHomeWith(files: Record<string, object>) {
  const home = mkdtempSync(join(tmpdir(), "config-screen-"));
  mkdirSync(join(home, "config"));
  for (const [name, contents] of Object.entries(files))
    writeFileSync(join(home, "config", name), JSON.stringify(contents));
  return home;
}

const baseFiles = {
  "ollama.json": { sandbox: { enabled: true } },
  "sizes.json": { "27b": sizeWith({ memory_gb: 1 }), "9b": sizeWith({ memory_gb: 1 }) },
};

test("loadConfigState reads the ollama overlay and base, and the base sizes", () => {
  const home = liteHomeWith({
    ...baseFiles,
    "local-ollama.json": { sandbox: { enabled: false } },
    "local-sizes.json": { "9b": { default: true } },
  });
  const state = loadConfigState(home);
  expect(state.ollamaOverlay).toEqual({ sandbox: { enabled: false } });
  expect(state.ollamaBase).toEqual({ sandbox: { enabled: true } });
  expect(Object.keys(state.baseSizes)).toEqual(["27b", "9b"]);
  expect(state.sizesOverlay).toEqual({ "9b": { default: true } });
  expect(state.automaticSize).toBe("27b");
  expect(state.cursor).toBe(0);
});

test("loadConfigState treats missing overlays as empty", () => {
  const state = loadConfigState(liteHomeWith(baseFiles));
  expect(state.ollamaOverlay).toEqual({});
  expect(state.sizesOverlay).toEqual({});
});

test("saveConfigState writes the ollama overlays as formatted JSON", () => {
  const home = liteHomeWith(baseFiles);
  saveConfigState(home, {
    ...loadConfigState(home),
    ollamaOverlay: { sandbox: { enabled: false } },
    sizesOverlay: { "9b": { default: true } },
  });
  const readConfigFile = (name: string) => readFileSync(join(home, "config", name), "utf8");
  expect(readConfigFile("local-ollama.json")).toBe(
    '{\n  "sandbox": {\n    "enabled": false\n  }\n}\n',
  );
  expect(JSON.parse(readConfigFile("local-sizes.json"))).toEqual({ "9b": { default: true } });
  expect(existsSync(join(home, "config", "local-claude.json"))).toBe(false);
});

test("cl config without a terminal prints the screen and writes nothing", async () => {
  const home = liteHomeWith(baseFiles);
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    expect(await config("/unused", home)).toBe(0);
  } finally {
    console.log = original;
  }
  expect(lines.join("\n")).toContain(screenLine(">", "Default size", "auto (27b)"));
  expect(existsSync(join(home, "config", "local-ollama.json"))).toBe(false);
});
