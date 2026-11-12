#!/usr/bin/env bash
set -euo pipefail

size="${1:-27b}"
runs="${2:-3}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CLAUDE_LITE_HOME="$root"
overlay="$root/config/local-sizes.json"

if [[ -x "$root/dist/claude-lite" ]]; then
  cli=("$root/dist/claude-lite")
else
  cli=(bun "$root/src/cli.ts")
fi

model="$(ROOT="$root" SIZE="$size" bun -e '
  const { loadSizes } = await import(`${process.env.ROOT}/src/ollama/sizes.ts`);
  console.log(loadSizes(process.env.ROOT)[process.env.SIZE]?.model ?? "");
')"
if [[ -z "$model" ]]; then
  echo "unknown size $size" >&2
  exit 1
fi
if ! ollama show "$model" >/dev/null 2>&1; then
  echo "$model is not in Ollama; run cl ollama $size once first" >&2
  exit 1
fi

tmp="$(mktemp -d)"
original="$tmp/original.json"
had_overlay=0
if [[ -f "$overlay" ]]; then
  cp "$overlay" "$original"
  had_overlay=1
else
  echo '{}' >"$original"
fi
restore() {
  if ((had_overlay)); then
    cp "$original" "$overlay"
  else
    rm -f "$overlay"
  fi
  rm -rf "$tmp"
}
trap restore EXIT
trap 'exit 130' INT TERM

overlay_for() {
  case "$1" in
    baseline) echo '{}' ;;
    temperature-0.4) echo "{\"$size\":{\"parameters\":{\"temperature\":0.4}}}" ;;
    context-32k) echo "{\"$size\":{\"context\":32768}}" ;;
  esac
}

for variant in baseline temperature-0.4 context-32k; do
  ROOT="$root" ORIGINAL="$original" OUT="$overlay" VARIANT_JSON="$(overlay_for "$variant")" bun -e '
    const { mergeSettings } = await import(`${process.env.ROOT}/src/json-overlay.ts`);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const merged = mergeSettings(
      JSON.parse(readFileSync(process.env.ORIGINAL, "utf8")),
      JSON.parse(process.env.VARIANT_JSON),
    );
    writeFileSync(process.env.OUT, JSON.stringify(merged, null, 2) + "\n");
  '
  echo "== $variant =="
  "${cli[@]}" bench "$size" --runs "$runs"
  ollama ps
done

echo "Keep a variant only if generation t/s rises and quality passed/total does not drop; for context-32k also set memory_gb from the ollama ps SIZE column."
