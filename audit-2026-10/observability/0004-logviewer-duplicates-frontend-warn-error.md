---
id: OBS2-004
title: "LogViewer shows, copies and saves every frontend WARN/ERROR twice"
angle: observability
severity: low
category: diagnostics-ux
is_workaround: false
subsystem: "src/components/LogViewer, src/utils/frontendLog.ts, src-tauri/src/commands/logs.rs"
evidence:
  - src/utils/frontendLog.ts:37
  - src/utils/frontendLog.ts:108
  - src/components/LogViewer/LogViewer.tsx:37
  - src/components/LogViewer/LogViewer.tsx:64
  - src/components/LogViewer/LogViewer.tsx:65
  - src-tauri/src/commands/logs.rs:96
  - src-tauri/src/utils/log_capture.rs:20
  - src-tauri/src/utils/log_capture.rs:231
status: open
resolution: ""
audit: 2026-10
commit: "663465d52"
relation: new
---

## What

emitFrontendLog sends each entry to the LogViewer's onFrontendLog listener (target `frontend::<x>`) and also forwards ERROR/WARN through record_frontend_log (frontendLog.ts:37/108). The backend re-emits the forwarded entry under target `frontend` with message `[<x>] ...`. That target passes the ring-buffer filter (`frontend=debug`, log_capture.rs:20), so LogCaptureLayer pushes it into the ring buffer and emits it as a `log-entry` event (log_capture.rs:231). The LogViewer subscribes to both onLogEntry and onFrontendLog (LogViewer.tsx:64-65), and on mount it also loads the ring buffer, which already holds the forwarded copies, alongside the startup-buffer flush. Each frontend warning or error therefore appears twice, with two different target and message formats, and both copies end up in Copy All and Save.

## Why it matters

Bug-report exports double-count frontend failures, which misleads anyone reading a sequence of events. The duplicates also use up the viewer's MAX_ENTRIES window twice as fast, pushing older backend context out.

## Recommendation

Show each entry once. Either drop backend entries whose target is exactly `frontend` in the LogViewer (the live listener already has the richer copy), or stop sending forwarded ERROR/WARN to the local listener once forwarding succeeds. The first is simpler and still covers entries recorded before the viewer mounted. Add a LogViewer test that one frontendError yields exactly one row.

## Verification

Confirmed. emitFrontendLog sends each entry to the local listeners and also, through forwardToDurableLog, to record_frontend_log, which re-emits it under target `frontend`. The `frontend=debug` directive keeps that copy, and LogCaptureLayer emits it as log-entry. LogViewer subscribes to both onLogEntry and onFrontendLog with no dedupe, so each frontend WARN/ERROR appears twice.
