import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportLines, counterDelta, type DiagnosticReport } from "../src/report-data.ts";
import { renderReport } from "../src/report-view.ts";

const model = "mlx-community--Qwen3.8-27B-4bit";
const start = "2026-11-27T14:00:00.000Z";
const end = "2026-11-27T14:07:00.000Z";
const edit = (id: string) => ({
  type: "tool_use",
  id,
  name: "Edit",
  input: { file_path: "private-file-name" },
});
const result = (id: string, is_error = false) => ({
  type: "tool_result",
  tool_use_id: id,
  is_error,
  content: "private-result",
});
function line(cwd: string, type: string, content: object[], timestamp = start) {
  return JSON.stringify({
    cwd,
    sessionId: "90af24f1-566d-465d-a317-ceedfff11f50",
    type,
    timestamp,
    message: { role: type, model, content },
  });
}
test("keeps every flagged tool visible, even when later calls succeeded", () => {
  const report: DiagnosticReport = {
    captured: end,
    samples: [{ at: end }],
    warnings: [],
    sessions: [
      {
        client: "Claude Code",
        id: "first",
        project: "work",
        lastActivity: end,
        tools: [
          { name: "Bash", at: start, result: start, failed: true },
          { name: "Write", at: start, result: end },
          { name: "mcp__custom__inspect", at: start },
          { name: "Agent", at: start, continued: true },
          ...Array.from({ length: 8 }, () => ({ name: "Read", at: end, result: end })),
        ],
      },
    ],
  };
  const html = renderReport(report);
  expect(html).toContain("4 flagged calls");
  expect(html).toContain("Continued without result");
  expect(html).toContain("7m 0s to result");
  expect(reportLines(report).join("\n")).toContain("mcp__custom__inspect · No recorded result");
});

test("an unavailable or restarted server yields unknown counter changes and escaped HTML", () => {
  const report: DiagnosticReport = {
    captured: end,
    sessions: [],
    warnings: [],
    samples: [
      { at: start, requests: 1, uptime: 20 },
      { at: end, requests: 2, uptime: 1, models: ['<img onerror="bad">'] },
    ],
  };
  expect(counterDelta(report, "requests")).toBeUndefined();
  const html = renderReport(report);
  expect(html).not.toContain("<img onerror=");
  expect(html).toContain("No matching sessions");
  report.samples = [{ at: start, error: "Status endpoint unavailable" }];
  expect(renderReport(report)).toContain("Status endpoint unavailable");
});

test("cl report captures the running server and another project's slow Edit without transcript contents", async () => {
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
      join(history, "90af24f1-566d-465d-a317-ceedfff11f50.jsonl"),
      [line(project, "assistant", [edit("a")]), line(project, "user", [result("a")], end)].join(
        "\n",
      ),
    );
    const repo = join(import.meta.dir, "..");
    const oldSession = "40af24f1-566d-465d-a317-ceedfff11f44";
    await writeFile(
      join(history, oldSession + ".jsonl"),
      JSON.stringify({
        type: "assistant",
        sessionId: oldSession,
        cwd: project,
        timestamp: start,
        message: { model: "previous-local-alias", content: [edit("b")] },
      }),
    );
    const launch = (...flags: string[]) =>
      Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "report", ...flags], {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          OLLAMA_HOST: "127.0.0.1:" + server.port,
          XDG_DATA_HOME: join(root, "data"),
          CLAUDE_CONFIG_DIR: claudeDir,
          CLAUDE_LITE_HOME: repo,
          CLAUDE_LITE_MLX_PORT: String(server.port),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    const proc = launch();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(samples).toBe(2);
    expect(stdout).toContain("Edit · Slow result");
    expect(stdout).toContain("Sample change · requests 1 · prompt tokens 1000 · cached tokens 800");
    const html = await readFile(join(root, ".cache/claude-lite/reports/latest.html"), "utf8");
    expect(html).toContain("7m 0s to result");
    expect(html).toContain("Processing");
    expect(html).not.toContain("private-file-name");
    expect(html).not.toContain("private-result");
    expect(html).not.toContain(oldSession);
    const all = launch("--all-models");
    const output = await new Response(all.stdout).text();
    expect(await all.exited).toBe(0);
    expect(output).toContain(oldSession);
    expect(output).toContain("Edit · No recorded result");
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
