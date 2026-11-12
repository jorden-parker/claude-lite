import { expect, test } from "bun:test";
import {
  fetchApi,
  isRemoteHost,
  mergeChunks,
  ollamaUrl,
  parseParameters,
  streamChat,
  unloadModels,
} from "../src/ollama/api.ts";

test("parseParameters reads numeric lines and skips text values", () => {
  const shown = 'num_ctx          65536\ntemperature      0.7\nstop             "<|im_end|>"\n';
  expect(parseParameters(shown)).toEqual({ num_ctx: 65536, temperature: 0.7 });
});

test("parseParameters returns an empty object for empty text", () => {
  expect(parseParameters("")).toEqual({});
});

const readCall = { function: { name: "Read", arguments: {} } };
const serveLines = (lines: object[]) =>
  Bun.serve({
    port: 0,
    fetch: () => new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"),
  });

test("mergeChunks joins content and thinking, keeps tool calls and the final counters", () => {
  const merged = mergeChunks([
    { message: { role: "assistant", content: "Hel", thinking: "hm" } },
    { message: { role: "assistant", content: "lo", tool_calls: [readCall] } },
    { message: { role: "assistant", content: "" }, eval_count: 7, eval_duration: 5 },
  ]);
  expect(merged.message).toEqual({
    role: "assistant",
    content: "Hello",
    thinking: "hm",
    tool_calls: [readCall],
  });
  expect(merged).toMatchObject({ eval_count: 7, eval_duration: 5 });
});

test("streamChat reads a streamed reply and times the first chunk", async () => {
  const server = serveLines([
    { message: { role: "assistant", content: "Hi" } },
    { message: { role: "assistant", content: "" }, eval_count: 2 },
  ]);
  try {
    const reply = await streamChat({ model: "m", messages: [] }, `http://localhost:${server.port}`);
    expect(reply.message.content).toBe("Hi");
    expect(reply.eval_count).toBe(2);
    expect(reply.first_token_seconds).toBeGreaterThanOrEqual(0);
  } finally {
    server.stop(true);
  }
});

test("streamChat throws the server's error line", async () => {
  const server = serveLines([{ error: "model not found" }]);
  const request = { model: "m", messages: [] };
  try {
    await expect(streamChat(request, `http://localhost:${server.port}`)).rejects.toThrow(
      "model not found",
    );
  } finally {
    server.stop(true);
  }
});

test("ollamaUrl defaults to 127.0.0.1 and normalizes OLLAMA_HOST", () => {
  expect(ollamaUrl({})).toBe("http://127.0.0.1:11434");
  expect(ollamaUrl({ OLLAMA_HOST: "studio.local" })).toBe("http://studio.local:11434");
  expect(ollamaUrl({ OLLAMA_HOST: "studio.local:8080" })).toBe("http://studio.local:8080");
  expect(ollamaUrl({ OLLAMA_HOST: "https://ollama.example.com/" })).toBe(
    "https://ollama.example.com",
  );
});

test("isRemoteHost is false for this machine and true for another one", () => {
  expect(isRemoteHost({})).toBe(false);
  expect(isRemoteHost({ OLLAMA_HOST: "127.0.0.1:11434" })).toBe(false);
  expect(isRemoteHost({ OLLAMA_HOST: "0.0.0.0" })).toBe(false);
  expect(isRemoteHost({ OLLAMA_HOST: "studio.local" })).toBe(true);
});

test("unloadModels unloads every loaded model with keep_alive 0", async () => {
  const unloadBodies: any[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/api/ps")
        return Response.json({ models: [{ name: "first" }, { name: "second" }] });
      unloadBodies.push(await request.json());
      return Response.json({});
    },
  });
  try {
    expect(await unloadModels(`http://localhost:${server.port}`)).toEqual(["first", "second"]);
    expect(unloadBodies).toEqual([
      { model: "first", keep_alive: 0 },
      { model: "second", keep_alive: 0 },
    ]);
  } finally {
    server.stop(true);
  }
});

test("unloadModels returns nothing when Ollama is down or has nothing loaded", async () => {
  expect(await unloadModels("http://127.0.0.1:1")).toEqual([]);
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ models: [] }) });
  try {
    expect(await unloadModels(`http://localhost:${server.port}`)).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("fetchApi talks to the server named by OLLAMA_HOST", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({}) });
  const previous = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = `localhost:${server.port}`;
  try {
    expect(await fetchApi.load("any-model")).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = previous;
    server.stop(true);
  }
});
