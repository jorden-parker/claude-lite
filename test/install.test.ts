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
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doctor,
  fixServers,
  install,
  logs,
  ollamaLogPaths,
  ollamaStartupSources,
  servers,
  uninstall,
  update,
} from "../src/install.ts";
import type { Runner } from "../src/ollama/launch.ts";

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
    '--settings "$("/lite/dist/claude-lite" settings)"',
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
  const system = mkdtempSync(join(tmpdir(), "lite-sys-"));
  cpSync(join(import.meta.dir, "..", "config"), join(home, "config"), { recursive: true });
  mkdirSync(join(home, "dist"));
  writeFileSync(join(home, "dist", "claude-lite"), "");
  await install(user, home);
  return { user, home, system };
}

const curlFails: Runner = async (argv) => (argv[0] === "curl" ? 7 : 0);

test("doctor passes after install", async () => {
  const { user, home, system } = await installedHome();
  expect(await doctor(user, home, async () => 0, system)).toBe(0);
});

test("doctor fails when blocks are missing", async () => {
  const { user, home, system } = await installedHome();
  await uninstall(user, home);
  expect(await doctor(user, home, async () => 0, system)).toBe(1);
});

test("doctor fails when the binary does not run", async () => {
  const { user, home, system } = await installedHome();
  expect(await doctor(user, home, async () => 1, system)).toBe(1);
});

test("doctor fails when a config references an unknown hook", async () => {
  const { user, home, system } = await installedHome();
  writeFileSync(join(home, "config", "hooks.json"), '{"command":"x hook nope"}');
  expect(await doctor(user, home, async () => 0, system)).toBe(1);
});

test("doctor fails when the ollama server does not respond", async () => {
  const { user, home, system } = await installedHome();
  expect(await doctor(user, home, curlFails, system)).toBe(1);
});

test("doctor fails with more than one ollama startup source", async () => {
  const { user, home, system } = await installedHome();
  touch(join(user, "Library/LaunchAgents/local.ollama.plist"));
  mkdirSync(join(system, "Applications/Ollama.app"), { recursive: true });
  expect(await doctor(user, home, async () => 0, system)).toBe(1);
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

const plistWithLogs = (out: string, err: string) =>
  `<?xml version="1.0"?><plist><dict><key>StandardOutPath</key>\n  <string>${out}</string><key>StandardErrorPath</key><string>${err}</string></dict></plist>`;

test("ollamaLogPaths reads plist log paths, adds server.log for Ollama.app, drops missing files", () => {
  const { user, system } = ollamaRoots();
  const agentLog = join(user, "Library/Logs/ollama.log");
  touch(agentLog);
  touch(join(user, "Library/LaunchAgents/local.ollama.plist"));
  writeFileSync(
    join(user, "Library/LaunchAgents/local.ollama.plist"),
    plistWithLogs(agentLog, agentLog),
  );
  touch(join(system, "Library/LaunchAgents/homebrew.mxcl.ollama.plist"));
  writeFileSync(
    join(system, "Library/LaunchAgents/homebrew.mxcl.ollama.plist"),
    plistWithLogs(join(system, "missing.log"), join(system, "missing.log")),
  );
  expect(ollamaLogPaths(user, system)).toEqual([agentLog]);
  mkdirSync(join(system, "Applications/Ollama.app"), { recursive: true });
  touch(join(user, ".ollama/logs/server.log"));
  expect(ollamaLogPaths(user, system)).toEqual([agentLog, join(user, ".ollama/logs/server.log")]);
});

test("logs tails the hook log and the ollama logs that exist", async () => {
  const { user, system } = ollamaRoots();
  const agentLog = join(user, "Library/Logs/ollama.log");
  touch(agentLog);
  touch(join(user, "Library/LaunchAgents/local.ollama.plist"));
  writeFileSync(
    join(user, "Library/LaunchAgents/local.ollama.plist"),
    plistWithLogs(agentLog, agentLog),
  );
  let seen: string[] = [];
  const code = await logs(
    user,
    "/lite",
    async (argv) => {
      seen = argv;
      return 7;
    },
    system,
  );
  expect(seen).toEqual([
    "tail",
    "-F",
    "-n",
    "20",
    join(user, ".cache/claude-lite/hooks.log"),
    agentLog,
  ]);
  expect(code).toBe(7);
});

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
  const seen: string[][] = [];
  await servers(
    user,
    "/lite",
    async (argv) => {
      seen.push(argv);
      return 1;
    },
    system,
  );
  expect(seen[0]).toEqual(["lsof", "-nP", "-iTCP:11434", "-sTCP:LISTEN"]);
});

test("servers passes with one startup source", async () => {
  const { user, system } = ollamaRoots();
  touch(join(user, "Library/LaunchAgents/local.ollama.plist"));
  expect(await servers(user, "/lite", async () => 0, system)).toBe(0);
});

test("servers fails when the ollama server does not respond", async () => {
  const { user, system } = ollamaRoots();
  touch(join(user, "Library/LaunchAgents/local.ollama.plist"));
  expect(await servers(user, "/lite", curlFails, system)).toBe(1);
});

test("servers fails with two startup sources", async () => {
  const { user, system } = ollamaRoots();
  touch(join(user, "Library/LaunchAgents/local.ollama.plist"));
  mkdirSync(join(system, "Applications/Ollama.app"), { recursive: true });
  expect(await servers(user, "/lite", async () => 0, system)).toBe(1);
});

