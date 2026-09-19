---
id: PROD-018
title: RDP and VNC have no multi-monitor support (not even modeled)
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: core/connection/graphical, src/components/RemoteDesktop
evidence:
  - core/src/connection/graphical.rs:336
status: open
---

## What
Neither RDP nor VNC support multi-monitor sessions; `GraphicalCapabilities` has no
multi-monitor field and there is no monitor selector in the toolbar.

## Why it matters
Multi-monitor RDP is a common enterprise remote-desktop requirement. Its absence limits
termiHub's remote-desktop story to single-display use.

## Evidence
- `core/src/connection/graphical.rs:336-346` — no multi-monitor field.
- `src/components/RemoteDesktop/RemoteDesktopToolbar.tsx` — no monitor selector.

## Recommendation
Model multi-monitor in `GraphicalCapabilities`; expose monitor layout selection for RDP (and
VNC where supported). Reasonable to defer past v0.1.0 given remote desktop is experimental.
