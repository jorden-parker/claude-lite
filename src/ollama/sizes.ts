import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { withJsonOverlay } from "../json-overlay.ts";
import { isRemoteHost } from "./api.ts";
import { applyEnv, applyFlags } from "./size-overrides.ts";

export type Size = {
  base: string;
  model: string;
  context: number;
  output_tokens: number;
  parameters: Record<string, number>;
  thinking: boolean;
  effort?: string;
  default?: boolean;
  memory_gb?: number;
  mlx?: string;
  qwen?: boolean;
  opencode?: boolean;
};

export const PREFERRED_SIZE = "35b";

const GIB = 1024 ** 3;
const METAL_BUDGET_FRACTION = 0.7;

export function loadSizes(home: string): Record<string, Size> {
  const sizes = JSON.parse(readFileSync(join(home, "config", "sizes.json"), "utf8"));
  return withJsonOverlay(sizes, join(home, "config", "local-sizes.json")) as Record<string, Size>;
}

function pickSize(sizes: Record<string, Size>, name: string): Size {
  const size = sizes[name];
  if (!size)
    throw new Error(`unknown size ${name}; choose one of ${Object.keys(sizes).join(", ")}`);
  return size;
}

function readWiredLimitMb(): number {
  if (process.platform !== "darwin") return 0;
  try {
    const output = execFileSync("sysctl", ["-n", "iogpu.wired_limit_mb"], { encoding: "utf8" });
    return Number.parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

export const memoryBudgetGb = (memoryBytes: number, wiredLimitMb = readWiredLimitMb()) =>
  wiredLimitMb > 0 ? wiredLimitMb / 1024 : (memoryBytes / GIB) * METAL_BUDGET_FRACTION;

const fits = (size: Size, budgetGb: number) =>
  size.memory_gb === undefined || size.memory_gb <= budgetGb;

export function fittingSizes(
  sizes: Record<string, Size>,
  memoryBytes: number,
  wiredLimitMb = readWiredLimitMb(),
): string[] {
  const budget = memoryBudgetGb(memoryBytes, wiredLimitMb);
  return Object.keys(sizes).filter((name) => fits(sizes[name], budget));
}

export function defaultSize(
  sizes: Record<string, Size>,
  memoryBytes = totalmem(),
  wiredLimitMb = readWiredLimitMb(),
): string {
  const marked = Object.keys(sizes).find((name) => sizes[name].default === true);
  if (marked) return marked;
  const fitting = fittingSizes(sizes, memoryBytes, wiredLimitMb);
  if (fitting.includes(PREFERRED_SIZE)) return PREFERRED_SIZE;
  const largest = fitting
    .filter((name) => sizes[name].memory_gb !== undefined)
    .sort((first, second) => sizes[second].memory_gb! - sizes[first].memory_gb!)[0];
  return largest ?? fitting[0] ?? PREFERRED_SIZE;
}

type ResolvedSize = { name: string; size: Size; claudeArgs: string[] };

export function resolveSize(
  home: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  memoryBytes = totalmem(),
  wiredLimitMb = readWiredLimitMb(),
): ResolvedSize {
  const sizes = loadSizes(home);
  const [first, ...rest] = args;
  const isSize = first !== undefined && Object.hasOwn(sizes, first);
  const isRemote = isRemoteHost(env);
  const memoryLimit = isRemote ? Number.POSITIVE_INFINITY : memoryBytes;
  const wiredLimit = isRemote ? 0 : wiredLimitMb;
  const name = isSize ? first : defaultSize(sizes, memoryLimit, wiredLimit);
  const { size, claudeArgs } = applyFlags(
    applyEnv(pickSize(sizes, name), env),
    isSize ? rest : args,
  );
  return { name, size, claudeArgs };
}
