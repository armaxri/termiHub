---
id: PKG-007
title: Release pipeline never validates version/tag consistency; release-check.sh (the drift gate) is manual-only
angle: packaging-release
severity: medium
category: tooling
is_workaround: false
subsystem: .github/workflows/release.yml
evidence:
  - .github/workflows/release.yml:24
  - scripts/release-check.sh:16
  - scripts/internal/check-tauri-version-drift.mjs
status: open
---

## What
The version baked into the shipped bundle comes from `src-tauri/tauri.conf.json`
(`"version": "0.1.0"`), but the release is triggered by, and its artifacts named
after, the **git tag** (`release.yml` derives `version` from `${GITHUB_REF#refs/tags/v}`
and renames artifacts `termiHub-<tag-version>-<platform>.<ext>`). Nothing in the
release workflow asserts these agree, nor that the five in-repo version sources
(`package.json`, `tauri.conf.json`, `src-tauri/Cargo.toml`, `agent/Cargo.toml`,
`core/Cargo.toml`) match the tag.

`scripts/release-check.sh` **does** contain exactly these checks (5-file version
consistency + the Tauri npm/crate drift check via `check-tauri-version-drift.mjs`), but
it is a manual script run at the operator's discretion — it is **not invoked by
release.yml** or any tag-triggered workflow.

## Why it matters
If someone tags `v0.2.0` while `tauri.conf.json` still says `0.1.0`, the pipeline
happily publishes assets named `termiHub-0.2.0-*` whose **internal app/bundle version
is 0.1.0**. The desktop update check (`update.rs`) then compares the real installed
version against GitHub tags, so the mismatch also breaks update-available detection.
The maintainer's stated goal is a turnkey "push one tag" release; a version/tag drift
guard is the one check that most directly protects that flow, and it is currently
outside the automated path.

## Evidence
- `release.yml:24-26` — version derived solely from the tag; no cross-check against
  repo files.
- `scripts/release-check.sh:16-55` — the consistency + drift checks live here, gated
  behind a manual run and requiring `main`/`release/*` branch + a clean tree.
- No workflow references `release-check.sh` or `check-tauri-version-drift.mjs`.

## Recommendation
Add a `verify-version` job at the top of release.yml (before `build-and-upload`) that
fails unless the tag version equals every in-repo version source and the Tauri
npm/crate drift check passes — reuse `scripts/internal/check-tauri-version-drift.mjs`
and a slim version-equality check (release-check.sh's git/branch/test steps are not
appropriate inside the tag workflow, so extract just the version block or add a
`--versions-only` mode). This makes drift a hard, automatic release gate.
