---
id: PROD-038
title: Tunnel stats show cumulative bytes only, no live bandwidth rate
angle: product-completeness
severity: low
category: ux
is_workaround: false
subsystem: core/tunnel, src/components/TunnelSidebar
evidence:
  - core/src/tunnel/config.rs:69
status: open
---

## What
Tunnel stats expose only cumulative bytes sent/received; there is no throughput rate (KB/s).

## Why it matters
"bandwidth/stats" usually implies a live rate. Users watching a tunnel see running totals,
not current throughput.

## Evidence
- `core/src/tunnel/config.rs:69-77` — cumulative `bytes_sent`/`bytes_received` only.

## Recommendation
Derive and display a rolling KB/s rate from the periodic stats samples.
