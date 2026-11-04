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

export function commentsIn(text: string, language: string): string[] {
  return text
    .split("\n")
    .map((line) => lineComment(line, MARKERS[language]))
    .filter((c): c is string => !!c && !ALLOWED.some((a) => c.startsWith(a)));
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
