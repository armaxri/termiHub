---
id: TBE-007
title: No enforced Rust coverage gate (frontend has one, backend has none)
angle: test-backend
severity: high
category: tooling
is_workaround: false
subsystem: .github/workflows
evidence:
  - .github/workflows/code-quality.yml:223
  - .github/workflows/code-quality.yml:263
status: partial
resolution: "develop — rust coverage tooling landed (coverage.yml cargo-llvm-cov unified FE+Rust via scripts/coverage.sh) but NOT enforcing: whole job continue-on-error:true (:33 'advisory'), coverage.sh:13 doesn't fail on low value. Remaining: flip to fail-on-decrease ratchet after baseline — maintainer/policy call (same as CI-011)"
---

## What
The frontend has a coverage gate — `pnpm test:coverage` runs on Ubuntu and fails CI on a real drop
(code-quality.yml:218-225). There is **no equivalent for Rust**: no `cargo tarpaulin`, no
`cargo llvm-cov`, no codecov threshold anywhere in `.github/` or `scripts/`. The only Rust
"coverage" artifact is the advisory test-inventory / coverage-gap report at code-quality.yml:263,
which is explicitly `continue-on-error` (non-blocking, "surfaced in the step summary, never fails
the build").

## Why it matters
Nothing prevents Rust coverage from silently eroding. The most safety-critical code in the product
(backends, agent protocol, credential store, reconnect) lives in Rust, yet it is the layer with no
coverage floor. New code can merge with zero tests and CI stays green. For a ventilator-grade
release this asymmetry — a hard gate on the UI layer, none on the systems layer — is backwards.

## Evidence
- code-quality.yml:218-225 — `Run frontend tests with coverage` → `pnpm test:coverage` (gating).
- code-quality.yml:263-268 — Rust-side "Test inventory + coverage-gap report (advisory)",
  `continue-on-error`.
- `grep -rn 'tarpaulin\|llvm-cov\|codecov'` over `.github/` → no gating Rust coverage tooling.

## Recommendation
Add `cargo llvm-cov` (best nextest integration) on the Ubuntu leg with a per-crate floor,
starting at the current measured level as a ratchet (fail-on-decrease rather than a fixed target,
mirroring the frontend rationale). Note the integration-lane caveat: because most core/tests
self-skip without Docker (TBE-006), a naive coverage run under-counts the backend paths — the gate
must run on a fixture-provisioned lane or explicitly exclude integration-only modules from the
denominator to avoid a misleadingly low-but-stable number.
