---
id: SM-003
title: Session region keyed by per-client tab id violates its own "shared status" invariant; multi-desktop eviction leaves desktops permanently disagreeing
angle: state-machine-ux
severity: high
category: bug
is_workaround: false
subsystem: src-tauri/src/session_projection + agent/src/registry_daemon
evidence:
  - src-tauri/src/session_projection/store.rs:16
  - src-tauri/src/session_projection/projection.rs:11
  - src/store/sessionBridge.ts:20
  - agent/src/registry_daemon/mod.rs:6
status: open
---

## What
The session lifecycle region's module docs assert it is shared so that "two clients
observing the same session see the same status" (`store.rs:16-21`, `projection.rs:11-16`).
But the region is keyed by the **frontend tab id** (`sessionBridge.ts:20-22`,
`store.rs:227`), which is per-window / per-desktop, not the backend/daemon session id. Two
desktops attached to the same persistent session therefore maintain **independent** region
entries that never reconcile. Meanwhile the daemon enforces single-attach: a second attach
**evicts** the first (`agent/src/registry_daemon/mod.rs:6-8`; daemon takeover in
`process.rs`).

## Why it matters
Interleaving: desktop B attaches → daemon evicts desktop A's worker → desktop A's transport
EOFs → desktop A folds `session.dropped`/`reconnect` (→ Disconnected / stuck Reconnecting)
while desktop B folds `Connected`. Desktop A shows an unexpected disconnect or a
never-resolving reconnect the user never caused (its session was silently stolen), and
because the region is keyed by tab id rather than the shared session, the two desktops can
**never** converge to the same status — directly contradicting the module's stated
invariant. This is a data-integrity / stuck-state defect on the multi-client path the
projection substrate was introduced to make correct.

## Evidence
- `store.rs:16-21`, `projection.rs:11-16` — doc-comment claims cross-client shared status.
- `sessionBridge.ts:20-22`, `store.rs:227` — region key is the frontend tab id.
- `agent/src/registry_daemon/mod.rs:6-8` — "a second attach evicts the first" single-attach
  policy; no eviction event is surfaced to the evicted desktop as a distinct state.

## Recommendation
Decide the intended multi-desktop contract with the maintainer. If cross-desktop shared
status is in scope, key the shared region by the backend/daemon session id (not tab id) so
both desktops observe one entry. If single-attach eviction is intended, model an explicit
`Evicted`/"taken over elsewhere" terminal state and surface it to the evicted desktop
instead of an ambiguous drop/stuck-reconnect, and fix or remove the doc-comment invariant so
code and spec agree.
