---
id: CI-014
title: setup-pnpm retries the installer 3× via continue-on-error
angle: ci-cd
severity: low
category: workaround
is_workaround: true
subsystem: .github/actions/setup-pnpm
evidence:
  - .github/actions/setup-pnpm/action.yml:11
  - .github/actions/setup-pnpm/action.yml:16
status: open
---

## What
The `setup-pnpm` composite action runs `pnpm/action-setup@v6` up to three times, swallowing the
first two failures with `continue-on-error: true` (`action.yml:11-23`), to tolerate the
"occasionally-flaky self-installer" on GitHub runners (Windows especially).

## Why it matters
A reasonable flake mitigation, but worth cataloguing: (1) it retries an **unpinned** third-party
action (see CI-003) — a compromised installer would simply be retried, not caught; (2) blanket
retry-until-success on tooling install is the same masking pattern flagged elsewhere, just low-blast-
radius here (setup only, not test results). It hides a genuinely broken pin behind three attempts.

## Evidence
`action.yml:11-23` — attempt-1 and attempt-2 `continue-on-error`, third attempt gates.

## Recommendation
Keep the retry, but SHA-pin `pnpm/action-setup` (CI-003) so the retried artifact is fixed, and cache
the pnpm install so a transient registry blip is less likely. Optionally log which attempt succeeded
so a rising retry rate is visible rather than silent.
