# Releasing

Versions are built ahead of time and released one at a time, roughly every
other day, by [`.github/workflows/release.yml`](../.github/workflows/release.yml).

## How it works

`.github/release-queue.txt` lists `<version> <commit>`, oldest first. The
workflow releases the **first entry that is not on npm yet**, so the queue
advances itself and is never written back to. It keys on the registry rather
than on tags because a version can be tagged and released on GitHub while its
npm publish is still pending; a tag-based check would skip it forever.

Each run: check the gap since the last tag, check out that commit, verify its
`package.json` version matches the queue, build, test, tag, publish to npm, and
create a GitHub release from the matching `CHANGELOG.md` section.

The cron is daily and the ~48h gap is enforced inside the job. GitHub's `*/2`
day-of-month skips awkwardly across month boundaries — the 31st is followed by
the 1st — and a daily run also catches up the morning after a missed one
instead of waiting another two days.

## One-time setup

Automated publishing needs an npm token that bypasses 2FA:

1. npmjs.com → **Access Tokens** → **Generate New Token** → **Automation**.
2. GitHub → repository **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**, named `NPM_TOKEN`.

Until that exists the workflow still tags and creates the GitHub release, and
leaves a notice on the run saying the publish was skipped. It never fails the
run over a missing secret, and it never re-publishes a version already on npm.

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
2. Append `X.Y.Z <commit>` to `.github/release-queue.txt`.

The workflow refuses to release a commit whose `package.json` version does not
match the queue, so a mismatch fails loudly rather than publishing the wrong
tree under the right tag.
