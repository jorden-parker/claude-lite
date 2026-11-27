import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTrace, readFinding, counterDelta, type DiagnosticReport } from "../src/report-data.ts";
import { renderReport } from "../src/report-view.ts";

const model = "mlx-community--Qwen3.8-27B-4bit";
const start = "2026-11-27T14:00:00.000Z";
const end = "2026-11-27T14:07:00.000Z";
const read = (id: string) => ({
  type: "tool_use",
  id,
  name: "Read",
  input: { file_path: "private-file-name" },
});
const result = (id: string, is_error = false) => ({
  type: "tool_result",
  tool_use_id: id,
  is_error,
  content: "private-result",
});
function line(cwd: string, type: string, content: object[], timestamp = start) {
  return JSON.stringify({ cwd, type, timestamp, message: { model, content } });
}
const models = new Set([model]);

test("matches parallel Read IDs, drops unrelated sessions, sidechains and partial JSON", () => {
  const trace = readTrace(
    [
      line("/p", "assistant", [read("a"), read("b")]),
      line("/p", "user", [result("b", true)], end),
      line("/other", "user", [result("a")], end),
      JSON.stringify({ ...JSON.parse(line("/p", "user", [result("a")], end)), isSidechain: true }),
      '{"partial"',
    ].join("\n"),
    "/p",
    models,
  );
  expect(trace?.reads).toEqual([{ at: start }, { at: start, result: end, failed: true }]);
  expect(readFinding({ trace, samples: [], captured: end }).title).toBe("Read result outstanding");
  expect(readTrace(line("/p", "assistant", [read("a")]), "/p", new Set())).toBeUndefined();
});

test("a later assistant turn supersedes an abandoned Read", () => {
  const trace = readTrace(
    [
      line("/p", "assistant", [read("old")]),
      line("/p", "assistant", [read("current")], end),
      line("/p", "user", [result("current")], end),
    ].join("\n"),
    "/p",
    models,
  );
  expect(trace?.reads[0].continued).toBe(true);
  expect(readFinding({ trace, samples: [], captured: end }).title).toBe("Read returned");
});

test("an unavailable or restarted server yields unknown counter changes and escaped HTML", () => {
  const report: DiagnosticReport = {
    captured: end,
    samples: [
      { at: start, requests: 1, uptime: 20 },
      { at: end, requests: 2, uptime: 1, models: ['<img onerror="bad">'] },
    ],
  };
  expect(counterDelta(report, "requests")).toBeUndefined();
  const html = renderReport(report);
  expect(html).not.toContain("<img onerror=");
  expect(html).toContain("No matching transcript");
  report.samples = [{ at: start, error: "Status endpoint unavailable" }];
  expect(renderReport(report)).toContain("Status endpoint unavailable");
});

test("cl report captures the running server and current project's Read outcome without transcript contents", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cl-report-")));
  const project = join(root, "work");
  const claudeDir = join(root, "user-config");
  const history = join(claudeDir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  let samples = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname !== "/api/status") return new Response(null, { status: 404 });
      samples++;
      return Response.json({
        status: "ok",
        version: "0.8.4",
        loaded_models: [model],
        active_requests: 1,
        waiting_requests: 0,
        total_requests: 3 + samples,
        total_prompt_tokens: 1000 * samples,
        total_cached_tokens: 800 * samples,
        avg_prefill_tps: 175,
      });
    },
  });
  try {
    await mkdir(project);
    await mkdir(history, { recursive: true });
    await writeFile(
      join(history, "session.jsonl"),
      [line(project, "assistant", [read("a")]), line(project, "user", [result("a")], end)].join(
        "\n",
      ),
    );
    const repo = join(import.meta.dir, "..");
    const proc = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "report"], {
      cwd: project,
      env: {
        ...process.env,
        HOME: root,
        CLAUDE_CONFIG_DIR: claudeDir,
        CLAUDE_LITE_HOME: repo,
        CLAUDE_LITE_MLX_PORT: String(server.port),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(samples).toBe(2);
    expect(stdout).toContain("Read returned");
    expect(stdout).toContain("Sample change · requests 1 · prompt tokens 1000 · cached tokens 800");
    const html = await readFile(join(root, ".cache/claude-lite/reports/latest.html"), "utf8");
    expect(html).toContain("7m 0s to result");
    expect(html).toContain("Processing");
    expect(html).not.toContain("private-file-name");
    expect(html).not.toContain("private-result");
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
