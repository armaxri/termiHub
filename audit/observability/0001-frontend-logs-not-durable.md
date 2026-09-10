---
id: OBS-001
title: Frontend logs never reach the durable file or backend — LogViewer is in-memory only
angle: observability
severity: high
category: reliability
is_workaround: false
subsystem: src/utils/frontendLog.ts, src-tauri/src/utils/file_log.rs
evidence:
  - src/utils/frontendLog.ts:32
  - src/components/LogViewer/LogViewer.tsx:63
  - src-tauri/src/utils/log_capture.rs:20
  - src-tauri/src/utils/file_log.rs:81
status: in-progress
resolution: "#2727 — channel merged; durable backend forwarding in #2731-era B19"
---

## What
`frontendLog()` is a pure in-JS publish/subscribe: it builds a `LogEntry` and delivers it
to in-memory listeners (the LogViewer) only. Nothing forwards frontend events to the Rust
`tracing` pipeline, so **the durable application log file (`termihub.log`) contains zero
frontend events**, and every frontend log entry is lost the moment the window closes. The
LogViewer merges backend events (from the `log-entry` Tauri event) with frontend entries
purely in React state — there is no persistence and no round-trip to the backend sink.

This is the single biggest field-support gap: the entire UI tier — including the ~40
swallowed-error paths other experts flagged, all of which are being routed through
`frontendLog` per the "no console.error" policy — produces diagnostics that never land in
the file a user is asked to paste into a bug report.

## Why it matters
- A supporter handed the shipped `termihub.log` sees the backend's half of a failure and
  **nothing of what the user actually saw or did** in the UI.
- Failures that are purely frontend (teardown initiated from the UI, a store action that
  caught and logged via `frontendLog`, a render error) are invisible post-mortem.
- The `frontend=debug` directive in `DEFAULT_LOG_DIRECTIVE`
  (`log_capture.rs:20`) is effectively **dead config** — it admits `frontend::*` targets
  into the ring buffer, but no `frontend::*` event is ever emitted from Rust, so it only
  ever matches the client-side entries that never enter the Rust pipeline in the first
  place. This creates a false impression that frontend logs are captured.
- The file-log module's own rationale (`file_log.rs` header) is "the app must leave
  evidence of what it was doing after the process is gone" — that guarantee is only half
  met while the frontend tier is excluded.

## Evidence
`src/utils/frontendLog.ts:32` — emits only to in-JS listeners / startup buffer:
```ts
export function frontendLog(target: string, message: string) {
  const entry: LogEntry = { timestamp: new Date().toISOString(), level: "DEBUG",
    target: `frontend::${target}`, message };
  if (listeners.length === 0) { /* startupBuffer */ } else { for (const cb of listeners) cb(entry); }
}
```
`LogViewer.tsx:63-64` — LogViewer subscribes to backend `onLogEntry` and frontend
`onFrontendLog` and merges them in React state; on unmount everything is discarded.
Grep confirms **no** Tauri command ingests frontend logs into the backend (no
`frontend_log`/`append_log`/`ingest_log` command exists).

## Recommendation
Add a lightweight Tauri command (e.g. `record_frontend_log(entry)`) that `frontendLog`
also calls (fire-and-forget, batched/throttled), which re-emits the entry into the Rust
`tracing` pipeline at the appropriate level under the `frontend::<target>` target. It then
flows through the existing ring buffer **and** the durable file sink for free, and the
`frontend=debug` directive becomes real. Keep the client-side fast path for the live
LogViewer; the command is only for durability. Ensure the frontend level is mapped so
INFO/WARN/ERROR frontend events reach the INFO-filtered file (today all frontend entries
are hardcoded `DEBUG`, which the file filter would drop anyway — see OBS-005/OBS-007).
