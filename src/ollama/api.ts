const DEFAULT_URL = "http://127.0.0.1:11434";
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

type Env = Record<string, string | undefined>;

export function ollamaUrl(env: Env = process.env): string {
  const host = env.OLLAMA_HOST?.trim().replace(/\/+$/, "");
  if (!host) return DEFAULT_URL;
  if (host.includes("://")) return host;
  return `http://${/:\d+$/.test(host) ? host : `${host}:11434`}`;
}

export const isRemoteHost = (env: Env = process.env) =>
  !LOCAL_HOSTS.includes(new URL(ollamaUrl(env)).hostname);

export type ToolCall = { function: { name: string; arguments: Record<string, unknown> } };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  think?: boolean | string;
  options?: Record<string, number>;
};

export type ChatReply = {
  message: ChatMessage;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  total_duration?: number;
  first_token_seconds?: number;
};

export type OllamaApi = {
  load: (model: string) => Promise<string | null>;
  chat: (request: ChatRequest) => Promise<ChatReply>;
};

export type LauncherApi = OllamaApi & {
  parameters: (model: string) => Promise<Record<string, number> | null>;
};

export function parseParameters(shown: string): Record<string, number> {
  const pairs = shown
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((words) => words.length === 2 && !Number.isNaN(Number(words[1])));
  return Object.fromEntries(pairs.map(([name, amount]) => [name, Number(amount)]));
}

async function post(path: string, body: unknown): Promise<Record<string, any>> {
  const response = await fetch(`${ollamaUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, any>;
  if (typeof parsed.error === "string") throw new Error(parsed.error);
  return parsed;
}

export function mergeChunks(chunks: ChatReply[]): ChatReply {
  const messages = chunks.map((chunk) => chunk.message);
  const thinking = messages.map((message) => message.thinking ?? "").join("");
  const toolCalls = messages.flatMap((message) => message.tool_calls ?? []);
  return {
    ...chunks.at(-1),
    message: {
      role: "assistant",
      content: messages.map((message) => message.content).join(""),
      ...(thinking && { thinking }),
      ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    },
  };
}

async function* replyLines(response: Response): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(bytes, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    yield* lines;
  }
  yield pending;
}

export async function streamChat(request: ChatRequest, baseUrl = ollamaUrl()): Promise<ChatReply> {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, stream: true }),
  });
  const chunks: ChatReply[] = [];
  let firstChunkAt = startedAt;
  for await (const line of replyLines(response)) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line);
    if (typeof chunk.error === "string") throw new Error(chunk.error);
    if (chunks.length === 0) firstChunkAt = performance.now();
    chunks.push(chunk);
  }
  return { ...mergeChunks(chunks), first_token_seconds: (firstChunkAt - startedAt) / 1000 };
}

export async function unloadModels(baseUrl = ollamaUrl()): Promise<string[]> {
  try {
    const running = (await (await fetch(`${baseUrl}/api/ps`)).json()) as {
      models?: { name: string }[];
    };
    const names = (running.models ?? []).map((model) => model.name);
    for (const model of names) {
      await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, keep_alive: 0 }),
      });
    }
    return names;
  } catch {
    return [];
  }
}

export const fetchApi: LauncherApi = {
  load: async (model) => {
    try {
      await post("/api/generate", { model });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  },
  chat: (request) => streamChat(request),
  parameters: async (model) => {
    try {
      const shown = await post("/api/show", { model });
      return parseParameters(String(shown.parameters ?? ""));
    } catch {
      return null;
    }
  },
};
