import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, uninstall } from "../src/install.ts";

function fixture() {
  const user = mkdtempSync(join(tmpdir(), "inst-"));
  mkdirSync(join(user, ".claude"));
  writeFileSync(join(user, ".claude", "CLAUDE.md"), "mine\n");
  writeFileSync(join(user, ".zshrc"), "export A=1\n");
  return user;
}

test("install adds blocks idempotently, uninstall restores", () => {
  const user = fixture();
  install(user, "/lite");
  install(user, "/lite");
  const md = readFileSync(join(user, ".claude", "CLAUDE.md"), "utf8");
  expect(md.match(/>>> claude-lite/g)?.length).toBe(1);
  expect(md).toContain("@/lite/config/PREFERENCES.md");
  expect(readFileSync(join(user, ".zshrc"), "utf8")).toContain(
    '--settings "/lite/config/personal-settings.json"',
  );
  expect(readdirSync(join(user, ".claude")).some((f) => f.startsWith("CLAUDE.md.bak-"))).toBe(true);
  uninstall(user, "/lite");
  expect(readFileSync(join(user, ".claude", "CLAUDE.md"), "utf8")).toBe("mine\n");
  expect(readFileSync(join(user, ".zshrc"), "utf8")).toBe("export A=1\n");
});
