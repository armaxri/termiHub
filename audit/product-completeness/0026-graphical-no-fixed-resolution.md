---
id: PROD-026
title: No user-set fixed resolution/color-depth for RDP/VNC (RDP width/height not in schema)
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: core/backends/rdp_sidecar, core/backends/vnc
evidence:
  - core/src/backends/rdp_sidecar/config.rs:83
  - core/src/backends/rdp_sidecar/config.rs:326
status: partial
resolution: "#3465, #3546 — RDP resolution mode (dynamic/fixed WxH) + color depth 16/24/32 wired to sidecar; VNC 16-bit + Tight quality done (#3546); VNC resolution (ExtendedDesktopSize) pending #3463"
---

## What
`RdpConfig.width/height` exist but are absent from the RDP settings schema; VNC has no
width/height at all. Sessions dynamic-resize/scale to the canvas with no way to pin a fixed
remote resolution.

## Why it matters
Users sometimes need a fixed remote resolution (app layout, recording, remembered geometry).
Dynamic-only is fine as default but the option is expected.

## Evidence
- `core/src/backends/rdp_sidecar/config.rs:83-86` (fields exist), schema `:326` (not exposed).
- VNC config has no width/height.

## Recommendation
Surface optional width/height (and VNC color depth) in the editors; default to dynamic when
unset. Low priority given experimental status.
