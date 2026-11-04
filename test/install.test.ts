import { expect, test } from "bun:test";
import {
  cpSync,
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
import {
  doctor,
  install,
  logs,
  ollamaStartupSources,
  servers,
  uninstall,
  update,
} from "../src/install.ts";

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

async function installedHome() {
  const user = fixture();
  const home = mkdtempSync(join(tmpdir(), "lite-"));
  cpSync(join(import.meta.dir, "..", "config"), join(home, "config"), { recursive: true });
  mkdirSync(join(home, "dist"));
  writeFileSync(join(home, "dist", "claude-lite"), "");
  await install(user, home);
  return { user, home };
}

test("doctor passes after install", async () => {
  const { user, home } = await installedHome();
  expect(await doctor(user, home, async () => 0)).toBe(0);
});

test("doctor fails when blocks are missing", async () => {
  const { user, home } = await installedHome();
  await uninstall(user, home);
  expect(await doctor(user, home, async () => 0)).toBe(1);
});

test("doctor fails when the binary does not run", async () => {
  const { user, home } = await installedHome();
  expect(await doctor(user, home, async () => 1)).toBe(1);
});

test("doctor fails when a config references an unknown hook", async () => {
  const { user, home } = await installedHome();
  writeFileSync(join(home, "config", "hooks.json"), '{"command":"x hook nope"}');
  expect(await doctor(user, home, async () => 0)).toBe(1);
});

test("logs tails the hook log and the ollama server log", async () => {
  let seen: string[] = [];
  const code = await logs("/u", "/lite", async (argv) => {
    seen = argv;
    return 7;
  });
  expect(seen).toEqual([
    "tail",
    "-F",
    "-n",
    "20",
    "/u/.cache/claude-lite/hooks.log",
    "/u/.ollama/logs/server.log",
  ]);
  expect(code).toBe(7);
});

function ollamaRoots() {
  const user = mkdtempSync(join(tmpdir(), "srv-user-"));
  const system = mkdtempSync(join(tmpdir(), "srv-sys-"));
  return { user, system };
}

const touch = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
};

test("ollamaStartupSources finds launch agents, daemons and Ollama.app", () => {
  const { user, system } = ollamaRoots();
  touch(join(user, "Library/LaunchAgents/local.ollama.plist"));
  touch(join(user, "Library/LaunchAgents/com.example.other.plist"));
  touch(join(system, "Library/LaunchAgents/homebrew.mxcl.ollama.plist"));
  touch(join(system, "Library/LaunchDaemons/Ollama.plist"));
  mkdirSync(join(system, "Applications/Ollama.app"), { recursive: true });
  mkdirSync(join(user, "Applications/Ollama.app"), { recursive: true });
  expect(ollamaStartupSources(user, system)).toEqual([
    join(user, "Library/LaunchAgents/local.ollama.plist"),
    join(system, "Library/LaunchAgents/homebrew.mxcl.ollama.plist"),
    join(system, "Library/LaunchDaemons/Ollama.plist"),
    join(system, "Applications/Ollama.app"),
    join(user, "Applications/Ollama.app"),
  ]);
});

test("ollamaStartupSources is empty when nothing is installed", () => {
  const { user, system } = ollamaRoots();
  expect(ollamaStartupSources(user, system)).toEqual([]);
});

test("servers shows the port 11434 listener", async () => {
  const { user, system } = ollamaRoots();
  let seen: string[] = [];
  await servers(
    user,
    "/lite",
    async (argv) => {
      seen = argv;
      return 1;
    },
    system,
  );
  expect(seen).toEqual(["lsof", "-nP", "-iTCP:11434", "-sTCP:LISTEN"]);
});

test("servers passes with one startup source", async () => {
  const { user, system } = ollamaRoots();
  touch(join(user, "Library/LaunchAgents/local.ollama.plist"));
  expect(await servers(user, "/lite", async () => 0, system)).toBe(0);
});

test("servers fails with two startup sources", async () => {
  const { user, system } = ollamaRoots();
  touch(join(user, "Library/LaunchAgents/local.ollama.plist"));
  mkdirSync(join(system, "Applications/Ollama.app"), { recursive: true });
  expect(await servers(user, "/lite", async () => 0, system)).toBe(1);
});
