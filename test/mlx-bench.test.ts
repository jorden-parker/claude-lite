import { expect, test } from "bun:test";
import { mlxBenchChat } from "../src/mlx-bench.ts";
import { streamChat } from "../src/ollama/api.ts";
import { engineEvidence, logOffset } from "../src/bench-runtime.ts";
import {
  appendFileSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("oMLX benchmark reconstructs streamed calls and reads the server's own timings", async () => {
  const delta = (d: object, finish_reason: string | null = null) => ({
    choices: [{ delta: d, finish_reason }],
  });
  const events = [
    delta({ role: "assistant" }),
    delta({ tool_calls: [{ index: 0, function: { name: "Read", arguments: '{"file_' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'path":"dispatch.ts"}' } }] }),
    delta({}, "tool_calls"),
    {
      choices: [],
      usage: {
        completion_tokens: 8,
        prompt_tokens: 4020,
        prompt_tokens_details: { cached_tokens: 4000 },
        generation_duration: 0.5,
        prompt_eval_duration: 0.1,
      },
    },
  ];
  let body: any;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      body = await request.json();
      return new Response(
        events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("") + "data: [DONE]\n\n",
      );
    },
  });
  try {
    const result = await mlxBenchChat(server.url.origin, {
      model: "fixture",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "Read", arguments: { file_path: "router.ts" } } }],
        },
        { role: "tool", content: "file contents" },
        { role: "user", content: "look", images: ["AAAA"] },
      ],
      options: { num_predict: 8192, num_ctx: 131072 },
    });
    expect(body.messages[1].tool_call_id).toBe(body.messages[0].tool_calls[0].id);
    expect(body.messages[0].tool_calls[0].function.arguments).toBe('{"file_path":"router.ts"}');
    expect(body.messages[2].content[1].image_url.url).toBe("data:image/png;base64,AAAA");
    expect(result.message.tool_calls).toEqual([
      { function: { name: "Read", arguments: { file_path: "dispatch.ts" } } },
    ]);
    expect(result.tool_call_seconds!).toBeGreaterThanOrEqual(result.first_token_seconds!);
    expect(result).toMatchObject({
      cached_tokens: 4000,
      prompt_eval_count: 20,
      eval_duration: 5e8,
      prompt_eval_duration: 1e8,
    });
  } finally {
    server.stop(true);
  }
});

test("metadata-only streams never report time to first output", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      new Response(
        new URL(req.url).pathname === "/api/chat"
          ? JSON.stringify({ done: true, message: { role: "assistant", content: "" } })
          : 'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ),
  });
  try {
    const request = { model: "fixture", messages: [] };
    expect((await streamChat(request, server.url.origin)).first_token_seconds).toBeUndefined();
    expect((await mlxBenchChat(server.url.origin, request)).first_token_seconds).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("engine confirmation requires observed activity during the run", () => {
  const log = join(mkdtempSync(join(tmpdir(), "engine-evidence-")), "server.log");
  writeFileSync(log, "speculative decode stats iterations=4 drafted=10\n");
  const start = logOffset(log);
  appendFileSync(log, "speculative decode stats iterations=0 drafted=0\n");
  expect(engineEvidence("ollama", log, start)).toBeNull();
  appendFileSync(log, "speculative decode stats iterations=2 drafted=14\n");
  expect(engineEvidence("ollama", log, start)).toContain("observed");
  writeFileSync(log, "DFlash drafter load raised; toggle ignored");
  expect(engineEvidence("dflash", log)).toBeNull();
  appendFileSync(log, "\nDFlash drafter attached to engine: fixture");
  expect(engineEvidence("dflash", log)).toContain("attached");
});

test("bench CLI runs the native 27b workload against an isolated oMLX fixture", async () => {
  const root = mkdtempSync(join(tmpdir(), "cl-mlx-cli-"));
  const hub = join(root, "hub");
  const model = "mlx-community--Qwen3.8-27B-4bit";
  try {
    for (const id of [model, "incoai--Qwen3.8-27B-DFlash2"]) {
      mkdirSync(join(hub, "models--" + id, "snapshots", "rev"), { recursive: true });
    }
    writeFileSync(
      join(root, "omlx"),
      `#!${process.execPath}
const arg = flag => process.argv[process.argv.indexOf(flag)+1];
const base = arg("--base-path");
const settings = (await Bun.file(base+"/model_settings.json").json()).models["${model}"];
if (settings.dflash_draft_quant_enabled !== true || settings.dflash_block_size !== 5) process.exit(8);
await Bun.write(process.env.BENCH_BASE_FILE, base);
Bun.serve({hostname:"127.0.0.1",port:Number(arg("--port")),async fetch(req){
  const path = new URL(req.url).pathname;
  if(path==="/v1/models") return Response.json({data:[{id:"${model}"}]});
  if(path==="/api/status") return Response.json({model_memory_used:123456});
  if(path!=="/v1/chat/completions") return new Response("",{status:404});
  const body=await req.json();
  if(body.model!=="${model}" || body.max_tokens!==8192 || body.chat_template_kwargs.enable_thinking!==false)
    return new Response("wrong model settings",{status:400});
  console.log("DFlash drafter attached to engine: ${model}");
  const first=body.messages[1].content;
  const file=typeof first==="string" && first.startsWith("Snapshot ") ?
    body.messages.at(-1).role==="tool" ? "dispatch.ts" : "router.ts" : null;
  const result=file ? {tool_calls:[{index:0,function:{name:"Read",arguments:JSON.stringify({file_path:file})}}]} : {content:"red blue"};
  const events=[{choices:[{delta:result}]},{choices:[{delta:{},finish_reason:file?"tool_calls":"stop"}]},
    {choices:[],usage:{prompt_tokens:4020,completion_tokens:10,generation_duration:0.25,prompt_eval_duration:0.5,prompt_tokens_details:{cached_tokens:4000}}}];
  return new Response(events.map(e=>"data: "+JSON.stringify(e)+"\\n\\n").join("")+"data: [DONE]\\n\\n");
}});`,
      { mode: 0o755 },
    );
    const baseFile = join(root, "started");
    const checkout = join(import.meta.dir, "..");
    const child = Bun.spawn(
      [
        process.execPath,
        join(checkout, "src", "cli.ts"),
        "bench",
        "27b",
        "--backend",
        "mlx",
        "--engine",
        "dflash",
        "--json",
      ],
      {
        env: {
          ...process.env,
          PATH: root + ":" + process.env.PATH,
          HOME: root,
          HF_HUB_CACHE: hub,
          CLAUDE_LITE_HOME: checkout,
          OLLAMA_HOST: "http://127.0.0.1:1",
          CLAUDE_LITE_MLX_PORT: "1",
          BENCH_BASE_FILE: baseFile,
          CLAUDE_LITE_THINKING: "off",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr: code ? stderr : "" }).toEqual({ code: 0, stderr: "" });
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({
      backend: "mlx",
      engine: "dflash",
      engineEvidence: "native DFlash drafter attached",
      peakSampledModelBytes: 123456,
    });
    expect(report.turns).toHaveLength(4);
    expect(
      report.tasks
        .filter((t: { name: string }) => t.name.startsWith("coding-") || t.name === "vision-colors")
        .every((t: { failure: unknown }) => t.failure === null),
    ).toBe(true);
    expect(existsSync(readFileSync(baseFile, "utf8"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
