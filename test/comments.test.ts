import { expect, test } from "bun:test";
import { newComments } from "../src/hooks/comments.ts";

test("reports a python docstring after a def line", () => {
  const after = 'def explain():\n    """Explain."""\n    return 1\n';
  expect(newComments("", after, "python")).toEqual(['"""Explain."""']);
});

test("reports only the opening line of a multi-line docstring", () => {
  const after = "class Explainer:\n\n    '''Explain.\n    More.\n    '''\n";
  expect(newComments("", after, "python")).toEqual(["'''Explain."]);
});

test("a string on its own line elsewhere is not a docstring", () => {
  const after = 'explanation = join(\n    """text""",\n)\n';
  expect(newComments("", after, "python")).toEqual([]);
});

test("reports new body lines of an existing block comment", () => {
  const before = "/**\n * kept\n */\nconst total = 1;\n";
  const after = "/**\n * kept\n * added\n */\nconst total = 1;\n";
  expect(newComments(before, after, "js")).toEqual(["* added"]);
});

test("a block comment closed on its own line does not swallow the code after it", () => {
  const after = "/* note */\nconst total = 1;\n";
  expect(newComments("", after, "js")).toEqual(["/* note */"]);
});
