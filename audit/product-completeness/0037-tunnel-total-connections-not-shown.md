---
id: PROD-037
title: Tunnel lifetime connection count is collected but never displayed
angle: product-completeness
severity: low
category: ux
is_workaround: false
subsystem: core/tunnel, src/components/TunnelSidebar
evidence:
  - core/src/tunnel/config.rs:76
  - src/components/TunnelSidebar/TunnelListItem.tsx:333
status: open
---

## What
`total_connections` is tracked in `TunnelStats` but the sidebar only renders
bytesSent/bytesReceived/activeConnections, so cumulative lifetime connections are never shown.

## Why it matters
Minor — a watching user cannot see how many total connections a tunnel has served, only the
current active count. Data exists; only display is missing.

## Evidence
- `core/src/tunnel/config.rs:76-77` — `total_connections`.
- `src/components/TunnelSidebar/TunnelListItem.tsx:333-335` — stats line omits it.

## Recommendation
Add total_connections to the tunnel stats line.
