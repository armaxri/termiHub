---
id: WA-CI2-002
title: "Release gate does not require the Rust supply-chain audit (cargo-deny / cargo-audit) on the release commit"
angle: workaround-ci-scripts
severity: medium
category: masked-gate
is_workaround: false
subsystem: ci/release
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - scripts/internal/release-integration-gate.mjs:44-60
  - .github/workflows/release.yml:22-58
  - .github/workflows/security-audit.yml:52-65
  - .github/branch-protection.json:58-80
status: open
resolution: ""
---

## What

The Release workflow's gates are verify-version (version agreement plus a strict pnpm production audit) and verify-integration. REQUIRED_WORKFLOWS in the integration gate covers only release-candidate.yml, the code-quality.yml push run and the dev-build.yml push run. cargo-audit and cargo-deny (advisories including yanked, bans, licenses, sources) exist only in security-audit.yml, and nothing in release.yml or the gate reads its result. Security Audit's develop push runs are cancel-in-progress (#4119). Its daily schedule never fires (see the scheduled-lanes finding). main's pending branch protection drops 'Security Audit' from the required contexts. So no path forces a green Rust advisory/license/source audit on the exact commit being tagged.

## Why it matters

A tag can ship with a known RUSTSEC vulnerability, a yanked crate, an unapproved license or an unknown-git source whenever the post-merge Security Audit for that sha was red, cancelled or never ran. The npm side is strict at release (WA-CI-008 fix), which makes the Rust asymmetry clearly unintended. For a release bar described as ventilator-grade, the supply-chain gate should be as binding as the integration gate.

## Recommendation

Add `{ file: "security-audit.yml", name: "Security Audit (post-merge push run)", event: "push" }` to REQUIRED_WORKFLOWS, mirroring the Code Quality entry. Alternatively, run `cargo deny check advisories bans licenses sources` and `cargo audit` directly in release.yml's verify-version job next to the strict pnpm audit, so a fresh advisory published after the merge also blocks. Extend release-integration-gate.test.mjs to cover the new entry.

## Verification

Confirmed. REQUIRED_WORKFLOWS (release-integration-gate.mjs:45-61) lists only release-candidate.yml, the code-quality.yml push run and the dev-build.yml push run. release.yml verify-version runs only release-check.sh --versions-only and the strict pnpm audit. Neither release.yml nor release-candidate.yml mentions cargo-deny or cargo-audit. security-audit.yml cancels superseded develop push runs. The pending main protection note explicitly drops 'Security Audit'. That leaves no binding Rust advisory, license or source check on the tagged sha. The npm side is strict at release (WA-CI-008), so the gap looks unintended, and nothing in the docs presents it as a decision.
