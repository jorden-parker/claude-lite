const GIT_OPTIONS = String.raw`(?:(?:--no-pager|--paginate|-p|-P|-c\s+\S+|-C\s+\S+|--git-dir=\S+|--work-tree=\S+)\s+)*`;
const COMMAND_START = String.raw`(?:^|[;&|(\n\`]\s*)`;
const SEGMENT = String.raw`[^;&|)\n\`]*`;
const BOUNDING_ARGUMENTS = String.raw`\s-n\s*\d|\s-\d+|--max-count`;
const BOUNDED_PIPE = String.raw`\|\s*(?:head|tail|wc|grep|sed\s+-n)\b`;

const UNBOUNDED_GIT_LOG = new RegExp(
  `${COMMAND_START}git\\s+${GIT_OPTIONS}log\\b(?!${SEGMENT}(?:${BOUNDING_ARGUMENTS}))(?!${SEGMENT}${BOUNDED_PIPE})`,
);
const DENIAL_REASON = "Unbounded git log. Use: git log --oneline -n 20";

export function unboundedGitLogReason(command: string): string | null {
  return UNBOUNDED_GIT_LOG.test(command) ? DENIAL_REASON : null;
}
