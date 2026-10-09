---
id: DOC2-008
title: 'session-lifecycle-state-machine.md ("current, authoritative reference") cites stale file:line anchors'
angle: docs-accuracy
severity: low
category: stale-reference
is_workaround: false
subsystem: "docs/session-lifecycle-state-machine.md"
status: fixed
resolution: "#4369 — lifecycle doc uses symbol-based references, verified by scripts/internal/check-doc-symbols.mjs"
audit: "2026-10"
commit: "663465d52"
relation: new
evidence:
  - docs/session-lifecycle-state-machine.md:3-6
  - docs/session-lifecycle-state-machine.md:20-26
  - core/src/connection/lifecycle.rs:43
  - src-tauri/src/session_projection/store.rs:64
  - src-tauri/src/session_projection/store.rs:144
  - src-tauri/src/session_projection/store.rs:273
  - core/src/reconnect_backoff.rs:245
  - core/src/reconnect_backoff.rs:374
  - src-tauri/src/session_projection/projection.rs:443
---

## What

The document says it is derived directly from the backend source, but most of its location table has drifted. `SessionStatus` is cited at store.rs:47-83; it is now defined at core/src/connection/lifecycle.rs:43 and only re-exported at store.rs:64. `ReconnectState` is cited at reconnect_backoff.rs:80-88 (actually :245), `SessionLifecycleStore` at store.rs:251 (actually :273), `SessionLifecycle` at store.rs:139 (actually :144), `register_session_intents` at projection.rs:389 (actually :443), and `reconnect_reducer` at reconnect_backoff.rs:185 (actually :374). Only the ReconnectTimerDriver anchor (timer.rs:153) is still right. The state and transition content itself matches the SessionStatus variants.

## Why it matters

The doc is labelled authoritative and positioned as the replacement for the historical audit snapshots. Wrong anchors send reviewers of the safety-relevant reconnect state machine to unrelated code.

## Recommendation

Update the anchors, or better, switch to symbol-based references (file + item name) that do not drift. Consider adding a docs check in the style of the existing check-testid-drift script that verifies each cited symbol exists in the cited file.

## Verification

Confirmed. SessionStatus is now defined at core/src/connection/lifecycle.rs:43, but the doc cites store.rs:47. Other actual locations: SessionLifecycle at :144 (doc says 139), SessionLifecycleStore at :273 (doc says 251), ReconnectState at :245 (doc says 80), register_session_intents at :443 (doc says 389), reconnect_reducer at :374 (doc says 185).
