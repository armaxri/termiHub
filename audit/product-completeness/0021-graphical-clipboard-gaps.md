---
id: PROD-021
title: Graphical clipboard gaps — no image clipboard; VNC clipboard is text-only
angle: product-completeness
severity: low
category: missing-feature
is_workaround: false
subsystem: core/backends/vnc, core/backends/rdp_sidecar
evidence:
  - core/src/backends/vnc/mod.rs:704
  - core/src/backends/rdp_sidecar/mod.rs:690
status: open
---

## What
Neither backend supports image clipboard. VNC clipboard is text-only (RDP adds file transfer).

## Why it matters
Copy-pasting images and (for VNC) files across the remote-desktop boundary is a common
expectation; only RDP file transfer is covered.

## Evidence
- `core/src/backends/vnc/mod.rs:704-725` — clipboard text only.
- `core/src/backends/rdp_sidecar/mod.rs:690-796` — RDP file transfer both directions.

## Recommendation
Add image clipboard where the protocol supports it; consider VNC file transfer. Low priority
given remote desktop is experimental.
