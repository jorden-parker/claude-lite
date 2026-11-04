import { describe, expect, test } from "bun:test";

const runCli = (...args: string[]) => Bun.spawnSync(["bun", "src/cli.ts", ...args]);

describe("cli help", () => {
  for (const flag of ["--help", "-h"]) {
    test(`${flag} prints usage to stdout and exits 0`, () => {
      const result = runCli(flag);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("usage: claude-lite");
    });
  }

  test("--help lists logs", () => {
    expect(runCli("--help").stdout.toString()).toContain("logs");
  });

  for (const command of ["hook", "ollama", "install", "update", "uninstall", "doctor", "logs"]) {
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

  test("unknown command prints usage to stderr and exits 2", () => {
    const result = runCli("bogus");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("usage: claude-lite");
  });
});
