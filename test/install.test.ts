import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, uninstall, update } from "../src/install.ts";

function fixture() {
  const user = mkdtempSync(join(tmpdir(), "inst-"));
  mkdirSync(join(user, ".claude"));
  writeFileSync(join(user, ".claude", "CLAUDE.md"), "mine\n");
  writeFileSync(join(user, ".zshrc"), "export A=1\n");
  return user;
}

const clPath = (user: string) => join(user, ".local", "bin", "cl");

test("install adds blocks idempotently, uninstall restores", async () => {
  const user = fixture();
  expect(await install(user, "/lite")).toBe(0);
  await install(user, "/lite");
  const md = readFileSync(join(user, ".claude", "CLAUDE.md"), "utf8");
  expect(md.match(/>>> claude-lite/g)?.length).toBe(1);
  expect(md).toContain("@/lite/config/PREFERENCES.md");
  expect(readFileSync(join(user, ".zshrc"), "utf8")).toContain(
    '--settings "/lite/config/personal-settings.json"',
  );
  expect(readdirSync(join(user, ".claude")).some((f) => f.startsWith("CLAUDE.md.bak-"))).toBe(true);
  expect(readlinkSync(clPath(user))).toBe("/lite/dist/claude-lite");
  expect(await uninstall(user, "/lite")).toBe(0);
  expect(existsSync(clPath(user))).toBe(false);
  expect(readFileSync(join(user, ".claude", "CLAUDE.md"), "utf8")).toBe("mine\n");
  expect(readFileSync(join(user, ".zshrc"), "utf8")).toBe("export A=1\n");
});

test("install upgrades an old install and repoints the link", async () => {
  const user = fixture();
  await install(user, "/elsewhere");
  expect(readlinkSync(clPath(user))).toBe("/elsewhere/dist/claude-lite");
  await install(user, "/lite");
  expect(readlinkSync(clPath(user))).toBe("/lite/dist/claude-lite");
  const md = readFileSync(join(user, ".claude", "CLAUDE.md"), "utf8");
  expect(md.match(/>>> claude-lite/g)?.length).toBe(1);
});

test("install leaves a regular file or unrelated link alone", async () => {
  const regular = fixture();
  mkdirSync(join(regular, ".local", "bin"), { recursive: true });
  writeFileSync(clPath(regular), "mine");
  await install(regular, "/lite");
  expect(lstatSync(clPath(regular)).isSymbolicLink()).toBe(false);
  expect(readFileSync(clPath(regular), "utf8")).toBe("mine");

  const unrelated = fixture();
  mkdirSync(join(unrelated, ".local", "bin"), { recursive: true });
  symlinkSync("/usr/bin/other", clPath(unrelated));
  await install(unrelated, "/lite");
  expect(readlinkSync(clPath(unrelated))).toBe("/usr/bin/other");
  await uninstall(unrelated, "/lite");
  expect(readlinkSync(clPath(unrelated))).toBe("/usr/bin/other");
});

test("update runs pull, install deps, build, install in order", async () => {
  const calls: string[][] = [];
  const code = await update("/u", "/lite", async (argv) => {
    calls.push(argv);
    return 0;
  });
  expect(code).toBe(0);
  expect(calls).toEqual([
    ["git", "-C", "/lite", "pull", "--ff-only"],
    ["bun", "install", "--cwd", "/lite"],
    ["bun", "run", "--cwd", "/lite", "build"],
    ["/lite/dist/claude-lite", "install"],
  ]);
});

test("update stops at the first failing step and returns its code", async () => {
  const calls: string[][] = [];
  const code = await update("/u", "/lite", async (argv) => {
    calls.push(argv);
    return calls.length === 2 ? 7 : 0;
  });
  expect(code).toBe(7);
  expect(calls).toHaveLength(2);
});
