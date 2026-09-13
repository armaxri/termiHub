---
id: CI-009
title: No release version-drift gate; release-check.sh not wired into CI
angle: ci-cd
severity: high
category: packaging
is_workaround: false
subsystem: .github/workflows/release.yml
evidence:
  - .github/workflows/release.yml:24
  - .github/workflows/release.yml:463
status: open
---

## What
`release.yml` derives the version solely from the pushed git tag (`version=${GITHUB_REF#refs/tags/v}`,
`:24-26`) and trusts it verbatim for the whole build. Nothing verifies that the tag matches the
version declared in `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `package.json`, or the
workspace crates. The repo *has* a `scripts/release-check.sh` ("validate version consistency,
changelog, tests, git state, code markers" per CLAUDE.md) but it is **not referenced by any
workflow** (`grep -rl release-check .github/` → none). `verify-release` (`:463`) only checks that
the expected *filenames* exist, and those filenames are built from the tag-derived version, so a
drifted manifest version still yields a self-consistent (but wrong) asset set.

## Why it matters
Tagging `v0.2.0` while the manifests still say `0.1.0` produces installers whose in-app/reported
version disagrees with the release — the app's self-update version comparison, bug reports, and the
`--version` smoke all key off the wrong number. For a safety-critical app that ships a self-updater,
a version mismatch can cause the updater to mis-rank releases. This is a pure gate gap: the drift is
detectable and a script to detect it already exists, unused in CI.

## Evidence
`:24-26` tag → version; no cross-check against manifests. `release-check.sh` exists (referenced in
`.claude/CLAUDE.md` scripts table) but absent from `.github/`.

## Recommendation
Add a first job in `release.yml` (before `create-release`) that runs `release-check.sh` (or a focused
version-consistency check) and fails the release if the tag disagrees with any manifest version or if
the CHANGELOG lacks an entry for the tag. Making it the gating precondition turns the existing
manual checklist into an enforced release gate.
