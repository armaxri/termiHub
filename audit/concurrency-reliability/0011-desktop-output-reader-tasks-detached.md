---
id: CONC-011
title: Desktop session output-reader tasks are detached with no direct cancellation
angle: concurrency-reliability
severity: low
category: reliability
is_workaround: false
subsystem: src-tauri/session/manager
evidence:
  - src-tauri/src/session/manager.rs:920
  - src-tauri/src/session/manager.rs:1657
  - src-tauri/src/session/persistent_controller.rs:319
  - src-tauri/src/session/manager.rs:1871
  - src-tauri/src/session/manager.rs:1134
status: open
---

## What

The desktop `SessionManager` spawns per-session output-reader tasks fire-and-forget at
`manager.rs:920` (create), `:1657` (re-attach), and `persistent_controller.rs:319` (post-reconnect
re-create). The `SessionEntry` stores no `JoinHandle` for them, so there is no direct `.abort()`.
Each task runs an infinite `while let Some(chunk) = output_rx.recv().await` loop (`:1871`) holding
the session's capture `RingBuffer` and logger handles.

## Why it matters

Shutdown is indirect: `close_session` removes the `SessionEntry` (`:1134`), dropping the connection
and its output sender, which closes `output_rx` and ends the loop. Correct on the normal path — but
it relies entirely on *no clone of the output sender outliving the entry*. If any sender clone
lingers (a backend that keeps a producer handle, a reconnect that re-creates the reader without the
old one's sender having dropped), the reader lingers holding the capture buffer with no way to force
it down. This is a latent leak rather than an active one; the risk grows with the reconnect/re-attach
paths that spawn a *fresh* reader (`:1657`, `persistent_controller.rs:319`) — if the prior reader's
sender is not guaranteed dropped first, two readers can briefly coexist on one session.

## Evidence

`SessionEntry` has no reader-task field; grep shows no `.abort()` for these tasks. Termination is
purely via sender-drop-on-entry-removal.

## Recommendation

Store the reader `AbortHandle` on `SessionEntry` and abort it in `close_session` and before
re-spawning on re-attach/reconnect, so teardown is deterministic and a re-attach cannot leave a
stale reader behind. Low severity because the normal close path drops the sender, but the reconnect
re-spawn paths make an explicit handle worthwhile.
</content>
