---
id: TIN-006
title: VNC is covered only at the backend/RFB level (Linux-nightly-only) — no end-to-end UI or paint coverage
angle: test-integration
severity: medium
category: test-gap
is_workaround: false
subsystem: core/backends/vnc, tests/docker/vnc-server
evidence:
  - core/tests/vnc.rs
  - tests/docker/docker-compose.yml:294
  - tests/system/tests/
status: open
---

## What

VNC has a solid **backend** integration test (`core/tests/vnc.rs`: plain VncAuth
+ VeNCrypt X509/TLS, real framebuffer decode, input/clipboard round-trip) against
the `vnc-server` / `vnc-vencrypt-server` Docker fixtures. But:

- Those tests run only in `integration-fixtures.yml` (nightly / backend-path PRs)
  and under the `vnc` compose profile — **Linux only**, since the Docker fixtures
  are Linux-only (TIN-007).
- There is **no Python bridge / E2E suite** for VNC (`grep vnc tests/system/tests`
  → nothing): the app-side journey — opening a VNC tab, the canvas mounting,
  rendering, resize, disconnect/reconnect in the real UI — is unverified
  end-to-end on any platform.

## Why it matters

- The RFB decode is tested in isolation, but the integration between the decoded
  framebuffer and the app's canvas/rendering surface (the part users see) has no
  automated check. A regression in the VNC view component or its wiring would not
  fail any lane.
- VNC paint fidelity remains a manual grade, and the backend correctness signal
  only exists on Linux nightly, so a macOS/Windows-specific VNC regression has no
  automated tripwire at all.

## Evidence

- `core/tests/vnc.rs` — backend suite (RFB decode, auth variants).
- `docker-compose.yml:294, 316` — `vnc-server` / `vnc-vencrypt-server` under
  `profiles: [vnc]` (and `all`).
- `tests/system/tests/` — no VNC bridge suite.

## Recommendation

- Add a bridge E2E suite that opens a VNC connection to the existing fixture and
  asserts the canvas mounts and the session goes live (analogous to the SSH
  `test_ssh.py` "terminal becomes live" check), plus a disconnect path.
- Longer term, consider a screenshot/marker-based paint assertion for the VNC
  canvas the way `test_visual_rendering_smoke.py` does for the terminal, so at
  least gross render regressions are caught without a human.
