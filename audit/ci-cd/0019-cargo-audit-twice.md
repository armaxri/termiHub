---
id: CI-019
title: cargo audit runs twice per PR; redundant CI work
angle: ci-cd
severity: low
category: perf
is_workaround: false
subsystem: .github/workflows/code-quality.yml
evidence:
  - .github/workflows/code-quality.yml:110
  - .github/workflows/code-quality.yml:325
status: open
---

## What
`cargo audit` runs in two separate jobs on every PR: once in `rust-quality` (`:104-110`) and again in
`security-audit` (`:319-325`). The `security-audit` job additionally runs `cargo deny check` (which
also covers advisories). Both jobs install `cargo-audit` via `taiki-e/install-action` and set up
Rust independently.

## Why it matters
Minor duplication of runner minutes and setup — two toolchain installs and two audit passes for the
same lockfile on the same commit. Not a correctness issue, but avoidable cost that compounds across
the PR volume, and mild confusion about which job is authoritative for advisories (cargo-audit vs
cargo-deny advisories).

## Evidence
`:104-110` (rust-quality) and `:319-325` (security-audit) both run `cargo audit`; `:343-344` cargo-deny
advisories overlaps further.

## Recommendation
Consolidate the advisory/audit checks into the single `security-audit` job (it already has cargo-deny,
which subsumes yanked/advisory), and drop the duplicate `cargo audit` from `rust-quality` — or keep
one tool as the authority. Deduplicate the Rust setup where the jobs can share.
