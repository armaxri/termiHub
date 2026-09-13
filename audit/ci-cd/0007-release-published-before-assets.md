---
id: CI-007
title: Release is published to the public before its assets are built
angle: ci-cd
severity: high
category: packaging
is_workaround: false
subsystem: .github/workflows/release.yml
evidence:
  - .github/workflows/release.yml:84
  - .github/workflows/release.yml:93
  - .github/workflows/release.yml:463
status: open
---

## What
`release.yml` runs `create-release` first, which calls `gh release create … --prerelease`
(`:84-89`) to publish a **non-draft** GitHub Release immediately. Only afterward do `build-and-upload`
and the three `agent-binaries-*` jobs (each `needs: create-release`) compile and upload the
installers and agent binaries — a process of many minutes across five platforms. The `verify-release`
gate that checks the full asset set (`:463`) runs *last*.

## Why it matters
For the entire build window the release is publicly visible on the Releases page and served by the
desktop self-update check with **zero or partial assets**. A user (or the app's updater) hitting it
mid-build downloads nothing or an incomplete set. If any build leg fails, the public release is left
permanently incomplete until someone intervenes — `verify-release` fails the *run* but does not
unpublish or draft the already-public release. `--prerelease` mitigates discoverability but does not
make the release private. Releases should be atomic: fully built and verified, then revealed.

## Evidence
`create-release` (`:12-91`) publishes before any build job; `build-and-upload`/`agent-binaries-*`
depend on it (`:96`, `:317`, `:377`, `:421`); `verify-release` depends on all of them (`:463-473`)
and only errors after the fact.

## Recommendation
Create the release as a **draft** (`gh release create --draft`), upload all assets, run
`verify-release`, and only then flip it to published (`gh release edit --draft=false`). That makes
publication contingent on a verified, complete asset set and removes the incomplete-release window
the self-updater can observe.
