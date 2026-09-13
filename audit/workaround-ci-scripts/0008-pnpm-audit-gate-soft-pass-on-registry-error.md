---
id: WA-CI-008
title: pnpm-audit prod gate soft-passes on registry errors (network flake masking)
angle: workaround-ci-scripts
severity: medium
category: workaround
is_workaround: true
subsystem: scripts/internal
evidence:
  - scripts/internal/pnpm-audit-prod-gate.sh:75
  - scripts/internal/pnpm-audit-prod-gate.sh:95
  - .github/workflows/code-quality.yml:300
status: open
---

## What
The blocking production-dependency security gate is wrapped in a custom script
(`scripts/internal/pnpm-audit-prod-gate.sh`) that, on an empty/non-JSON `pnpm audit` payload
(registry unreachable), retries with backoff up to `AUDIT_MAX_ATTEMPTS` (default 3) and then
**soft-passes** — treating "could not reach the npm registry" as success. It only fails when
the parsed JSON reports `high+critical > 0`.

## Why it matters
This is a deliberate, tested trade-off (a bare `pnpm audit --prod` reds every PR on any
registry blip, #2589), so it is a *justified* stopgap. But the soft-pass means a genuine
registry outage window silently disables the security gate for that run — an attacker-relevant
gap if it coincides with a freshly-published advisory. The gate's own comment acknowledges it
"stays genuinely blocking for advisories" only when the registry is reachable.

## Evidence
`output="$(run_audit || true)"` (line 77), retry/backoff loop (lines 95-102), soft-pass path;
wired at `code-quality.yml:300` as the "blocking" step.

## Recommendation
Reasonable, but harden: on the release branch, treat an unreachable registry after N attempts
as a **failure** (not a soft-pass) so a release is never cut with the audit gate silently
skipped. Emit a distinct, greppable "AUDIT SKIPPED — registry unreachable" marker to the step
summary so soft-passes are auditable. Keep the soft-pass for day-to-day develop PRs only.
