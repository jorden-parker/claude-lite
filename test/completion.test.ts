import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionPath, completionScript, nextWords } from "../src/completion.ts";

const words = {
  commands: ["install", "doctor", "hook", "ollama"],
  hooks: ["bash-guard", "tdd-guard"],
  sizes: ["27b", "35b"],
};
const shells = ["zsh", "bash", "fish"] as const;
const syntaxCheck = { zsh: ["zsh", "-n"], bash: ["bash", "-n"], fish: ["fish", "-n"] };

const complete = (...typed: string[]) => nextWords(typed, words);
const ollamaFlags = [
  "--think",
  "--no-think",
  "--permissions",
  "--no-permissions",
  "--sandbox",
  "--no-sandbox",
  "--effort",
];

describe("nextWords", () => {
  test("offers commands and help first", () => {
    expect(complete()).toEqual([...words.commands, "help"]);
  });
  test("offers commands after help only", () => {
    expect(complete("help")).toEqual(words.commands);
    expect(complete("help", "doctor")).toEqual([]);
  });
  test("lifecycle command offers --help once", () => {
    expect(complete("doctor")).toEqual(["--help"]);
    expect(complete("doctor", "--help")).toEqual([]);
  });
  test("hook offers names then nothing", () => {
    expect(complete("hook")).toEqual([...words.hooks, "--help"]);
    expect(complete("hook", "bash-guard")).toEqual([]);
  });
  test("ollama offers sizes and help first", () => {
    expect(complete("ollama")).toEqual([...words.sizes, "--help"]);
  });
  test("ollama offers flags after a size", () => {
    expect(complete("ollama", "27b")).toEqual(["--print-config", ...ollamaFlags]);
  });
  test("ollama drops the used sandbox pair", () => {
    expect(complete("ollama", "27b", "--no-sandbox")).toEqual([
      "--print-config",
      "--think",
      "--no-think",
      "--permissions",
      "--no-permissions",
      "--effort",
    ]);
  });
  test("ollama drops sizes, used flags and their pair", () => {
    const next = complete("ollama", "27b", "--think");
    expect(next).toEqual([
      "--print-config",
      "--permissions",
      "--no-permissions",
      "--sandbox",
      "--no-sandbox",
      "--effort",
    ]);
  });
  test("ollama drops --effort once its value is typed", () => {
    expect(complete("ollama", "27b", "--effort", "low")).toEqual([
      "--print-config",
      ...ollamaFlags.slice(0, -1),
    ]);
  });
  test("ollama offers effort levels after --effort", () => {
    expect(complete("ollama", "27b", "--effort")).toEqual(["low", "medium", "xhigh"]);
  });
  test("ollama offers nothing after --help", () => {
    expect(complete("ollama", "--help")).toEqual([]);
  });
  test("unknown command offers nothing", () => {
    expect(complete("nope")).toEqual([]);
  });
});

test.each(shells)("%s script passes its shell's syntax check", (shell) => {
  const [binary, flag] = syntaxCheck[shell];
  if (!Bun.which(binary)) return;
  const file = join(mkdtempSync(join(tmpdir(), "comp-")), "script");
  writeFileSync(file, completionScript(shell));
  expect(Bun.spawnSync([binary, flag, file]).exitCode).toBe(0);
});

test("zsh script keeps #compdef first", () => {
  expect(completionScript("zsh").startsWith("#compdef cl\n")).toBe(true);
});

test("zsh script calls compadd without a function wrapper", () => {
  const script = completionScript("zsh");
  expect(script).toContain("compadd --");
  expect(script).not.toContain("_cl() {");
});

test("completionPath places each shell's file", () => {
  expect(completionPath("/u", "fish")).toBe("/u/.config/fish/completions/cl.fish");
  expect(completionPath("/u", "bash")).toBe("/u/.local/share/bash-completion/completions/cl");
  expect(completionPath("/u", "zsh")).toBe("/u/.local/share/zsh/site-functions/_cl");
});
