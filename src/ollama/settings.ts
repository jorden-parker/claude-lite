import type { Size } from "./sizes.ts";

export function renderSettings(base: Record<string, any>, hooks: unknown, size: Size) {
  const model = size.model;
  const { CLAUDE_CODE_EXTRA_BODY: _baseBody, ...baseEnv } = base.env ?? {};
  return {
    ...base,
    model,
    availableModels: [model],
    ...(size.effort && { effortLevel: size.effort }),
    env: {
      ...baseEnv,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(size.context),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(size.output_tokens),
      ...(!size.thinking && {
        CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ thinking: { type: "disabled" } }),
      }),
    },
    permissions: {
      ...base.permissions,
      deny: [...new Set([...(base.permissions?.deny ?? []), "Agent"])],
    },
    hooks,
  };
}
