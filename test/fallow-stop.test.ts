import { expect, test } from "bun:test";
import { decideFallowStop } from "../src/hooks/fallow-stop.ts";

type Reply = { ok: boolean; output: string; status?: number } | null;

const stub = (gitStatus: string, audit: Reply) => (command: string[]) => {
  if (command[1] === "status") return { ok: true, output: gitStatus };
  if (command[1] === "rev-parse") return { ok: true, output: "" };
  return audit;
};
const event = { hook_event_name: "Stop", cwd: "/repo" };
const found = (count: number): Reply => ({
  ok: false,
  status: 1,
  output: Array.from({ length: count }, (_, i) => `unused-export:a.ts:${i}:x`).join("\n"),
});
const fallow = () => "fallow";

test("ignores changes without script files", () =>
  expect(decideFallowStop(event, stub(" M README.md\n", found(1)), fallow)).toBeNull());

test("passes when fallow is missing", () =>
  expect(decideFallowStop(event, stub(" M a.ts\n", found(1)), () => null)).toBeNull());

test("passes when the audit passes", () =>
  expect(
    decideFallowStop(event, stub(" M a.ts\n", { ok: true, status: 0, output: "" }), fallow),
  ).toBeNull());

test("passes when fallow errors", () =>
  expect(
    decideFallowStop(event, stub(" M a.ts\n", { ok: false, status: 2, output: "boom" }), fallow),
  ).toBeNull());

test("passes while retrying after a block", () =>
  expect(
    decideFallowStop({ ...event, stop_hook_active: true }, stub(" M a.ts\n", found(1)), fallow),
  ).toBeNull());

test("blocks with findings capped at 15 lines plus a hint", () => {
  const result = decideFallowStop(event, stub("?? a.ts\n", found(20)), fallow);
  const lines = result?.stderr?.split("\n") ?? [];
  expect(result?.exitCode).toBe(2);
  expect(lines).toHaveLength(17);
  expect(lines[15]).toBe("[5 more]");
  expect(lines[16]).toContain("fallow explain");
});

test("lists untracked files individually so new folders are seen", () => {
  const seen: string[][] = [];
  decideFallowStop(
    event,
    (command) => {
      seen.push(command);
      return { ok: true, output: "" };
    },
    fallow,
  );
  expect(seen[0]).toContain("--untracked-files=all");
});
