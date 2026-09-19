---
id: PROD-030
title: No historical graphs for system stats — only an instantaneous reading
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/system_monitor_projection, src/components/StatusBar
evidence:
  - src-tauri/src/system_monitor_projection/store.rs:4
  - src/components/StatusBar/StatusBar.tsx:842
status: open
---

## What
The monitor store keeps only the last-known sample per monitor; there is no time series.
CPU/mem/disk are shown as compact status-bar text only, so spikes between glances are invisible.
(A latency chart exists, but only for the HTTP-monitor network tool.)

## Why it matters
Trend/sparkline graphs are a defining feature of a system monitor; a single current reading
misses transient load.

## Evidence
- `src-tauri/src/system_monitor_projection/store.rs:4-8, 48-102` — last-known sample only.
- No chart/history/series in `src/store/useProjectedMonitors.ts` / `src/types/monitoring.ts`.
- Only render is status-bar text (`src/components/StatusBar/StatusBar.tsx:842-867`).

## Recommendation
Retain a bounded rolling window of samples and render CPU/mem/disk sparklines/trends in a
monitoring panel (the HTTP-monitor `LatencyChart` is a model to reuse).
