#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
settings_source="$root/config/t3-code-27b.json"
config_dir="$HOME/.claude_local"
settings_target="$config_dir/settings.json"

mkdir -p "$config_dir"
if [[ -e "$settings_target" ]] && ! cmp -s "$settings_source" "$settings_target"; then
  echo "t3-code-setup: $settings_target already exists and differs from $settings_source; merge or remove it, then run this again" >&2
  exit 1
fi
cp "$settings_source" "$settings_target"

model="$(sed -n 's/.*"ANTHROPIC_DEFAULT_SONNET_MODEL": "\(.*\)".*/\1/p' "$settings_source")"

cat <<NEXT_STEPS
Wrote $settings_target

Next, in T3 Code (Settings > Providers):
1. Add provider > Claude. On the Config step set
     Binary path:            claude
     CLAUDE_CONFIG_DIR path: $config_dir
     Launch arguments:       --append-system-prompt-file $root/config/system-prompt.md
2. Run: cl serve 27b
3. Click Refresh provider status. The instance's Status row should show "Custom API endpoint".
4. On the instance's page, Models > Add custom model: $model
5. Start a new thread and pick that model.
NEXT_STEPS
