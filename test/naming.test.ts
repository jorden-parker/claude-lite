import { expect, test } from "bun:test";
import { newVagueNames } from "../src/hooks/naming.ts";

const declare = (keyword: string, name: string) => `${keyword} ${name} = 1;`;

test("reports new vague and too-short names", () => {
  const after = [declare("const", "tmp"), declare("let", "ab"), declare("const", "retryCount")];
  expect(newVagueNames("", after.join("\n"))).toEqual(["tmp", "ab"]);
});

test("allows loop indices and common short names", () => {
  const after = ["i", "j", "k", "e", "id", "db", "fs", "os"].map((name) => declare("let", name));
  expect(newVagueNames("", after.join("\n"))).toEqual([]);
});

test("keeps names that were already in the old text", () => {
  const before = declare("const", "data");
  expect(newVagueNames(before, `${before}\n${declare("const", "info")}`)).toEqual(["info"]);
});

test("reports vague names after every declaring keyword", () => {
  const pairs = [
    ["function", "handle"],
    ["class", "Manager"],
    ["type", "Util"],
    ["def", "process"],
  ];
  const after = pairs.map(([keyword, name]) => `${keyword} ${name}`).join("\n");
  expect(newVagueNames("", after)).toEqual(["handle", "Manager", "Util", "process"]);
});
