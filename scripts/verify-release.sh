#!/usr/bin/env bash
#
# Answers one question: is this exact commit safe to publish as this version?
#
# The release pipeline's job is to make a published tarball traceable to a
# reviewed commit. Every link in that chain has to be checked, because a chain
# is only as strong as the link nobody verified:
#
#   release queue entry
#     -> expected commit SHA   (queue declares it, in full, unambiguously)
#     -> checked-out HEAD      (we are actually standing on that commit)
#     -> package version       (three files agree on it)
#     -> changelog section     (the release has notes to publish)
#     -> release tag           (absent, or already pointing at this commit)
#     -> npm                   (not already published)
#     -> tarball contents      (built from this tree, carrying nothing extra)
#
# Any disagreement is fatal. This never publishes and never mutates anything
# outside a temporary directory.
#
#   scripts/verify-release.sh 0.18.0 <full-40-char-sha>
#
# The workflow calls this before it tags. Run it by hand before dispatching a
# release, from a checkout of the commit being released.

set -euo pipefail

VERSION="${1:-}"
EXPECTED_SHA="${2:-}"
# The queue is authoritative on the branch, not in the released tree: the
# commit being released is written before the queue entry that names it, so a
# detached checkout of it does not contain its own entry. The workflow reads
# the queue first and passes that copy through.
QUEUE="${RELEASE_QUEUE:-.github/release-queue.txt}"
PACKAGE="flutter-lamp"

if [ -z "$VERSION" ] || [ -z "$EXPECTED_SHA" ]; then
  echo "usage: scripts/verify-release.sh <version> <full-commit-sha>" >&2
  exit 2
fi

fail() { echo "FAIL  $*" >&2; exit 1; }
ok()   { echo "ok    $*"; }

echo "Verifying $PACKAGE@$VERSION at $EXPECTED_SHA"
echo

# ── 1. The queue declares this commit, unambiguously ────────────────────────
#
# A 40-character hex SHA and nothing else. An abbreviation can become ambiguous
# as the repo grows, and a branch or tag name is worse than ambiguous: it is
# mutable, so "release the queued commit" would silently mean "release whatever
# that ref points at today".
[ -f "$QUEUE" ] || fail "no $QUEUE"

queued="$(awk -v v="$VERSION" '$1 == v { print $2 }' "$QUEUE" | head -1)"
[ -n "$queued" ] || fail "$VERSION is not in $QUEUE"

case "$queued" in
  *[!0-9a-f]* | "") fail "queue entry for $VERSION is '$queued', not a hex SHA" ;;
esac
[ "${#queued}" -eq 40 ] || fail "queue entry for $VERSION is ${#queued} chars; a full 40-char SHA is required"
[ "$queued" = "$EXPECTED_SHA" ] || fail "queue says $queued, caller expected $EXPECTED_SHA"
ok "queue declares $VERSION at $queued"

# Exactly one entry per version, or "the queued commit" is not well defined.
count="$(awk -v v="$VERSION" '$1 == v' "$QUEUE" | wc -l | tr -d ' ')"
[ "$count" -eq 1 ] || fail "$QUEUE has $count entries for $VERSION"
ok "exactly one queue entry for $VERSION"

# ── 2. We are standing on that commit ───────────────────────────────────────
head_sha="$(git rev-parse HEAD)"
[ "$head_sha" = "$EXPECTED_SHA" ] || fail "HEAD is $head_sha, expected $EXPECTED_SHA"
ok "HEAD is the expected commit"

# A dirty tree means the tarball would not match the commit it claims to be.
dirty="$(git status --porcelain)"
[ -z "$dirty" ] || fail "working tree is dirty; the tarball would not match $EXPECTED_SHA"$'\n'"$dirty"
ok "working tree clean"

# ── 3. Every version declaration agrees ─────────────────────────────────────
#
# Three files carry the version. src/version.ts is the one the running server
# reports over MCP, so a drift there ships a server that lies about itself.
pkg_version="$(node -p "require('./package.json').version")"
[ "$pkg_version" = "$VERSION" ] || fail "package.json says $pkg_version, expected $VERSION"
ok "package.json version"

lock_version="$(node -p "require('./package-lock.json').version")"
[ "$lock_version" = "$VERSION" ] || fail "package-lock.json says $lock_version, expected $VERSION"
ok "package-lock.json version"

