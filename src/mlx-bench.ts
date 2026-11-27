import {
  replyLines,
  type ChatMessage,
  type ChatRequest,
  type ChatReply,
  type ToolCall,
} from "./ollama/api.ts";

function openAiMessages(messages: ChatMessage[]) {
  const result: Record<string, unknown>[] = [];
  let pendingCalls: { id: string; name: string }[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "tool") {
      const index = message.tool_name
        ? pendingCalls.findIndex((call) => call.name === message.tool_name)
        : 0;
      const [call] = index < 0 ? [] : pendingCalls.splice(index, 1);
      if (!call) throw new Error("benchmark tool result has no preceding tool call");
      result.push({ role: "tool", tool_call_id: call.id, content: message.content });
      continue;
    }
    const content = message.images?.length
      ? [
          { type: "text", text: message.content },
          ...message.images.map((image) => ({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${image}` },
          })),
        ]
      : message.content;
    pendingCalls = [];
    const toolCalls = message.tool_calls?.map((call, n) => {
      const id = `call_${index}_${n}`;
      pendingCalls.push({ id, name: call.function.name });
      return {
        id,
        type: "function",
        function: {
          name: call.function.name,
          arguments: JSON.stringify(call.function.arguments),
        },
      };
    });
    result.push({
      role: message.role,
      content,
      ...(message.thinking && { reasoning_content: message.thinking }),
      ...(toolCalls?.length && { tool_calls: toolCalls }),
    });
  }
  return result;
}

type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_eval_duration?: number;
  generation_duration?: number;
  model_load_duration?: number;
};

export async function mlxBenchChat(url: string, request: ChatRequest): Promise<ChatReply> {
  const started = performance.now();
  const elapsed = () => (performance.now() - started) / 1000;
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    timeout: 30 * 60 * 1000,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: request.model,
      messages: openAiMessages(request.messages),
      tools: request.tools,
      max_tokens: request.options?.num_predict,
      stream: true,
      chat_template_kwargs: {
        enable_thinking: Boolean(request.think),
        ...(typeof request.think === "string" && { reasoning_effort: request.think }),
      },
      stream_options: { include_usage: true },
    }),
  });
  if (!response.ok) throw new Error(`oMLX HTTP ${response.status}: ${await response.text()}`);
  let content = "";
  let thinking = "";
  let firstToken: number | undefined;
  let usage: Usage = {};
  let finished = false;
  const calls = new Map<number, { name: string; arguments: string; lastPartSeconds: number }>();
  for await (const line of replyLines(response)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      finished = true;
      break;
    }
    const event = JSON.parse(data);
    if (event.error) throw new Error(event.error.message ?? String(event.error));
    if (event.usage) usage = event.usage;
    const choice = event.choices?.[0];
    const delta = choice?.delta;
    content += delta?.content ?? "";
    thinking += delta?.reasoning_content ?? "";
    for (const part of delta?.tool_calls ?? []) {
      const index = part.index ?? 0;
      const call = calls.get(index) ?? { name: "", arguments: "", lastPartSeconds: 0 };
      call.name += part.function?.name ?? "";
      call.arguments += part.function?.arguments ?? "";
      calls.set(index, call);
      if (part.function?.name || part.function?.arguments?.trim()) {
        call.lastPartSeconds = elapsed();
        firstToken ??= call.lastPartSeconds;
      }
    }
    if (delta?.content || delta?.reasoning_content) firstToken ??= elapsed();
  }
  if (!finished) throw new Error("oMLX chat stream ended before [DONE]");
  const toolCalls: ToolCall[] = [];
  let invalidCall: string | undefined;
  let completeTool: number | undefined;
  for (const call of calls.values()) {
    try {
      const args = JSON.parse(call.arguments || "{}");
      if (!call.name || !args || Array.isArray(args) || typeof args !== "object") throw new Error();
      toolCalls.push({ function: { name: call.name, arguments: args } });
      completeTool = Math.min(completeTool ?? Infinity, call.lastPartSeconds);
    } catch {
      invalidCall = "incomplete or invalid tool call";
    }
  }
  const cached = usage.prompt_tokens_details?.cached_tokens;
  const nanoseconds = (seconds?: number) => (seconds === undefined ? undefined : seconds * 1e9);
  return {
    message: {
      role: "assistant",
      content,
      ...(thinking && { thinking }),
      ...(toolCalls.length && { tool_calls: toolCalls }),
    },
    tool_call_error: invalidCall,
    first_token_seconds: firstToken,
    tool_call_seconds: invalidCall ? undefined : completeTool,
    cached_tokens: cached,
    prompt_eval_count:
      usage.prompt_tokens === undefined
        ? undefined
        : Math.max(0, usage.prompt_tokens - (cached ?? 0)),
    eval_count: usage.completion_tokens,
    eval_duration: nanoseconds(usage.generation_duration),
    prompt_eval_duration: nanoseconds(usage.prompt_eval_duration),
    load_duration: nanoseconds(usage.model_load_duration),
  };
}
