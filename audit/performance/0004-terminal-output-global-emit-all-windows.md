---
id: PERF-004
title: Terminal output is emitted as a global broadcast to every window
angle: performance
severity: medium
category: perf
is_workaround: false
subsystem: src-tauri/src/session/manager.rs
evidence:
  - src-tauri/src/session/manager.rs:181
  - src/services/events.ts:218
status: open
---

## What
Coalesced terminal output is delivered with `AppHandle::emit("terminal-output", event)` — a
**global broadcast to all webviews/windows** — rather than a targeted `emit_to`/`emit_filter`
to the window that actually owns/displays the session. Every window's `TerminalOutputDispatcher`
therefore receives, base64-decodes, and Map-routes **every session's output**, discarding
chunks for sessions it does not display.

## Why it matters
In single-window use this is harmless (one listener). In multi-window use (the app supports
"move to window" and multiple windows, #1900/#1985) it becomes O(windows) fan-out of the
app's highest-frequency event: a busy `git status`/`yes`/log tail in window A causes window
B and C to wake, decode base64, and hash-lookup the session on every batch, only to drop it.
The decode (`base64ToBytes`, a per-byte `charCodeAt` loop in `events.ts`) runs in each
non-owning window on the UI thread. With several windows each running busy sessions the
wasted decode/routing work scales with windows × total output rate.

## Evidence
- `src-tauri/src/session/manager.rs:181-183` — `fn emit_output(&self, event) -> bool { self.emit("terminal-output", event).is_ok() }` (global `emit`, not `emit_to`).
- `src/services/events.ts:218-235` — the dispatcher's single global listener decodes `base64ToBytes(data)` for every event, then routes by `session_id`; non-owning windows still pay the decode.
- Session→window ownership already exists (`session-ownership-changed`, `src/services/events.ts:163`) but is not used to target output emission.

## Recommendation
- Route output to the owning window with `emit_to(window_label, ...)` / `emit_filter`,
  keyed off the existing session→window ownership map, so only the window displaying a
  session receives its output. Fall back to broadcast only for unowned/transitional
  sessions.
- This is the same information the ownership map already tracks; wiring it into the output
  emit removes redundant decode work in every non-owning window under multi-window load.
</content>
</invoke>
