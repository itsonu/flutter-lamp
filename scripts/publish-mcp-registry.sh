#!/usr/bin/env bash
#
# Publishes server.json for an already-published npm version to the MCP
# Registry, from GitHub Actions only (OIDC; no secret exists to use).
#
#   scripts/publish-mcp-registry.sh <version>
#
# Run from a checkout of that version's tree. Exit codes: 0 published,
# 2 nothing to publish (tree predates the registry metadata), 1 failed.
#
# npm is read-after-write eventually consistent, and the registry validates
# the package against npm, so a publish right after `npm publish` has to wait
# for the version to be visible. 0.21.0 showed the cost of guessing short:
# visible a few minutes after publish, not within the 50s the release job's
# own check allowed, so the registry step skipped it.

set -euo pipefail

VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "usage: scripts/publish-mcp-registry.sh <version>" >&2; exit 1; }

if [ ! -f server.json ] || [ "$(node -p "require('./package.json').mcpName ?? ''")" = "" ]; then
  echo "::notice::v$VERSION has no server.json or mcpName — nothing for the MCP Registry."
  exit 2
fi

# Up to ~5 minutes. The registry refuses a version npm cannot yet serve.
for attempt in $(seq 1 30); do
  npm view "flutter-lamp@$VERSION" version >/dev/null 2>&1 && break
  [ "$attempt" -lt 30 ] || { echo "::error::flutter-lamp@$VERSION is still not visible on npm after ~5 minutes."; exit 1; }
  sleep 10
done

mcp_name="$(npm view "flutter-lamp@$VERSION" mcpName 2>/dev/null || true)"
[ -n "$mcp_name" ] || { echo "::error::flutter-lamp@$VERSION on npm has no mcpName; the registry will refuse it."; exit 1; }

# server.json names the version it describes; stamp this one so the entry
# always matches the npm package it points at.
node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync("server.json", "utf8"));
  s.version = process.argv[1];
  for (const p of s.packages) p.version = process.argv[1];
  fs.writeFileSync("server.json", JSON.stringify(s, null, 2) + "\n");
' "$VERSION"

bin="$(mktemp -d)"
curl -fsSL "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_linux_amd64.tar.gz" \
  | tar xz -C "$bin" mcp-publisher

# The registry exchanges this workflow's GitHub token for the
# io.github.itsonu/* namespace. Same no-secret trust as npm.
"$bin/mcp-publisher" login github-oidc
"$bin/mcp-publisher" publish
echo "Published $mcp_name@$VERSION to the MCP Registry."
