---
id: PERF-007
title: Stats/status/transfer-progress are serialized twice (legacy Tauri emit + projection fold)
angle: performance
severity: medium
category: perf
is_workaround: true
subsystem: src-tauri/src/session/monitoring_controller.rs, src-tauri/src/files/transfer
evidence:
  - src-tauri/src/session/monitoring_controller.rs:195
  - src-tauri/src/session/monitoring_controller.rs:202
  - src-tauri/src/files/transfer/mod.rs:194
status: open
---

## What
After the projection inversion made the regions authoritative, several high-frequency paths
still **dual-write**: they fold the sample into the projection store (which re-serializes +
diffs + emits a diff) **and** additionally fire the pre-inversion legacy Tauri event
carrying the full payload. Each sample is thus serialized twice and crosses IPC twice.

- Monitoring: every stats sample calls `fold_monitor_transition(...)` **and**
  `app_handle.emit("session-monitoring-stats", &event)`; same for status
  (`session-monitoring-status`).
- Transfers: every 100ms-throttled progress sample calls `fold_transfer_progress(...)`
  **and** `app.emit(TRANSFER_PROGRESS_EVENT, progress)`.

## Why it matters
Both the projection diff and the legacy full-payload emit are delivered on every sample:
2s cadence per monitored session, and up to 10/s per active transfer. That is double the
serialization, double the IPC frames, and — on the frontend — two independent update paths
for the same data. The legacy emit also carries the **full** stats/progress payload (not a
diff), so it is the more expensive of the two. Per the projection-inversion memory
(regions are now authoritative and reducers/flags removed), the legacy emit is stopgap
compatibility that should be removable — marked `is_workaround`.

## Evidence
- `src-tauri/src/session/monitoring_controller.rs:184-204` — fold **and**
  `app_handle.emit("session-monitoring-stats", &event)` (line 202); status dual-write at
  lines 217-224.
- `src-tauri/src/files/transfer/mod.rs:194-196` — `fold_transfer_progress(...)` **and**
  `app.emit(TRANSFER_PROGRESS_EVENT, progress)`.
- Frontend still registers both `onSessionMonitoringStats`/`onTransferProgress`
  (`src/services/events.ts:686,804`) and the projection bridges
  (`systemMonitorBridge.ts`, `transfersBridge.ts`).

## Recommendation
- Confirm which consumers still depend on the legacy events. If the projection regions are
  the source of truth (they are, per #2376/#2387), retire the legacy `emit` calls and their
  frontend listeners so each sample serializes and crosses IPC exactly once.
- If a legacy listener is still required transitionally, gate it so it is not paid on the
  steady-state hot path. Track removal as part of closing the inversion epic (#2139).
</content>
</invoke>
