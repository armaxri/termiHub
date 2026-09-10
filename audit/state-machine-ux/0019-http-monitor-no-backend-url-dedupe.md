---
id: SM-019
title: HTTP monitor start has no server-side dedupe by URL (double loops if the client guard is bypassed)
angle: state-machine-ux
severity: low
category: bug
is_workaround: false
subsystem: src-tauri/src/network + core/src/monitoring/http_monitor.rs
evidence:
  - src/components/HttpMonitorPanel.tsx:71
  - core/src/monitoring/http_monitor.rs:154
status: open
---

## What
The double-click Start race is fixed on the client with an in-flight guard
(`startInFlightRef`, `HttpMonitorPanel.tsx:71-76`), but `start_http_monitor` has **no
server-side dedupe** by URL. Two windows, or any path that bypasses the client guard, can
spawn two independent poll loops for the same URL.

## Why it matters
Two loops on the same endpoint double the request rate and produce a second untracked poller
the panel does not attach to (only the last id is shown), which is then only killable via the
sidebar/Open Connections. Low severity because the common single-window double-click is
already guarded; this is the residual multi-window/bypass case.

## Evidence
- `HttpMonitorPanel.tsx:71-76` — client-side in-flight guard only.
- `core/src/monitoring/http_monitor.rs:154` — start has no URL dedupe.

## Recommendation
Dedupe by URL server-side in `start_http_monitor` (return the existing monitor id if one is
already polling the same URL), making the guarantee independent of any client guard.
