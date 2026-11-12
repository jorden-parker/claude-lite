import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_HELP } from "../src/help.ts";
import { FLAGS } from "../src/ollama/size-overrides.ts";

const runCli = (...args: string[]) => Bun.spawnSync(["bun", "src/cli.ts", ...args]);

describe("cli help", () => {
  for (const flag of ["--help", "-h"]) {
    test(`${flag} prints usage to stdout and exits 0`, () => {
      const result = runCli(flag);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("usage: claude-lite");
    });
  }

  test("--help lists every command", () => {
    const stdout = runCli("--help").stdout.toString();
    for (const command of Object.keys(COMMAND_HELP)) {
      expect(stdout).toContain(command);
    }
  });

  for (const command of Object.keys(COMMAND_HELP)) {
    for (const flag of ["--help", "-h"]) {
      test(`${command} ${flag} prints usage without running`, () => {
        const result = runCli(command, flag);
        const stdout = result.stdout.toString();
        expect(result.exitCode).toBe(0);
        expect(stdout).toContain(`usage: claude-lite ${command}`);
        expect(stdout).not.toMatch(/done|failed/);
      });
    }
  }

  test("hook --help lists hook names", () => {
    expect(runCli("hook", "--help").stdout.toString()).toContain("bash-guard");
  });

  test("install --help mentions shell completion", () => {
    expect(runCli("install", "--help").stdout.toString()).toContain("completion");
  });

  test("unknown command prints usage to stderr and exits 2", () => {
    const result = runCli("bogus");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("usage: claude-lite");
  });
});

test("ollama help lists every ollama flag", () => {
  const flags = ["--print-config", "--effort", ...Object.keys(FLAGS)];
  for (const flag of flags) expect(COMMAND_HELP.ollama).toContain(flag);
});

test("bench help lists its flags", () => {
  for (const flag of ["--json", "--think", "--effort", "--runs", "--compare"]) {
    expect(COMMAND_HELP.bench).toContain(flag);
  }
});

test("ollama and bench help list every configured size", async () => {
  const sizes = await Bun.file(join(import.meta.dir, "..", "config", "sizes.json")).json();
  for (const sizeName of Object.keys(sizes)) {
    expect(COMMAND_HELP.ollama).toContain(sizeName);
    expect(COMMAND_HELP.bench).toContain(sizeName);
  }
});

test("servers help says it sets the server env", () => {
  expect(COMMAND_HELP.servers).toContain("launchctl setenv");
});

test("stats has help text", () => {
  expect(Object.keys(COMMAND_HELP)).toContain("stats");
});

test("stats runs and summarizes an empty hook log", () => {
  const userHome = mkdtempSync(join(tmpdir(), "cli-stats-"));
  const result = Bun.spawnSync(["bun", "src/cli.ts", "stats"], {
    env: { ...process.env, HOME: userHome },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("no hook decisions logged");
});

describe("cli strictness and completion", () => {
  test("__complete ollama lists sizes, then flags after a size", () => {
    const sizes = runCli("__complete", "ollama").stdout.toString();
    expect(sizes).toContain("27b");
    expect(sizes).not.toContain("--think");
    const stdout = runCli("__complete", "ollama", "27b").stdout.toString();
    expect(stdout).toContain("--think");
  });

  test("help ollama prints ollama help", () => {
    const result = runCli("help", "ollama");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("usage: claude-lite ollama");
  });

  test("lifecycle command rejects extra args", () => {
    const result = runCli("doctor", "extra");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("usage: claude-lite doctor");
    expect(result.stdout.toString()).not.toContain("done");
  });

  test("hook alone prints hook help", () => {
    const result = runCli("hook");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("usage: claude-lite hook");
  });
});
