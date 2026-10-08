---
id: SM2-002
title: "The agent-recovery folds for lost, unconfirmed, failed and transport-break ignore the tab's current status, so a user Stop is overwritten and an ended tab can come back"
angle: state-machine-ux
severity: medium
category: bug
is_workaround: false
subsystem: src-tauri/src/terminal/agent_manager/recovery.rs + src-tauri/src/session_projection/store.rs
evidence:
  - src-tauri/src/terminal/agent_manager/recovery.rs:50
  - src-tauri/src/terminal/agent_manager/recovery.rs:71
  - src-tauri/src/terminal/agent_manager/recovery.rs:126
  - src-tauri/src/terminal/agent_manager/recovery.rs:137
  - src-tauri/src/terminal/agent_manager/recovery.rs:227
  - src-tauri/src/session_projection/store.rs:580
  - src-tauri/src/session_projection/store.rs:815
  - src-tauri/src/session_projection/store.rs:824
  - src-tauri/src/session_projection/store.rs:360
  - src-tauri/src/session_projection/projection.rs:554
  - src/store/slices/terminalSessionStateSlice.ts:576
  - src-tauri/src/session/manager.rs:1504
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: previous-incomplete
previous_id: SM-002
---

## What

The SM-002 fix added a `still_reconnecting` guard only to the recovered-in-place branch
(recovery.rs:126). The sibling folds that run on the same agent transport break still fold
whatever status the tab has: `fold_agent_session_lost` (recovery.rs:137, session not in
live_ids), `fold_agent_session_unconfirmed` (recovery.rs:227, connection.list None, applied
to every hosted tab), `fold_agent_reconnect_failed` (recovery.rs:71, the agent loop gave up)
and `fold_agent_transport_reconnecting` (recovery.rs:50, a new break). Their store methods
(`session_lost` store.rs:815, `connect_failed` :360, `agent_transport_reconnecting` :580)
guard only Evicted and unknown ids. The comment at store.rs:824 says 'its callers guard on
the live reconnecting state', which is false for the agent callers. Meanwhile, Stop during a
transport break (`cancelAutoReconnect` → `session.cancelReconnect`,
terminalSessionStateSlice.ts:576) folds `Disconnected(User)` and clears the retained request
(projection.rs:554). It does not close the backend session, so the tab stays in
`agent_hosted_sessions` (manager.rs:1504). Resulting sequences: (a) Stop, then the list is
unavailable or the session is absent → the tab is relabelled `SessionLost`; (b) Stop, then
the agent gives up → the tab is relabelled `Failed` with the reconnect error; (c) a tab
settled `SessionLost` or `Disconnected(User)` whose backend session is still registered
(case a, and every unconfirmed tab) is folded back to `Reconnecting` on the next transport
break. If the session is listed live at that recovery, `still_reconnecting` passes and it
folds `Connected`. That is the SM-002 resurrection, reached in two steps. In the None branch
the cancelled tab's agent session is also never torn down, unlike the SM-002 teardown on the
live branch.

## Why it matters

The user's Stop is not deterministic on the agent reconnect hot path. The overlay switches
from the chosen 'Disconnected' to 'Session lost' or 'Reconnect failed'. A session the user
abandoned, or one the UI declared lost, can later bring itself back to Connected and start
streaming again. Remote shells the user stopped keep running on the agent with no holder.
The same invariant SM-002 established ('a user-stopped tab never self-reverts') holds on only
one of the four agent folds.

## Evidence

- `recovery.rs:126` — only the live-recovered branch checks `still_reconnecting`.
- `recovery.rs:50,71,137,227` — the other four folds run unguarded.
- `store.rs:360,580,815` — store methods guard only Evicted/unknown; `store.rs:824` comment is wrong for agent callers.
- `projection.rs:554`, `terminalSessionStateSlice.ts:576` — Stop folds Disconnected(User) without closing the backend session.
- `manager.rs:1504` — the tab stays in `agent_hosted_sessions`.

## Recommendation

Apply one guard to all agent-source folds. `fold_agent_session_lost`,
`fold_agent_session_unconfirmed` and `fold_agent_reconnect_failed` should act only while the
tab is `Reconnecting`. Make `agent_transport_reconnecting` act only on `Connected` (or
`Connecting`), never on terminal statuses. A better option is to put these guards in the
store methods (e.g. `session_lost_if_reconnecting`) so every caller inherits them, and fix
the comment at store.rs:824. For tabs found not `Reconnecting` (user-cancelled), tear down
the backend/agent session as the SM-002 branch does (`manager.close_session`), including in
the None/unconfirmed branch. Alternatively, have `session.cancelReconnect` for an
agent-hosted tab close its backend session so it leaves `agent_hosted_sessions`. Add
RED→GREEN tests: Stop during break + list None → stays Disconnected(User), session closed;
Stop + agent give-up → stays Disconnected(User); SessionLost tab + new break → not refolded
to Reconnecting.

## Verification

Confirmed in the code. Only the live-recovered branch of `resolve_agent_hosted_sessions`
checks `still_reconnecting`; the absent-session, None/unconfirmed, give-up and new-break folds
run for every tab in `agent_hosted_sessions` unchecked. `agent_transport_reconnecting` is
worse: it uses `entry().or_insert_with`, so it could recreate the entry for a removed tab if
the session were still registered. `session.cancelReconnect` only folds Disconnected(User)
and clears the retained request; the overlay's Stop button just calls `cancelAutoReconnect`.
No ADR or audit entry declares this deliberate. Medium, not high: it needs a user Stop during
an agent transport break followed by a specific recovery outcome or a second break.
