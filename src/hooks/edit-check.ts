import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { EXTENSION_LANGUAGES, newComments } from "./comments.ts";
import type { HookEvent, HookResult } from "./types.ts";

type Run = (command: string[], cwd: string) => { ok: boolean; output: string } | null;

export const defaultRun: Run = (command, cwd) => {
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8" });
  if (result.error) return null;
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
};

const onPath = (tool: string) => spawnSync("which", [tool], { encoding: "utf8" }).status === 0;

function nearestDirWith(start: string, names: string[]): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    if (names.some((name) => existsSync(join(dir, name)))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function checksFor(path: string, language: string): { command: string[]; cwd: string }[] {
  const cwd = dirname(path);
  if (language === "go") return [{ command: ["gofmt", "-l", path], cwd }];
  if (language === "python") return [{ command: ["ruff", "check", path], cwd }];
  if (language === "shell") return [{ command: ["shellcheck", path], cwd }];
  const root = nearestDirWith(cwd, ["node_modules"]);
  if (!root) return [];
  const bin = (name: string) => join(root, "node_modules", ".bin", name);
  const tools: [string, string[]][] = [
    ["prettier", ["--check"]],
    ["eslint", []],
    ["biome", ["check"]],
  ];
  return tools
    .filter(([name]) => existsSync(bin(name)))
    .map(([name, args]) => ({ command: [bin(name), ...args, path], cwd: root }));
}

function committedText(path: string): string {
  const result = spawnSync("git", ["-C", dirname(path), "show", `HEAD:./${path.split("/").pop()}`], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout : "";
}

function writtenPairs(path: string, input: Record<string, any>): [string, string][] {
  const edits = input.edits ?? (input.new_string !== undefined ? [input] : null);
  if (edits) return edits.map((e: any) => [e.old_string ?? "", e.new_string ?? ""]);
  return [[committedText(path), input.content ?? ""]];
}

export function decide(
  event: HookEvent,
  run: Run = defaultRun,
  available: (tool: string) => boolean = onPath,
): HookResult {
  const input = event.tool_input ?? {};
  if (!["Edit", "Write", "MultiEdit"].includes(event.tool_name ?? "") || !input.file_path) return null;
  const path = resolve(event.cwd ?? ".", input.file_path);
  const language = EXTENSION_LANGUAGES[extname(path)];
  if (!language || !existsSync(path)) return null;
  const problems: string[] = [];
  const comments = writtenPairs(path, input).flatMap(([before, after]) =>
    newComments(before, after, language),
  );
  if (comments.length)
    problems.push(
      `New comments are not allowed; rewrite the code so it explains itself:\n${comments.slice(0, 5).join("\n")}`,
    );
  for (const check of checksFor(path, language)) {
    const tool = check.command[0];
    if (!tool.includes("/") && !available(tool)) continue;
    const result = run(check.command, check.cwd);
    if (result && (!result.ok || (tool === "gofmt" && result.output.trim() !== ""))) {
      problems.push(`${tool.split("/").pop()} failed:\n${result.output.split("\n").slice(0, 40).join("\n")}`);
    }
  }
  return problems.length ? { exitCode: 2, stderr: problems.join("\n\n") } : null;
}