src_version="$(node -p "const s=require('fs').readFileSync('src/version.ts','utf8');
  const m=s.match(/VERSION\s*=\s*[\"']([^\"']+)[\"']/); m ? m[1] : ''")"
[ "$src_version" = "$VERSION" ] || fail "src/version.ts says '$src_version', expected $VERSION"
ok "src/version.ts version"

# ── 4. The release has notes ────────────────────────────────────────────────
#
# Same literal matching the workflow uses: "## [0.18.0]" as a regex would be
# read as a character class and match nothing.
notes="$(awk -v tag="## [$VERSION]" '
  index($0, tag) == 1 { found = 1; next }
  found && index($0, "## [") == 1 { exit }
  found { print }
' CHANGELOG.md)"
[ -n "$(echo "$notes" | tr -d '[:space:]')" ] || fail "CHANGELOG.md has no non-empty '## [$VERSION]' section"
ok "changelog section present ($(echo "$notes" | wc -l | tr -d ' ') lines)"

# ── 5. The tag is free, or already correct ──────────────────────────────────
#
# The dangerous case is a tag that exists and points somewhere else: the
# published tarball would then be built from one tree and tagged as another.
# Re-running after a partial failure is fine, because the tag already points
# here.
check_tag() {
  local where="$1" sha="$2"
  [ -n "$sha" ] || { ok "no $where tag v$VERSION"; return; }
  [ "$sha" = "$EXPECTED_SHA" ] \
    || fail "$where tag v$VERSION points at $sha, not $EXPECTED_SHA"
  ok "$where tag v$VERSION already points here (re-run is safe)"
}

local_tag="$(git rev-list -n 1 "refs/tags/v$VERSION" 2>/dev/null || true)"
check_tag "local" "$local_tag"

remote_ls="$(git ls-remote --tags origin "refs/tags/v$VERSION*" 2>/dev/null)" \
  || fail "could not reach origin to check for an existing tag"
# Annotated tags list both the tag object and its ^{} dereference; the
# dereference is the commit. Fall back to the plain ref for a lightweight tag.
remote_tag="$(echo "$remote_ls" | awk '$2 == "refs/tags/v'"$VERSION"'^{}" { print $1 }')"
[ -n "$remote_tag" ] && : || \
  remote_tag="$(echo "$remote_ls" | awk '$2 == "refs/tags/v'"$VERSION"'" { print $1 }')"
check_tag "remote" "$remote_tag"

# ── 6. npm does not already have it ─────────────────────────────────────────
if npm view "$PACKAGE@$VERSION" version >/dev/null 2>&1; then
  fail "$PACKAGE@$VERSION is already published; a version on npm is immutable"
fi
ok "$PACKAGE@$VERSION is not on npm"

registry="$(node -p "require('./package.json').publishConfig?.registry ?? 'https://registry.npmjs.org/ (npm default)'")"
access="$(node -p "require('./package.json').publishConfig?.access ?? 'default'")"
ok "publish target: $registry, access $access"

# ── 7. It builds, and it passes ─────────────────────────────────────────────
#
# Build before packing, deliberately. `npm pack` runs `prepack`, not
# `prepublishOnly`, so packing a stale dist/ would inspect an artifact the
# real publish then rebuilds underneath us. Building first makes the tarball
# inspected below the same one `prepublishOnly` will reproduce.
npm run build >/dev/null
ok "build"

test_out="$(npm test 2>&1)"
passed="$(echo "$test_out" | awk '/^# pass /{print $3}')"
failed="$(echo "$test_out" | awk '/^# fail /{print $3}')"
[ "${failed:-1}" = "0" ] || { echo "$test_out" | tail -30 >&2; fail "$failed test(s) failed"; }
ok "tests: $passed passed, 0 failed"

# ── 8. The tarball carries what it should, and nothing else ─────────────────
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

tarball="$(npm pack --pack-destination "$tmp" --silent | tail -1)"
[ -f "$tmp/$tarball" ] || fail "npm pack produced no tarball"
[ "$tarball" = "$PACKAGE-$VERSION.tgz" ] || fail "packed $tarball, expected $PACKAGE-$VERSION.tgz"

listing="$(tar -tzf "$tmp/$tarball")"
files="$(echo "$listing" | grep -c . )"
size="$(wc -c < "$tmp/$tarball" | tr -d ' ')"

# Anything here is either private, useless to a consumer, or both.
forbidden='probe/|\.apk$|\.test\.|\.map$|^package/\.github/|^package/\.env|node_modules/|EVIDENCE\.md|\.claude/worktrees'
if echo "$listing" | grep -qE "$forbidden"; then
  echo "$listing" | grep -E "$forbidden" >&2
  fail "tarball contains files that must not ship"
fi
ok "tarball clean: $files files, $((size / 1024)) kB"

# The entrypoint the `bin` field promises has to actually be in there.
bin_path="$(node -p "require('./package.json').bin['$PACKAGE']")"
echo "$listing" | grep -qx "package/$bin_path" || fail "tarball is missing $bin_path, the declared bin"
ok "declared bin present: $bin_path"

# And the version inside the tarball, not just the one on disk. Piped rather
# than extracted to a path: under Git Bash `mktemp -d` yields a POSIX path that
# a Windows node cannot resolve, and this script has to run in both places.
packed_version="$(tar -xzOf "$tmp/$tarball" package/package.json   | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).version))")"
[ "$packed_version" = "$VERSION" ] || fail "tarball declares $packed_version, expected $VERSION"
ok "tarball declares $VERSION"

echo
echo "PASS  $PACKAGE@$VERSION at $EXPECTED_SHA is safe to publish."
echo "      expected tag: v$VERSION"
