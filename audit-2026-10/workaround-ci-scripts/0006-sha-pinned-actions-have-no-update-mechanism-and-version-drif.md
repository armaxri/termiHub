---
id: WA-CI2-006
title: "SHA-pinned actions have no update mechanism and version drift has returned (WA-CI-034 half-done); cross-rs pin duplicated 4x without a consistency check"
angle: workaround-ci-scripts
severity: low
category: supply-chain
is_workaround: false
subsystem: ci/workflows
audit: 2026-10
commit: 663465d52
relation: previous-incomplete
previous_id: WA-CI-034
evidence:
  - .github/workflows/system-integration.yml:527
  - .github/workflows/system-integration.yml:724
  - .github/workflows/release-linux-smoke.yml:318
  - .github/workflows/release-windows-smoke.yml:450
  - .github/workflows/release-macos-smoke.yml:391
  - .github/workflows/agent.yml:120-121
  - .github/workflows/dev-build.yml:483-484
  - .github/workflows/release.yml:734-735
  - scripts/internal/build-system-test-agent.sh:44-45
status: open
resolution: ""
---

## What

WA-CI-034 recommended pinning to SHAs plus Dependabot (or a bump chore), and unifying drift. The SHA pinning landed. There is still no .github/dependabot.yml, Renovate config or bump job, and the drift has returned: 19 uses of actions/upload-artifact@…# v7.0.1 against 7 uses of @ea165f8… # v4.6.2 (system-integration.yml:527 and :724, and every release-\*-smoke.yml). The cross-rs version and SHA256 are copied in four places (agent.yml, dev-build.yml, release.yml, build-system-test-agent.sh). Unlike the Rust toolchain (check-rust-version.mjs) and uv (check-uv-version.mjs) pins, nothing keeps those copies in sync.

## Why it matters

Pinned SHAs that nobody bumps go stale quietly: security fixes in actions and runner Node-runtime deprecations are missed until something breaks. Mixed major versions of one action and diverging copies of a checksum-pinned binary mean a bump touches only some workflows. This is the same single-source-of-truth problem the repo already solved for rust-version and uv-version.

## Recommendation

Add .github/dependabot.yml with `package-ecosystem: github-actions` (weekly; Dependabot keeps the `# vX.Y.Z` comment in step with the SHA). Move the 7 upload-artifact v4.6.2 uses to the v7.0.1 SHA. Move CROSS_VERSION/CROSS_SHA256 into one file (e.g. .github/cross-version) read by a tiny composite action and by build-system-test-agent.sh, with a check-\*-version.mjs consistency test like the uv one.

## Verification

Confirmed. There is no .github/dependabot.yml or renovate config. upload-artifact uses split 19x v7.0.1 against 7x v4.6.2 (e.g. system-integration.yml:527). CROSS_VERSION and CROSS_SHA256 are duplicated in release.yml, dev-build.yml and agent.yml (plus the script). No check-\*-version.mjs covers cross. Dependabot appears only as an unadopted backlog concept, not as a decision against it. WA-CI-034's update-mechanism half is unfinished.
