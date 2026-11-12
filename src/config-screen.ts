import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EFFORT_LEVELS } from "./completion.ts";
import { defaultSize, type Size } from "./ollama/sizes.ts";

type JsonObject = Record<string, any>;

export type ConfigState = {
  ollamaOverlay: JsonObject;
  ollamaBase: JsonObject;
  baseSizes: Record<string, Size>;
  sizesOverlay: Record<string, JsonObject>;
  automaticSize: string;
  cursor: number;
};

type ConfigRow = {
  section: string;
  label: string;
  value: string;
  choices: readonly string[];
  choose: (state: ConfigState, value: string) => ConfigState;
  editFile?: string;
};

type KeyOutcome = { state: ConfigState; exit?: "save" | "cancel"; edit?: string };

const OLLAMA_EFFORTS = ["unset", ...EFFORT_LEVELS];
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];
const SWITCH_CHOICES = ["off", "on"];
const OUTPUT_TOKEN_LIMITS = [4096, 8192, 16384, 32768];
const CLIENTS = ["claude", "qwen", "opencode"];
const ENTER_KEY = "\r";
const UNSET_VALUES = new Set(["default", "unset"]);
const LABEL_WIDTH = 20;
const CURSOR_MOVES_BY_KEY: Record<string, number> = { "\x1b[A": -1, k: -1, "\x1b[B": 1, j: 1 };
const VALUE_STEPS_BY_KEY: Record<string, number> = { "\x1b[C": 1, "\r": 1, " ": 1, "\x1b[D": -1 };
const SAVE_KEYS = new Set(["q", "\x1b"]);
const CANCEL_KEY = "\x03";

function withKey(object: JsonObject, key: string, value: unknown): JsonObject {
  const { [key]: _removed, ...objectWithoutKey } = object;
  return UNSET_VALUES.has(String(value)) ? objectWithoutKey : { ...objectWithoutKey, [key]: value };
}

const findMarkedSize = (state: ConfigState) =>
  Object.keys(state.sizesOverlay).find((name) => state.sizesOverlay[name].default === true);

const mergeSizeSettings = (state: ConfigState, name: string) => ({
  ...state.baseSizes[name],
  ...state.sizesOverlay[name],
});

function withSizeKey(state: ConfigState, name: string, key: string, value: unknown): ConfigState {
  const sizeOverlay = withKey(state.sizesOverlay[name] ?? {}, key, value);
  return { ...state, sizesOverlay: { ...state.sizesOverlay, [name]: sizeOverlay } };
}

const describeSwitch = (isOn: unknown) => (isOn ? "on" : "off");

function withOllamaSection(
  state: ConfigState,
  section: string,
  sectionOverlay: JsonObject,
): ConfigState {
  return { ...state, ollamaOverlay: { ...state.ollamaOverlay, [section]: sectionOverlay } };
}

function withPermissionMode(state: ConfigState, mode: string): ConfigState {
  const permissions = state.ollamaOverlay.permissions ?? {};
  const isBaseMode = (state.ollamaBase.permissions?.defaultMode ?? "default") === mode;
  const { defaultMode: _previous, ...permissionsWithoutMode } = permissions;
  return withOllamaSection(
    state,
    "permissions",
    isBaseMode ? permissionsWithoutMode : { ...permissionsWithoutMode, defaultMode: mode },
  );
}

function buildSandboxAndPermissionRows(state: ConfigState): ConfigRow[] {
  return [
    {
      section: "Ollama",
      label: "Sandbox",
      value: describeSwitch(
        state.ollamaOverlay.sandbox?.enabled ?? state.ollamaBase.sandbox?.enabled,
      ),
      choices: SWITCH_CHOICES,
      choose: (current, value) =>
        withOllamaSection(current, "sandbox", {
          ...current.ollamaOverlay.sandbox,
          enabled: value === "on",
        }),
    },
    {
      section: "Ollama",
      label: "Permission mode",
      value:
        state.ollamaOverlay.permissions?.defaultMode ??
        state.ollamaBase.permissions?.defaultMode ??
        "default",
      choices: PERMISSION_MODES,
      choose: (current, value) => withPermissionMode(current, value),
    },
  ];
}

