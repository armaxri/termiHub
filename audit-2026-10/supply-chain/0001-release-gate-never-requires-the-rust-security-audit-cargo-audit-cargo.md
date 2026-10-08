---
id: SUP2-001
title: "Release gate never requires the Rust Security Audit (cargo audit / cargo deny / lockfile-freshness), and agent release binaries build without --locked"
angle: supply-chain
severity: medium
category: supply-chain
is_workaround: false
subsystem: "release / CI gates"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - scripts/internal/release-integration-gate.mjs:45
  - scripts/internal/release-integration-gate.mjs:28
  - scripts/internal/release-integration-gate.mjs:53
  - scripts/internal/release-integration-gate.mjs:58
  - scripts/internal/release-integration-gate.mjs:61
  - .github/workflows/release.yml:51
  - .github/workflows/release.yml:55
  - .github/workflows/release.yml:810
  - .github/workflows/release.yml:696
  - .github/workflows/release.yml:778
  - .github/workflows/release.yml:844
  - .github/workflows/security-audit.yml:42
  - .github/workflows/security-audit.yml:158
  - .github/branch-protection.json:60
  - scripts/internal/third-party-notices.mjs:288
---

## What

\#3325 moved cargo audit, cargo deny (advisories incl. yanked, bans, licenses, sources) and the third-party-notices check out of code-quality.yml into a separate security-audit.yml. The release gate (release-integration-gate.mjs, added two days later, 7b77586cb) requires only release-candidate.yml, the code-quality.yml push run and the dev-build.yml push run on the release sha. It never checks Security Audit. Inside release.yml only the npm prod audit is re-run strictly (lines 51-58). No cargo audit or cargo deny runs anywhere in the release workflow. Security Audit is not triggered by tag pushes either (push: branches main/develop only). The pending protection for main explicitly drops Security Audit from the required checks (branch-protection.json:60). In addition, no root-workspace cargo invocation in CI or release uses --locked. The only check that a root Cargo.lock is fresh is `cargo fetch --locked` inside the Security Audit third-party-notices job. The agent release jobs (release.yml:696/778/844, `cargo build --release ... -p termihub-agent` at :810) do not depend on that job.

## Why it matters

A release can ship a crate with a newly published RUSTSEC vulnerability, a yanked crate, a disallowed license or a non-crates.io source, even while the daily Security Audit on main is red. That gate exists precisely because advisories are time-based. The npm half is gated strictly at release time; the Rust half, which is the larger and crypto-bearing graph, is not. Without --locked, a Cargo.lock that is stale against a Cargo.toml (the #3334 failure class, already seen on the sidecar) is silently re-resolved at release-build time. The agent binaries would then contain crate versions that no audit graded, while the SBOM and notices describe the committed lock.

## Recommendation

Add security-audit.yml (event push, the main branch run on the release sha, or a workflow_dispatch on the tag) to REQUIRED_WORKFLOWS. Alternatively, run `cargo deny check advisories bans licenses sources` for the root workspace and rdp-sidecar inside release.yml's verify-version job, in strict mode next to the pnpm audit. Pass `--locked` to every release cargo build (agent jobs, build-rdp-sidecar.sh, build-plugin-runner.sh, and tauri-action args `-- --locked`), and add `--locked` to the workspace clippy/test in rust-quality so a stale root lock fails per PR.

## Verification

Confirmed. REQUIRED_WORKFLOWS in release-integration-gate.mjs lists only release-candidate.yml, code-quality.yml (push) and dev-build.yml (push). release.yml re-runs only the strict pnpm prod audit and has no cargo audit or cargo deny step. The agent builds at :810/:884 have no --locked, and no root-workspace cargo call in CI uses --locked (only the sidecar's clippy/test do). Security Audit triggers on push to develop/main, daily schedule and dispatch, never on tags. branch-protection.json's pending main set drops it from required checks. No ADR or doc accepts a release that skips the Rust audit; supply-chain.md only says the npm audit is strict in the Release workflow.
