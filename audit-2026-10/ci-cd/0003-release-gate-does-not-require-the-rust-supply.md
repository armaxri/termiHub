---
id: CI2-003
title: "Release gate does not require the Rust supply-chain audit (cargo-deny/cargo-audit) on the release commit"
angle: ci-cd
severity: medium
category: supply-chain
is_workaround: false
subsystem: .github/workflows/release.yml
evidence:
  - scripts/internal/release-integration-gate.mjs:45
  - scripts/internal/release-integration-gate.mjs:61
  - .github/workflows/release.yml:50
  - .github/workflows/release.yml:57
  - .github/workflows/security-audit.yml:22
  - .github/branch-protection.json:98
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Per the slim-lane decision (#3325/#3326), Security Audit (cargo audit, cargo-deny advisories/bans/licenses/sources, third-party notices gate) runs per-PR only on manifest changes, plus post-merge and daily. REQUIRED*WORKFLOWS in release-integration-gate.mjs lists only release-candidate.yml, code-quality.yml (push) and dev-build.yml (push); Security Audit is not among them. code-quality's rust-quality no longer runs cargo audit/deny for the workspace (code-quality.yml:236), and release.yml's verify-version runs only the strict \_pnpm* audit. main's pending branch-protection set also drops 'Security Audit'. The daily scheduled audit never fires (see the scheduled-lanes finding).

## Why it matters

A tag can be cut and published on a main commit whose Security Audit push run is red: a RUSTSEC advisory, a yanked crate, a banned license or an unknown source. The release workflow's own comment says an unaudited tree must never ship (release.yml:50-53), but that is enforced only for npm. For a safety-critical app the Rust graph is the larger attack surface.

## Recommendation

Add `{ file: 'security-audit.yml', name: 'Security Audit (post-merge push run)', event: 'push' }` to REQUIRED_WORKFLOWS, with a test in release-integration-gate.test.mjs, or run `cargo deny check advisories bans licenses sources` plus `cargo audit` directly in verify-version. Because advisories are time-based, the in-workflow check is the stronger option: it grades the DB at tag time.

## Verification

The finding is real: I checked every piece of evidence and found nothing elsewhere that closes the gap. REQUIRED_WORKFLOWS in scripts/internal/release-integration-gate.mjs:45-61 lists only release-candidate.yml, code-quality.yml (push) and dev-build.yml (push). It does not include security-audit.yml. In release.yml, verify-version (lines 50-58) runs only the strict pnpm audit, and no job in release.yml runs cargo deny or cargo audit. The only cargo commands there are agent builds and the cyclonedx SBOM step. release-candidate.yml has no deny or audit step either. code-quality.yml:236-240 says outright that cargo audit moved to security-audit.yml, and the only cargo-deny check still in code-quality is for rdp-sidecar's own lockfile. security-audit.yml runs on pull requests only when a manifest or lockfile changes, plus on push and daily. Nothing ties its result to the release sha. Main's pending protection set in branch-protection.json and docs/contributing.md:323 drops 'Security Audit'. Nothing in docs/supply-chain.md, docs/contributing.md or audit/FINAL-SUMMARY.md records a decision to leave the Rust audit out of the release gate. The 2026-09-25 decision that findings surface post-merge covers PRs, not releases. So a tag can be published on a main commit whose Security Audit push run is red or was cancelled, or on a tree that has a newly published RUSTSEC advisory, a yanked crate, or a license or source problem. I am lowering the severity from high to medium. This is a missing defense-in-depth gate, not an exploitable flaw. The Security Audit push run on main still executes and shows red to the maintainer, who cuts releases by hand. The current main protection still requires Security Audit on release PRs into main. Making it high would need the claim that the daily schedule never fires, which I did not verify. The suggested fix stands: run cargo deny check and cargo audit inside verify-version so the advisory database is checked at tag time, or add security-audit.yml as a required push run in REQUIRED_WORKFLOWS.