const buildEditRow = (label: string, editFile: string): ConfigRow => ({
  section: "Ollama",
  label,
  value: `config/${editFile} ↵`,
  choices: [],
  choose: (state) => state,
  editFile,
});

function withDefaultSize(state: ConfigState, name: string): ConfigState {
  const unmarkedOverlays = Object.fromEntries(
    Object.entries(state.sizesOverlay).map(([sizeName, overlay]) => [
      sizeName,
      withKey(overlay, "default", "unset"),
    ]),
  );
  if (!Object.hasOwn(state.baseSizes, name)) return { ...state, sizesOverlay: unmarkedOverlays };
  return {
    ...state,
    sizesOverlay: { ...unmarkedOverlays, [name]: { ...unmarkedOverlays[name], default: true } },
  };
}

const listOutputTokenChoices = (current: number) =>
  [...new Set([...OUTPUT_TOKEN_LIMITS, current])].sort((first, second) => first - second);

const describeClient = (size: Partial<Size>) =>
  size.qwen ? "qwen" : size.opencode ? "opencode" : "claude";

function withClient(state: ConfigState, name: string, client: string): ConfigState {
  const withoutQwen = withSizeKey(state, name, "qwen", client === "qwen" ? true : "unset");
  return withSizeKey(withoutQwen, name, "opencode", client === "opencode" ? true : "unset");
}

const describeSizeModels = (name: string, size: Size) =>
  [name, `ollama ${size.base}`, ...(size.mlx ? [`mlx ${size.mlx}`] : [])].join(" · ");

function buildSizeRows(state: ConfigState, name: string): ConfigRow[] {
  const sizeSettings = mergeSizeSettings(state, name);
  const section = describeSizeModels(name, sizeSettings);
  return [
    {
      section,
      label: "Thinking",
      value: describeSwitch(sizeSettings.thinking),
      choices: SWITCH_CHOICES,
      choose: (current, value) => withSizeKey(current, name, "thinking", value === "on"),
    },
    {
      section,
      label: "Effort",
      value: sizeSettings.effort ?? "unset",
      choices: OLLAMA_EFFORTS,
      choose: (current, value) => withSizeKey(current, name, "effort", value),
    },
    {
      section,
      label: "Output tokens",
      value: String(sizeSettings.output_tokens),
      choices: listOutputTokenChoices(sizeSettings.output_tokens).map(String),
      choose: (current, value) => withSizeKey(current, name, "output_tokens", Number(value)),
    },
    {
      section,
      label: "Client",
      value: describeClient(sizeSettings),
      choices: CLIENTS,
      choose: (current, value) => withClient(current, name, value),
    },
  ];
}

function buildConfigRows(state: ConfigState): ConfigRow[] {
  const automaticChoice = `auto (${state.automaticSize})`;
  return [
    {
      section: "Ollama",
      label: "Default size",
      value: findMarkedSize(state) ?? automaticChoice,
      choices: [automaticChoice, ...Object.keys(state.baseSizes)],
      choose: withDefaultSize,
    },
    ...buildSandboxAndPermissionRows(state),
    buildEditRow("System prompt", "system-prompt.md"),
    ...Object.keys(state.baseSizes).flatMap((name) => buildSizeRows(state, name)),
  ];
}

export function renderConfig(state: ConfigState): string {
  const lines: string[] = [];
  buildConfigRows(state).forEach((row, index, rows) => {
    if (rows[index - 1]?.section !== row.section) lines.push(row.section);
    const cursorMarker = index === state.cursor ? ">" : " ";
    lines.push(`${cursorMarker} ${row.label.padEnd(LABEL_WIDTH)}${row.value}`);
  });
  return `${lines.join("\n")}\n\n↑↓ move · ←→ change · ↵ edit file · q save · ctrl-c cancel`;
}

