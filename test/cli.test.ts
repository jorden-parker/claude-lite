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

  test("unknown command prints usage to stderr and exits 2", () => {
    const result = runCli("bogus");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("usage: claude-lite");
  });
});
