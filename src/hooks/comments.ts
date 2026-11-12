const MARKERS: Record<string, string[]> = {
  go: ["//", "/*"],
  js: ["//", "/*"],
  python: ["#"],
  shell: ["#"],
};
const ALLOWED = ["#!", "//go:", "/// <reference"];
const QUOTES = "'\"`";

export const EXTENSION_LANGUAGES: Record<string, string> = {
  ".go": "go",
  ".ts": "js",
  ".tsx": "js",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".mts": "js",
  ".cts": "js",
  ".py": "python",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
};

function lineComment(line: string, markers: string[]): string | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\\") i++;
    else if (quote) quote = char === quote ? null : quote;
    else if (QUOTES.includes(char)) quote = char;
    else if ((i === 0 || /\s/.test(line[i - 1])) && markers.some((m) => line.startsWith(m, i)))
      return line.slice(i).trim();
  }
  return null;
}

const DEFINITION = /^\s*(?:async\s+)?(?:def|class)\s.*:\s*$/;
const DOCSTRING_START = /^[rRbBuUfF]{0,2}(?:"""|''')/;

function blockCommentLines(lines: string[], markers: string[]): string[] {
  const found: string[] = [];
  let isInsideBlock = false;
  for (const line of lines) {
    const comment: string | null = isInsideBlock ? line.trim() : lineComment(line, markers);
    if (comment) found.push(comment);
    if (isInsideBlock) isInsideBlock = !line.includes("*/");
    else isInsideBlock = !!comment && comment.startsWith("/*") && !comment.includes("*/");
  }
  return found;
}

function docstringLines(lines: string[]): string[] {
  const found: string[] = [];
  let isAfterDefinition = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (isAfterDefinition && DOCSTRING_START.test(trimmed)) found.push(trimmed);
    if (trimmed) isAfterDefinition = DEFINITION.test(line);
  }
  return found;
}

function commentsIn(text: string, language: string): string[] {
  const lines = text.split("\n");
  const docstrings = language === "python" ? docstringLines(lines) : [];
  return [...blockCommentLines(lines, MARKERS[language]), ...docstrings].filter(
    (comment) => !ALLOWED.some((allowed) => comment.startsWith(allowed)),
  );
}

export function newComments(before: string, after: string, language: string): string[] {
  const remaining = commentsIn(before, language);
  return commentsIn(after, language).filter((comment) => {
    const at = remaining.indexOf(comment);
    if (at < 0) return true;
    remaining.splice(at, 1);
    return false;
  });
}
