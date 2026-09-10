---
id: CI-021
title: dev-build publishes a release even when build jobs fail
angle: ci-cd
severity: low
category: reliability
is_workaround: false
subsystem: .github/workflows/dev-build.yml
evidence:
  - .github/workflows/dev-build.yml:381
  - .github/workflows/dev-build.yml:258
status: open
---

## What
`dev-build.yml`'s `publish-release` job runs with
`if: ${{ !cancelled() && needs.prepare-release.result == 'success' }}` (`:381`) — deliberately "even
if some build jobs failed so the release is always updated." It downloads whatever staged artifacts
exist and republishes the `dev-*-latest` prerelease. If, say, the Windows or macOS build failed,
the dev release is silently refreshed with the remaining platforms' artifacts (minus the failed
one). Individual upload steps use `if-no-files-found: error` (`:258`), but a *whole failed build job*
simply contributes no artifact.

## Why it matters
Low severity because these are explicitly-labelled "not for production" dev builds. But the behaviour
means a dev release can quietly regress from N platforms to N−1 with no visible signal on the release
itself — a contributor testing "the latest develop dev build" on the missing platform gets a stale or
absent artifact and may not realise the build failed. It normalises partial-publish, the same pattern
that is a real problem for `release.yml` (CI-007).

## Evidence
`:376-381` — `publish-release` needs the build jobs but runs on their failure via `!cancelled()`;
no per-platform completeness assertion before republishing.

## Recommendation
Either fail (don't republish) when a build job failed, or write the missing-platform set into the
release notes so the partial state is visible. At minimum surface a warning/annotation listing which
platforms are stale so the dev release's completeness is not silently degraded.
