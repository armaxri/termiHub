---
id: TBE-003
title: VNC tests run against a mock that clamps dimensions; the real frame path does not
angle: test-backend
severity: high
category: test-gap
is_workaround: false
subsystem: core/backends/vnc
evidence:
  - core/src/backends/mock_remote_desktop.rs:37
  - core/src/backends/mock_remote_desktop.rs:122
  - core/src/backends/vnc/frame.rs:44
  - core/tests/vnc.rs:239
status: open
---

## What
The mock remote-desktop backend clamps every requested dimension to
`MAX_DIMENSION = 1920` via `clamp_dim()` (mock_remote_desktop.rs:37,122,278,408). The real VNC
shadow's `resize()` (frame.rs:44) allocates `width * height * 4` bytes straight from the wire-
supplied dimensions with **no clamp and no overflow guard**. So any test exercising resize against
the mock is structurally incapable of reproducing a hostile-server "huge desktop size → unbounded
allocation" scenario — the mock silently makes the input safe. The real integration tests
(vnc.rs) only ever connect to a normal-sized fixture server, so the untrusted-dimension path is
tested by nobody.

## Why it matters
This is the textbook "tests pass against a mock that diverges from the real backend" false-
confidence pattern the audit brief calls out. A malicious/broken VNC server advertising a
30000x30000 framebuffer triggers a multi-GB allocation in `FrameShadow::resize`; the suite is
green because the only resize path it ever runs is the clamped mock one. `frame.rs` unit tests
(frame.rs:140-210) are thorough on bounds-checked *blit/copy/extract* but never test `resize`
against an adversarial dimension.

## Evidence
- mock_remote_desktop.rs:37 `const MAX_DIMENSION: u16 = 1920;`
- mock_remote_desktop.rs:122-127 `clamp_dim` → `v.min(MAX_DIMENSION)`; applied at :278,:408.
- frame.rs:44-48 `resize` → `self.data = vec![0u8; (w as usize)*(h as usize)*4];` — no cap.
- vnc.rs:239-419 — every test uses a live fixture at normal size; no oversize-resolution case.

## Recommendation
Add a `FrameShadow::resize` unit test asserting a bound/refusal for absurd dimensions, and add a
maximum-dimension guard in `resize` mirroring the mock's intent. Add a decode-path test that
drives a hostile `FrameUpdate.width/height` through the real code, not the clamping mock. Treat
the mock's clamp as a spec the real path must also honour.
