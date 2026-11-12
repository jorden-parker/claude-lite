import { deny, type HookEvent, type HookResult } from "./types.ts";

const COMMAND_PREFIX = String.raw`(?:(?:\w+=\S*|env|command)\s+)*`;
export const COMMAND_START = String.raw`(?:^|[;&|(\n\`]\s*)${COMMAND_PREFIX}`;
const SEGMENT_BODY = String.raw`[^;&|)\n\`]*`;
const BOUNDED_FILTER = String.raw`\|\s*(?:head|tail|wc|grep|sed\s+-n)\b`;
const NOT_BOUNDED = `(?!${SEGMENT_BODY}${BOUNDED_FILTER})`;
export const GIT_OPTIONS = String.raw`(?:(?:--no-pager|--paginate|-p|-P|-c\s+\S+|-C\s+\S+|--git-dir=\S+|--work-tree=\S+)\s+)*`;
const QUOTED_TEXT = /'[^']*'|"(?:[^"\\$`]|\\.)*"/g;
const QUOTED_SEPARATOR = /[;&|()\n`]/;
const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "bun.lock",
];

const unbounded = (command: string, boundingFlags: string[]) =>
  new RegExp(
    `${COMMAND_START}${command}\\b(?!${SEGMENT_BODY}(?:${boundingFlags.join("|")}))${SEGMENT_BODY}${NOT_BOUNDED}`,
  );

const RULES: [RegExp, string][] = [
  [
    unbounded(`git\\s+${GIT_OPTIONS}log`, [
      String.raw`\s-n\s*\d`,
      String.raw`\s-\d+`,
      "--max-count",
    ]),
    "Unbounded git log. Use: git log --oneline -n 20",
  ],
  [
    unbounded(`git\\s+${GIT_OPTIONS}diff`, [
      String.raw`--stat`,
      String.raw`--name-only`,
      String.raw`--shortstat`,
    ]),
    "Unbounded git diff. Use --stat or --name-only first, or add | head -50",
  ],
  [unbounded("find", [String.raw`-maxdepth`]), "Unbounded find. Add -maxdepth N or | head -50."],
  [
    new RegExp(
      `${COMMAND_START}(?:cat|less|more|bat)\\s${SEGMENT_BODY}\\b(?:${LOCKFILES.map((n) => n.replace(/\./g, "\\.")).join("|")})\\b${NOT_BOUNDED}`,
    ),
    "Lockfiles are huge. Grep for the package you need instead.",
  ],
];

const withoutQuotedText = (command: string) =>
  command.replace(QUOTED_TEXT, (match) => (QUOTED_SEPARATOR.test(match) ? "''" : match));

export function decide(event: HookEvent): HookResult {
  const command = event.tool_input?.command ?? "";
  const stripped = withoutQuotedText(command);
  const rule = RULES.find(([pattern]) => pattern.test(stripped));
  return rule ? deny(rule[1]) : null;
}
