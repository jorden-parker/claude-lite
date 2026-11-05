import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionPath, completionScript } from "../src/completion.ts";

const words = {
  commands: ["install", "hook", "ollama"],
  hooks: ["bash-guard", "tdd-guard"],
  sizes: ["27b", "35b"],
};
const shells = ["zsh", "bash", "fish"] as const;
const syntaxCheck = { zsh: ["zsh", "-n"], bash: ["bash", "-n"], fish: ["fish", "-n"] };

test.each(shells)("%s script lists every word", (shell) => {
  const script = completionScript(shell, words);
  const expected = [
    ...words.commands,
    ...words.hooks,
    ...words.sizes,
    "--print-config",
    "--think",
    "--no-think",
    "--permissions",
    "--no-permissions",
    "--sandbox",
    "--no-sandbox",
    "--help",
  ];
  for (const word of expected) expect(script).toContain(word);
});

test.each(shells)("%s script passes its shell's syntax check", (shell) => {
  const [binary, flag] = syntaxCheck[shell];
  if (!Bun.which(binary)) return;
  const file = join(mkdtempSync(join(tmpdir(), "comp-")), "script");
  writeFileSync(file, completionScript(shell, words));
  expect(Bun.spawnSync([binary, flag, file]).exitCode).toBe(0);
});

test("zsh script keeps #compdef first", () => {
  expect(completionScript("zsh", words).startsWith("#compdef cl\n")).toBe(true);
});

test("completionPath places each shell's file", () => {
  expect(completionPath("/u", "fish")).toBe("/u/.config/fish/completions/cl.fish");
  expect(completionPath("/u", "bash")).toBe("/u/.local/share/bash-completion/completions/cl");
  expect(completionPath("/u", "zsh")).toBe("/u/.local/share/zsh/site-functions/_cl");
});
