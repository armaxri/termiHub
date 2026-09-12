---
id: CI-015
title: PR Build is --no-bundle + trimmed matrix, so installers are unverified pre-merge
angle: ci-cd
severity: medium
category: packaging
is_workaround: true
subsystem: .github/workflows/build.yml
evidence:
  - .github/workflows/build.yml:14
  - .github/workflows/build.yml:92
  - .github/workflows/build.yml:27
status: open
---

## What
The per-PR `build.yml` compiles with `pnpm tauri build --no-bundle` (`:92`), deliberately skipping
installer packaging (NSIS/MSI/DMG/AppImage), and trims the matrix to one arch per OS — dropping
macOS x64 and Linux arm64 (`:14-37`). Full installers and the dropped arches are only built
**post-merge** by `dev-build.yml` (push to develop/main). So a change that breaks packaging, the
bundle config, `externalBin` staging, the RDP sidecar bundling, or a dropped-arch build reaches
`develop` before any signal.

## Why it matters
Packaging regressions land on develop and are only discovered by the post-merge dev-build or, worse,
at release. The comment argues packaging "rarely breaks" — but the release path adds an RDP sidecar
(`release.yml:189`) and ad-hoc re-signing that the PR build never exercises, so the release build is
materially different from anything gated per-PR. macOS x64 and Linux arm64 have **no** per-PR build
at all.

## Evidence
`:92` `--no-bundle`; `:27-37` three-target matrix; `dev-build.yml` is the first place bundles/dropped
arches build. `release.yml` adds sidecar+resign steps absent from all PR builds.

## Recommendation
Keep PR builds fast, but add a periodic (nightly or pre-release) job that does a **full bundle build
across the complete matrix including the release-only sidecar+sign path**, so packaging breakage is
caught before a tag is cut rather than during the release. At minimum add a develop-push full-bundle
build gate that blocks the next release if it failed.
