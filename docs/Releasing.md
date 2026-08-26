# Releasing

Versions are built ahead of time and released one at a time, roughly every
other day, by [`.github/workflows/release.yml`](../.github/workflows/release.yml).

## How it works

`.github/release-queue.txt` lists `<version> <commit>`, oldest first. The
workflow releases the **first entry that is not on npm yet**, so the queue
advances itself and is never written back to. It keys on the registry rather
than on tags because a version can be tagged and released on GitHub while its
npm publish is still pending; a tag-based check would skip it forever.

Each run: check the gap since the last tag, check out that commit, run
`scripts/verify-release.sh`, tag, publish to npm, confirm the version landed,
and create a GitHub release from the matching `CHANGELOG.md` section.

## The verification chain

A published tarball has to be traceable to a reviewed commit, so every link
between the two is checked and any disagreement is fatal:

```
release queue entry
  -> expected commit SHA   full 40 hex chars, never an abbreviation or a ref
  -> checked-out HEAD      asserted equal to it after the detached checkout
  -> package version       package.json, package-lock.json and src/version.ts
  -> changelog section     a non-empty "## [X.Y.Z]" exists
  -> release tag           absent, or already pointing at this exact commit
  -> npm                   not already published
  -> tarball               built from this tree, carrying nothing extra
```

`scripts/verify-release.sh <version> <full-sha>` is that chain, as one command.
It publishes nothing and writes nothing outside a temporary directory, so it is
safe to run at any time:

```bash
npm run verify-release -- 0.18.0 $(git rev-parse HEAD)
```

Run it from a checkout of the commit being released. The workflow runs the same
script, which is why the queue must name a full SHA: an abbreviation can become
ambiguous as the repo grows, and a branch or tag name is mutable, so "release
the queued commit" would quietly become "release whatever that ref points at
this morning".

Two links deserve their own note. A **tag that already exists but points
somewhere else** is refused rather than reused: reusing it would publish a
tarball built from one tree under a tag naming another, and a tag is the one
artifact here that outlives a bad run. A tag already pointing at the release
commit is fine, so re-running after a partial failure works. And **npm is
re-read after publishing** — previously nothing confirmed the version actually
landed, so a run could go green having published nothing at all.

The cron is daily and the ~48h gap is enforced inside the job. GitHub's `*/2`
day-of-month skips awkwardly across month boundaries — the 31st is followed by
the 1st — and a daily run also catches up the morning after a missed one
instead of waiting another two days.

## One-time setup

Publishing uses **trusted publishing**: the npm CLI exchanges a GitHub Actions
OIDC token for a short-lived credential. No npm token is created, stored or
rotated, and there is no repository secret to leak. Interactive 2FA is not
involved, because no long-lived credential is.

On npmjs.com, open the **flutter-lamp** package → **Settings** →
**Trusted Publisher** → **GitHub Actions**:

| Field | Value |
| --- | --- |
| Organization or user | `itsonu` |
| Repository | `flutter-lamp` |
| Workflow filename | `release.yml` |
| Allowed actions | npm publish |

The workflow filename must match exactly — npm checks it as part of verifying
the OIDC claim, so renaming the workflow breaks publishing until the setting is
updated too.

This has to be done by whoever owns the npm package, because it is an
authenticated change to that account. It is the only step in the whole pipeline
that is not automated.

Requirements the workflow already satisfies: `id-token: write` permission, and
npm ≥ 11.5.1 (it upgrades npm before publishing, since Node 22 ships an older
one).

### Fallback: NPM_TOKEN

If trusted publishing is not an option, an **automation** token (npmjs.com →
Access Tokens → Automation) stored as the `NPM_TOKEN` repository secret also
works. The workflow prefers it when present. Trusted publishing is better:
nothing long-lived exists to be stolen.

Until either is configured the workflow still tags and creates the GitHub
release, and leaves the setup instructions in the run summary. It never fails
the run over the missing configuration, and never re-publishes a version
already on npm.

## Manual control

Run **Actions → Release → Run workflow**:

| Input | Effect |
| --- | --- |
| *(none)* | Release the next queue entry, if the gap has passed |
| `version` | Release that specific queued version now, ignoring the gap |
| `ignore_gap` | Release the next entry now, ignoring the gap |

To pause: comment out the remaining queue lines, or disable the workflow in the
Actions tab. To reorder or drop a version: edit the queue. Nothing else reads it.

## Releasing by hand

If you would rather not use the automation:

```bash
git tag -a vX.Y.Z <commit> -m "Flutter Lamp vX.Y.Z"
git push origin vX.Y.Z
```

```bash
npm publish --otp=123456
```

`prepublishOnly` rebuilds before publishing. Run this from a checkout of the
commit being released, not from `main`, or you will ship the wrong tree.

## Adding a new version to the queue

1. Land the work with a version bump in `package.json`, `package-lock.json` and
   `src/version.ts`, plus a `CHANGELOG.md` entry under `## [X.Y.Z]`.
2. Append `X.Y.Z <full-40-char-sha>` to `.github/release-queue.txt`, in a
   separate commit — the release commit is written first, so it cannot contain
   the entry that names it. The workflow reads the queue from the branch before
   checking out the release commit, for exactly this reason.
3. Verify it: `npm run verify-release -- X.Y.Z <sha>` from that commit.

Every check above fails loudly rather than publishing the wrong tree under the
right tag.
