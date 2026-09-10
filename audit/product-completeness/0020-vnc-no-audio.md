---
id: PROD-020
title: VNC has no audio redirection (RDP has it on macOS/Windows)
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: core/backends/vnc
evidence:
  - core/src/backends/vnc/mod.rs:503
status: open
---

## What
VNC sessions carry no audio. RFB has no standard audio channel, so this is a protocol norm,
but it is a parity difference from RDP worth noting.

## Why it matters
Users switching between RDP and VNC will notice audio only works on one; expectations should
be set. Low priority given protocol limits.

## Evidence
- `core/src/backends/vnc/mod.rs` GraphicalBackend impl — no audio path.

## Recommendation
Document the limitation. No action expected for v0.1.0.
