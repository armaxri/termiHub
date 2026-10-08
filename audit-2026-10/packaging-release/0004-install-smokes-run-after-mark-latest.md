---
id: PKG2-004
title: "Install smokes run only after the Release workflow, including mark-latest, has finished: a stable release is promoted to 'Latest' and offered to clients before any macOS/Windows/Linux install smoke grades it"
angle: packaging-release
severity: medium
category: release-gating
is_workaround: false
subsystem: ".github/workflows/release.yml + release-*-smoke.yml"
evidence:
  - .github/workflows/release.yml:1309-1330
  - .github/workflows/release-macos-smoke.yml:56-60
  - .github/workflows/release-windows-smoke.yml:44-48
  - .github/workflows/release-linux-smoke.yml:34-38
  - src-tauri/src/commands/update.rs:11
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The fix for PKG-006 added the install and launch smokes as separate workflows triggered by `workflow_run: Release completed`. mark-latest is a job inside Release that runs right after verify-release. With TERMIHUB_STABLE_RELEASE=true, the release is therefore already GitHub's 'Latest' (which the desktop update check and the agent self-updater poll through releases/latest) before any smoke has run. A DMG that is killed at exec, an MSI that fails to install, or a cross-built Intel bundle that panics is advertised to every installed client, and the smokes only report the failure afterwards. verify-release checks asset names and attestations only, not whether the artifacts run.

## Why it matters

PKG-006 asked for install smokes as release gates. As wired, they are post-hoc monitors for the stable channel: the release can go out to every client before the one check that executes the artifacts has run.

## Evidence

- `.github/workflows/release.yml:1309-1330`
- `.github/workflows/release-macos-smoke.yml:56-60`
- `.github/workflows/release-windows-smoke.yml:44-48`
- `.github/workflows/release-linux-smoke.yml:34-38`
- `src-tauri/src/commands/update.rs:11`

## Recommendation

Make each smoke a reusable workflow (`on: workflow_call`, keeping workflow_dispatch) and call it from release.yml after verify-release, then put mark-latest (and, with the draft flow, the publish step) behind `needs: [verify-release, macos-smoke, windows-smoke, linux-smoke, linux-arm64-smoke]`. Or move mark-latest into its own workflow_run workflow that requires every smoke to have concluded success.

## Verification

Confirmed. mark-latest needs only [create-release, verify-release] (release.yml:1311). The macOS, Windows and Linux smokes trigger on workflow_run, Release completed, and the macOS smoke's own header says it is a separate post-release workflow. With TERMIHUB_STABLE_RELEASE=true, 'Latest' is set before any artifact is executed. This only bites when the maintainer opts in to stable releases (the default is prerelease), but the smokes are not gates.
