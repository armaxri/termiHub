---
id: SUP2-004
title: "RDP sidecar lockfile has no daily scheduled advisory scan, no cargo-audit run, no proactive lockfile refresh, and is skipped on PRs that change core; docs claim Security Audit covers it"
angle: supply-chain
severity: low
category: supply-chain
is_workaround: false
subsystem: "rdp-sidecar / CI"
status: fixed
resolution: "#4357 — Security Audit (RDP sidecar) job runs cargo audit + cargo deny daily/push/PR; cargo-update chore refreshes and gates the sidecar lock; ci-changes runs sidecar for core/win-security/Cargo.toml"
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - .github/workflows/code-quality.yml:10
  - .github/workflows/code-quality.yml:323
  - .github/workflows/code-quality.yml:328
  - .github/workflows/security-audit.yml:19
  - .github/workflows/security-audit.yml:46
  - .github/workflows/cargo-update-lockfile.yml:85
  - scripts/internal/ci-changes.mjs:170
  - rdp-sidecar/Cargo.toml:79
  - rdp-sidecar/.cargo/audit.toml:1
  - docs/supply-chain.md:111
---

## What

The sidecar's only supply-chain gate (fixed under SUP-001) is the cargo deny step inside the rdp-sidecar-quality job of code-quality.yml. That workflow has no schedule. The daily cron in security-audit.yml fans out over develop and main, but audits only the workspace lockfile. As a result, a RUSTSEC advisory or yank against rdp-sidecar/Cargo.lock surfaces only on the next develop/main push, and never on main between releases. cargo-audit is never run on the sidecar, even though rdp-sidecar/.cargo/audit.toml is maintained. The daily cargo-update chore refreshes only the root Cargo.lock, so the sidecar never gets the proactive yank fix, and the yanked-crate runbook does not mention it. The sidecar depends on termihub-core by path (rdp-sidecar/Cargo.toml:79), yet ci-changes.mjs maps only rdp-sidecar/\*\* to the sidecar area. A PR that adds a non-optional dependency to core therefore changes the shipped sidecar's graph with no PR-time deny check. docs/supply-chain.md:111-113 states that the Security Audit job runs cargo audit and cargo deny on the root workspace and on rdp-sidecar/, which is not true.

## Why it matters

The sidecar ships in every installer and parses untrusted RDP input over pre-release CredSSP crypto, so it is the graph that most needs time-based monitoring. Its coverage today is opportunistic: it depends on push traffic and is absent for main. The inaccurate doc lets a maintainer believe the daily audit covers it.

## Recommendation

Add an rdp-sidecar leg to security-audit.yml: `cargo audit -f rdp-sidecar/Cargo.lock` plus `cargo deny --manifest-path rdp-sidecar/Cargo.toml check ...`, so it gets the daily main/develop schedule without a full build. Extend cargo-update-lockfile.yml to also `cargo update --manifest-path rdp-sidecar/Cargo.toml` with the same deny pre-gate. In ci-changes.mjs, also add `sidecar` for core/\*\* and Cargo.toml changes. Correct docs/supply-chain.md:111-113.

## Verification

Confirmed. In security-audit.yml, cargo audit/deny run only on the root workspace (lines 148/167), and its own header says the sidecar is gated in code-quality.yml. code-quality.yml has no schedule, so sidecar advisories surface only on a develop/main push. cargo-update-lockfile.yml runs a plain `cargo update` (root only). ci-changes.mjs:170 maps only rdp-sidecar/\*\* to the sidecar area, although the sidecar depends on ../core by path. docs/supply-chain.md:110-112 wrongly states that the Security Audit job runs cargo audit and cargo deny on rdp-sidecar/. Post-merge push runs cover develop, so low is right.
