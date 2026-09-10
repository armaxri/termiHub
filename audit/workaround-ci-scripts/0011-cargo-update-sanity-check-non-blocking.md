---
id: WA-CI-011
title: cargo-update-lockfile advisory sanity-check is non-blocking
angle: workaround-ci-scripts
severity: info
category: workaround
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/cargo-update-lockfile.yml:94
status: open
---

## What
The weekly `cargo-update-lockfile.yml` chore runs `cargo deny check advisories` as a
`continue-on-error: true` sanity step (line 94) before opening its lockfile-refresh PR. A
failure is surfaced but never blocks opening the PR — per-PR CI is treated as the authoritative
gate.

## Why it matters
Correct by design (the refreshed lockfile is worth landing even if a residual advisory remains,
and per-PR CI will catch it). Catalogued as an intentionally non-gating step. Not a defect.

## Evidence
`continue-on-error: true` (line 94) under "Sanity-check advisories (non-blocking)".

## Recommendation
No action. This is a well-reasoned non-blocking check backed by an authoritative downstream
gate. Info.
