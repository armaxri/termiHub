---
id: PKG2-008
title: "The RDP sidecar's release profile omits overflow-checks=true, the ventilator-grade release policy the workspace applies to every other shipped binary"
angle: packaging-release
severity: low
category: build-config
is_workaround: false
subsystem: "rdp-sidecar/Cargo.toml"
evidence:
  - rdp-sidecar/Cargo.toml:17-21
  - Cargo.toml:73-89
status: fixed
resolution: "#4343 — sidecar release overflow-checks; no-panic lint on all crate roots; check-crate-policy.mjs CI gate"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The root `[profile.release]` sets `overflow-checks = true` (ERR-010: a silent wrap is worse than a fail-fast panic in a safety-critical build), together with `strip = true`. The rdp-sidecar is workspace-excluded and has its own profile. Its comment claims it is 'matching the root workspace's release profile', but it only sets `strip = true`. So the bundled termihub-rdp-helper, which parses untrusted RDP server traffic, is the only shipped first-party binary built with Cargo's default `overflow-checks = false`.

## Why it matters

This is an inconsistent safety posture: unintended arithmetic overflow in the sidecar's own frame or bitmap glue code wraps silently in the shipped helper instead of panicking. That produces corrupt frames or out-of-range values rather than the fail-fast behaviour the rest of the product guarantees.

## Evidence

- `rdp-sidecar/Cargo.toml:17-21`
- `Cargo.toml:73-89`

## Recommendation

Add `overflow-checks = true` to rdp-sidecar/Cargo.toml `[profile.release]`. Extend scripts/internal/check-rust-version.mjs, or a small new check, to assert that the excluded crate's release profile matches the root profile's overflow-checks and strip settings.

## Verification

Confirmed. rdp-sidecar/Cargo.toml [profile.release] sets only strip = true, despite the comment 'matching the root workspace's release profile'. The root profile sets overflow-checks = true (ERR-010). The crate is workspace-excluded, so the root profile does not apply to it.