function cycleRowValue(state: ConfigState, step: number): ConfigState {
  const row = buildConfigRows(state)[state.cursor];
  const choiceCount = row.choices.length;
  const nextIndex = (row.choices.indexOf(row.value) + step + choiceCount) % choiceCount;
  return row.choose(state, row.choices[nextIndex]);
}

export function pressKey(state: ConfigState, key: string): KeyOutcome {
  if (key === CANCEL_KEY) return { state, exit: "cancel" };
  if (SAVE_KEYS.has(key)) return { state, exit: "save" };
  if (Object.hasOwn(CURSOR_MOVES_BY_KEY, key)) {
    const lastRow = buildConfigRows(state).length - 1;
    const cursor = Math.min(lastRow, Math.max(0, state.cursor + CURSOR_MOVES_BY_KEY[key]));
    return { state: { ...state, cursor } };
  }
  const { editFile } = buildConfigRows(state)[state.cursor];
  if (editFile) return key === ENTER_KEY ? { state, edit: editFile } : { state };
  if (Object.hasOwn(VALUE_STEPS_BY_KEY, key))
    return { state: cycleRowValue(state, VALUE_STEPS_BY_KEY[key]) };
  return { state };
}

const resolveConfigPath = (home: string, name: string) => join(home, "config", name);

const readJson = (path: string): JsonObject => JSON.parse(readFileSync(path, "utf8"));

const readOverlay = (path: string): JsonObject => (existsSync(path) ? readJson(path) : {});

export function loadConfigState(home: string): ConfigState {
  const baseSizes = readJson(resolveConfigPath(home, "sizes.json")) as Record<string, Size>;
  return {
    ollamaOverlay: readOverlay(resolveConfigPath(home, "local-ollama.json")),
    ollamaBase: readJson(resolveConfigPath(home, "ollama.json")),
    baseSizes,
    sizesOverlay: readOverlay(resolveConfigPath(home, "local-sizes.json")),
    automaticSize: defaultSize(baseSizes),
    cursor: 0,
  };
}

const writeJson = (path: string, contents: JsonObject) =>
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`);

export function saveConfigState(home: string, state: ConfigState): void {
  writeJson(resolveConfigPath(home, "local-ollama.json"), state.ollamaOverlay);
  writeJson(resolveConfigPath(home, "local-sizes.json"), state.sizesOverlay);
}

const ESCAPE = String.fromCharCode(27);
const TERMINAL_KEY_PATTERN = new RegExp(`${ESCAPE}\\[[A-D]|[\\s\\S]`, "g");

export const splitKeys = (chunk: string) => chunk.match(TERMINAL_KEY_PATTERN) ?? [];

const CLEAR_SCREEN = "\x1b[2J\x1b[H";

function editInTerminal(path: string) {
  const editorCommand = (process.env.VISUAL || process.env.EDITOR || "vi").split(" ");
  process.stdin.setRawMode(false);
  Bun.spawnSync([...editorCommand, path], { stdio: ["inherit", "inherit", "inherit"] });
  process.stdin.setRawMode(true);
}

export function runConfigScreen(state: ConfigState, home: string): Promise<ConfigState | null> {
  const { stdin, stdout } = process;
  let current = state;
  stdout.write(CLEAR_SCREEN + renderConfig(current));
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    const respondToKey = (chunk: Buffer) => {
      let exitChoice: KeyOutcome["exit"];
      for (const key of splitKeys(chunk.toString())) {
        const outcome = pressKey(current, key);
        current = outcome.state;
        if (outcome.edit) editInTerminal(resolveConfigPath(home, outcome.edit));
        exitChoice = outcome.exit;
        if (exitChoice) break;
      }
      stdout.write(CLEAR_SCREEN + renderConfig(current));
      if (!exitChoice) return;
      stdin.off("data", respondToKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      resolve(exitChoice === "save" ? current : null);
    };
    stdin.on("data", respondToKey);
  });
}
