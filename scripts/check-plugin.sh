#!/usr/bin/env bash
#
# Keeps the Claude plugin in plugin/ honest against the rest of the repo.
#
# The plugin cannot symlink or reach outside its own folder (the directory
# refuses both), so it carries a copy of the skill and pins an exact npm
# version. Both drift silently unless something checks them:
#
#   skill copy     plugin/skills/ matches .claude/skills/ byte for byte
#   pinned server  plugin/.mcp.json and plugin.json name the same version
#   published      that version is on npm; main runs ahead of npm (the
#                  release queue), so pinning package.json's version would
#                  hand plugin users a package that does not exist yet
#
#   scripts/check-plugin.sh

set -euo pipefail

fail() { echo "FAIL  $*" >&2; exit 1; }
ok()   { echo "ok    $*"; }

diff -r .claude/skills/flutter-runtime-diagnosis plugin/skills/flutter-runtime-diagnosis \
  || fail "plugin/skills/ differs from .claude/skills/ — copy the skill across"
ok "plugin skill matches .claude/skills"

pinned="$(node -p "require('./plugin/.mcp.json').mcpServers['flutter-lamp'].args.find(a => a.startsWith('flutter-lamp@'))?.slice('flutter-lamp@'.length) ?? ''")"
[[ "$pinned" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "plugin/.mcp.json must pin flutter-lamp@X.Y.Z, found '$pinned'"
ok "plugin/.mcp.json pins flutter-lamp@$pinned"

manifest="$(node -p "require('./plugin/.claude-plugin/plugin.json').version")"
[ "$manifest" = "$pinned" ] || fail "plugin.json says $manifest but .mcp.json pins $pinned"
ok "plugin.json version matches"

npm view "flutter-lamp@$pinned" version >/dev/null 2>&1 \
  || fail "flutter-lamp@$pinned is not on npm — pin a published version"
ok "flutter-lamp@$pinned is published"
