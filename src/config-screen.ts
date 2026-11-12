import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EFFORT_LEVELS } from "./completion.ts";
import { defaultSize, type Size } from "./ollama/sizes.ts";

type JsonObject = Record<string, any>;

export type ConfigState = {
  claudeOverlay: JsonObject;
  claudeBase: JsonObject;
  ollamaOverlay: JsonObject;
  ollamaBase: JsonObject;
  baseSizes: Record<string, Size>;
  sizesOverlay: Record<string, JsonObject>;
  automaticSize: string;
  cursor: number;
};

type SettingsTarget = "claude" | "ollama";

type ConfigRow = {
  section: "Claude" | "Ollama";
  label: string;
  value: string;
  choices: readonly string[];
  choose: (state: ConfigState, value: string) => ConfigState;
  editFile?: string;
};

type KeyOutcome = { state: ConfigState; exit?: "save" | "cancel"; edit?: string };

const CLAUDE_MODELS = ["default", "opus", "sonnet", "haiku"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const OLLAMA_EFFORTS = ["unset", ...EFFORT_LEVELS];
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];
const SWITCH_CHOICES = ["off", "on"];
const OUTPUT_TOKEN_LIMITS = [4096, 8192, 16384, 32768];
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

const resolveChosenSize = (state: ConfigState) => findMarkedSize(state) ?? state.automaticSize;

const mergeSizeSettings = (state: ConfigState, name: string) => ({
  ...state.baseSizes[name],
  ...state.sizesOverlay[name],
});

function withSizeKey(state: ConfigState, key: string, value: unknown): ConfigState {
  const name = resolveChosenSize(state);
  const sizeOverlay = withKey(state.sizesOverlay[name] ?? {}, key, value);
  return { ...state, sizesOverlay: { ...state.sizesOverlay, [name]: sizeOverlay } };
}

const describeSwitch = (isOn: unknown) => (isOn ? "on" : "off");

const selectOverlay = (state: ConfigState, target: SettingsTarget) => state[`${target}Overlay`];

const selectBase = (state: ConfigState, target: SettingsTarget) => state[`${target}Base`];

function withSettingsSection(
  state: ConfigState,
  target: SettingsTarget,
  section: string,
  sectionOverlay: JsonObject,
): ConfigState {
  const overlay = { ...selectOverlay(state, target), [section]: sectionOverlay };
  return { ...state, [`${target}Overlay`]: overlay };
}

function withPermissionMode(state: ConfigState, target: SettingsTarget, mode: string) {
  const permissions = selectOverlay(state, target).permissions ?? {};
  const isBaseMode = (selectBase(state, target).permissions?.defaultMode ?? "default") === mode;
  const { defaultMode: _previous, ...permissionsWithoutMode } = permissions;
  return withSettingsSection(
    state,
    target,
    "permissions",
    isBaseMode ? permissionsWithoutMode : { ...permissionsWithoutMode, defaultMode: mode },
  );
}

function buildSandboxAndPermissionRows(state: ConfigState, target: SettingsTarget): ConfigRow[] {
  const section = target === "claude" ? "Claude" : "Ollama";
  const overlay = selectOverlay(state, target);
  const base = selectBase(state, target);
  return [
    {
      section,
      label: "Sandbox",
      value: describeSwitch(overlay.sandbox?.enabled ?? base.sandbox?.enabled),
      choices: SWITCH_CHOICES,
      choose: (current, value) =>
        withSettingsSection(current, target, "sandbox", {
          ...selectOverlay(current, target).sandbox,
          enabled: value === "on",
        }),
    },
    {
      section,
      label: "Permission mode",
      value: overlay.permissions?.defaultMode ?? base.permissions?.defaultMode ?? "default",
      choices: PERMISSION_MODES,
      choose: (current, value) => withPermissionMode(current, target, value),
    },
  ];
}

const buildEditRow = (
  section: ConfigRow["section"],
  label: string,
  editFile: string,
): ConfigRow => ({
  section,
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

function buildConfigRows(state: ConfigState): ConfigRow[] {
  const size = resolveChosenSize(state);
  const sizeSettings = mergeSizeSettings(state, size);
  const { claudeBase, claudeOverlay } = state;
  const automaticChoice = `auto (${state.automaticSize})`;
  return [
    {
      section: "Claude",
      label: "Model",
      value: state.claudeOverlay.model ?? "default",
      choices: CLAUDE_MODELS,
      choose: (current, value) => ({
        ...current,
        claudeOverlay: withKey(current.claudeOverlay, "model", value),
      }),
    },
    {
      section: "Claude",
      label: "Effort",
      value: claudeOverlay.effortLevel ?? claudeBase.effortLevel ?? "medium",
      choices: CLAUDE_EFFORTS,
      choose: (current, value) => ({
        ...current,
        claudeOverlay: withKey(current.claudeOverlay, "effortLevel", value),
      }),
    },
    ...buildSandboxAndPermissionRows(state, "claude"),
    buildEditRow("Claude", "Preferences", "PREFERENCES.md"),
    {
      section: "Ollama",
      label: "Default size",
      value: findMarkedSize(state) ?? automaticChoice,
      choices: [automaticChoice, ...Object.keys(state.baseSizes)],
      choose: withDefaultSize,
    },
    {
      section: "Ollama",
      label: `Thinking (${size})`,
      value: describeSwitch(sizeSettings.thinking),
      choices: SWITCH_CHOICES,
      choose: (current, value) => withSizeKey(current, "thinking", value === "on"),
    },
    {
      section: "Ollama",
      label: `Effort (${size})`,
      value: sizeSettings.effort ?? "unset",
      choices: OLLAMA_EFFORTS,
      choose: (current, value) => withSizeKey(current, "effort", value),
    },
    {
      section: "Ollama",
      label: `Output tokens (${size})`,
      value: String(sizeSettings.output_tokens),
      choices: listOutputTokenChoices(sizeSettings.output_tokens).map(String),
      choose: (current, value) => withSizeKey(current, "output_tokens", Number(value)),
    },
    ...buildSandboxAndPermissionRows(state, "ollama"),
    buildEditRow("Ollama", "System prompt", "system-prompt.md"),
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
    claudeOverlay: readOverlay(resolveConfigPath(home, "local-claude.json")),
    claudeBase: readJson(resolveConfigPath(home, "claude.json")),
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
  writeJson(resolveConfigPath(home, "local-claude.json"), state.claudeOverlay);
  writeJson(resolveConfigPath(home, "local-ollama.json"), state.ollamaOverlay);
  writeJson(resolveConfigPath(home, "local-sizes.json"), state.sizesOverlay);
}

// eslint-disable-next-line no-control-regex
const TERMINAL_KEY_PATTERN = /\x1b\[[A-D]|[\s\S]/g;

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
