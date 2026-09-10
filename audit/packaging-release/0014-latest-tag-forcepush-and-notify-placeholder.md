---
id: PKG-014
title: Release force-pushes a moving `latest` git tag (incl. prereleases) and the notify job is an unwired placeholder
angle: packaging-release
severity: low
category: tooling
is_workaround: false
subsystem: .github/workflows/release.yml
evidence:
  - .github/workflows/release.yml:550
  - .github/workflows/release.yml:567
status: open
---

## What
Two minor release-pipeline observations:
1. **Moving `latest` tag:** `update-latest` runs `git tag -f latest && git push origin
   latest --force` on every release. Since the release is marked `--prerelease` and the
   only releases so far are betas, a mutable `latest` git tag is force-pushed for
   prerelease builds. A force-moved tag can confuse anyone (or any tooling) that
   pinned to `latest`, and it is redundant with GitHub's own "Latest release" pointer
   (which excludes prereleases by default — so the git `latest` tag and GitHub's
   "Latest" badge can disagree).
2. **Notify placeholder:** the `notify` job only `echo`s a success line; the Discord/
   Slack webhook is commented out. It runs `if: success()` but depends only on the
   build/verify jobs, so it is effectively a no-op step kept for future wiring.

## Why it matters
Neither blocks a release. The `latest` tag force-push is a small footgun (mutable tag
semantics, potential disagreement with GitHub's latest-release pointer for
prereleases); the notify job is dead scaffolding. Flagged for cleanup so the pipeline
reads as intentional.

## Evidence
- `release.yml:550-564` — `update-latest` force-pushes the `latest` tag unconditionally
  after every tagged release.
- `release.yml:567-580` — `notify` job is an echo with a commented-out webhook.

## Recommendation
Decide whether a mutable `latest` git tag is actually wanted; if the intent is "point
users at the newest download", rely on GitHub's release "Latest" pointer or a stable
download URL rather than a force-moved git tag — and if kept, skip it for prereleases so
git `latest` and GitHub's badge stay consistent. Either wire the notify webhook to a
real secret or remove the job.