const recordingRunner = () => {
  const seen: string[][] = [];
  const run: Runner = async (argv) => {
    seen.push(argv);
    return 0;
  };
  return { seen, run };
};

const userAgent = (user: string) => join(user, "Library/LaunchAgents/local.ollama.plist");
const addApp = (system: string) =>
  mkdirSync(join(system, "Applications/Ollama.app"), { recursive: true });

test("fixServers does nothing with one startup source", async () => {
  const { user, system } = ollamaRoots();
  addApp(system);
  const { seen, run } = recordingRunner();
  expect(await fixServers(user, "/lite", run, system)).toBe(0);
  expect(seen).toEqual([]);
});

test("fixServers boots out and trashes the user agent, then opens Ollama.app", async () => {
  const { user, system } = ollamaRoots();
  touch(userAgent(user));
  addApp(system);
  const { seen, run } = recordingRunner();
  expect(await fixServers(user, "/lite", run, system)).toBe(0);
  expect(seen).toEqual([
    ["launchctl", "bootout", `gui/${process.getuid?.()}`, userAgent(user)],
    ["open", "-a", "Ollama"],
  ]);
  expect(existsSync(join(user, ".Trash/local.ollama.plist"))).toBe(true);
  expect(ollamaStartupSources(user, system)).toHaveLength(1);
});

test("fixServers keeps the agent when there is no Ollama.app", async () => {
  const { user, system } = ollamaRoots();
  touch(userAgent(user));
  touch(join(user, "Library/LaunchAgents/homebrew.mxcl.ollama.plist"));
  expect(await fixServers(user, "/lite", async () => 0, system)).toBe(1);
  expect(existsSync(userAgent(user))).toBe(true);
});

test("fixServers reports system plists as needing sudo", async () => {
  const { user, system } = ollamaRoots();
  touch(join(system, "Library/LaunchDaemons/Ollama.plist"));
  addApp(system);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    expect(await fixServers(user, "/lite", async () => 0, system)).toBe(1);
  } finally {
    console.log = originalLog;
  }
  expect(lines.some((line) => line.includes("needs sudo"))).toBe(true);
});

test("fixServers adds a timestamp when the trash already has that name", async () => {
  const { user, system } = ollamaRoots();
  touch(userAgent(user));
  touch(join(user, ".Trash/local.ollama.plist"));
  addApp(system);
  expect(await fixServers(user, "/lite", async () => 0, system)).toBe(0);
  const trashed = readdirSync(join(user, ".Trash"));
  expect(trashed).toHaveLength(2);
  expect(trashed.some((name) => /^local\.ollama\.plist\.\d+$/.test(name))).toBe(true);
});

const START = "# >>> claude-lite >>>";
const END = "# <<< claude-lite <<<";
const completionFiles = (user: string) => ({
  zsh: join(user, ".local", "share", "zsh", "site-functions", "_cl"),
  bash: join(user, ".local", "share", "bash-completion", "completions", "cl"),
  fish: join(user, ".config", "fish", "completions", "cl.fish"),
});
const countOf = (text: string, needle: string) => text.split(needle).length - 1;

async function completionHome() {
  const user = fixture();
  writeFileSync(join(user, ".bashrc"), "");
  mkdirSync(join(user, ".config", "fish"), { recursive: true });
  writeFileSync(join(user, ".config", "fish", "config.fish"), "");
  const home = mkdtempSync(join(tmpdir(), "lite-"));
  cpSync(join(import.meta.dir, "..", "config"), join(home, "config"), { recursive: true });
  return { user, home };
}

test("install writes completion files and load lines for present shells", async () => {
  const { user, home } = await completionHome();
  await install(user, home);
  await install(user, home);
  const files = completionFiles(user);
  for (const path of Object.values(files)) {
    const text = readFileSync(path, "utf8");
    expect(countOf(text, START)).toBe(1);
    expect(countOf(text, END)).toBe(1);
    expect(text).toContain("27b");
  }
  const zshrc = readFileSync(join(user, ".zshrc"), "utf8");
  expect(zshrc).toContain("fpath+=(");
  expect(zshrc).toContain("(( $+functions[compdef] )) || { autoload -Uz compinit; compinit; }");
  expect(zshrc).toContain("compdef _cl cl");
  expect(countOf(zshrc, START)).toBe(1);
  const bashrc = readFileSync(join(user, ".bashrc"), "utf8");
  expect(bashrc).toContain(`. ${files.bash}`);
  expect(countOf(bashrc, START)).toBe(1);
});

test("install skips the fish file without config.fish", async () => {
  const { user, home } = await completionHome();
  rmSync(join(user, ".config", "fish", "config.fish"));
  await install(user, home);
  expect(existsSync(completionFiles(user).fish)).toBe(false);
  expect(existsSync(completionFiles(user).zsh)).toBe(true);
});

test("uninstall removes completion files but leaves foreign ones", async () => {
  const { user, home } = await completionHome();
  await install(user, home);
  writeFileSync(completionFiles(user).fish, "mine\n");
  await uninstall(user, home);
  expect(existsSync(completionFiles(user).zsh)).toBe(false);
  expect(existsSync(completionFiles(user).bash)).toBe(false);
  expect(readFileSync(completionFiles(user).fish, "utf8")).toBe("mine\n");
});
