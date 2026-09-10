---
id: CI-012
title: Advisory continue-on-error steps that never fail CI
angle: ci-cd
severity: medium
category: workaround
is_workaround: true
subsystem: .github/workflows
evidence:
  - .github/workflows/code-quality.yml:269
  - .github/workflows/code-quality.yml:311
  - .github/workflows/cargo-update-lockfile.yml:94
status: open
---

## What
Several steps are `continue-on-error` and therefore surface signal without ever gating a merge —
legitimate as *warnings*, but each is a check that looks present and is not enforcing:

1. **Coverage-gap report** (`code-quality.yml:268-271`) — lists feature areas with zero automated/
   manual coverage into the step summary; a growing coverage gap never fails CI.
2. **Full-tree pnpm audit** (`code-quality.yml:309-311`) — dev+build dependency advisories are
   warn-only. Reasonable (they don't ship), but it means a dev-tool high/critical is never gated even
   when a patch exists.
3. **cargo-update sanity-check advisories** (`cargo-update-lockfile.yml:92-95`) — the automation PR
   can be opened with a lockfile that still fails the yanked/advisory gate.

## Why it matters
Advisory checks decay: because nothing forces action, the coverage gap widens and dev-dependency
advisories accumulate unattended. They are individually defensible but collectively they are part of
the "looks gated, isn't" surface a reviewer should be able to enumerate — which is why they are
catalogued here as workarounds to periodically re-examine, not to leave as permanent no-ops.

## Evidence
The three `continue-on-error: true` steps above; note the coverage-gap report's own comment calls it
"non-blocking" and "advisory".

## Recommendation
Keep them advisory where the rationale holds (dev-only advisories), but add a forcing function: turn
the coverage-gap report into a ratcheted gate (fail when the zero-coverage set grows), and promote a
full-tree advisory to blocking once an upstream fix is available. Review the advisory set each
release cycle so items graduate to gates rather than living as warnings forever.
