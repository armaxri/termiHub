---
id: PROD-032
title: No durable history for one-shot network tool results
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/components/NetworkTools
evidence:
  - src/components/NetworkTools/HttpMonitorPanel.tsx:24
  - src/components/NetworkTools/WolPanel.tsx:34
status: open
---

## What
Ping/traceroute/port-scan/DNS results live only in in-session React state and vanish on
re-run or restart. Only WoL devices and HTTP-monitor configs are persisted (results are not).

## Why it matters
Re-running a tool discards the prior result; there is no run history across restarts to
compare over time.

## Evidence
- `src/components/NetworkTools/HttpMonitorPanel.tsx:24, 106-139` — rolling in-memory buffer cleared on stop.
- `src/components/NetworkTools/WolPanel.tsx:34` — session state; persisted stores exist only for WoL devices and HTTP-monitor configs.

## Recommendation
Persist a bounded per-tool run history (with timestamps) and a "recent runs" list users can
revisit/export.
