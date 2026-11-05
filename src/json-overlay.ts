import { existsSync, readFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function mergeSettings(base: JsonObject, overlay: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = merged[key];
    merged[key] =
      isJsonObject(baseValue) && isJsonObject(overlayValue)
        ? mergeSettings(baseValue, overlayValue)
        : overlayValue;
  }
  return merged;
}

export function withJsonOverlay(base: JsonObject, overlayPath: string): JsonObject {
  if (!existsSync(overlayPath)) return base;
  try {
    return mergeSettings(base, JSON.parse(readFileSync(overlayPath, "utf8")));
  } catch (error) {
    console.error(`claude-lite: ignoring invalid ${overlayPath}: ${(error as Error).message}`);
    return base;
  }
}
