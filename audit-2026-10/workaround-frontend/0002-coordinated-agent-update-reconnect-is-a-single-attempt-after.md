---
id: WA-FE2-002
title: "Coordinated agent-update reconnect is a single attempt after a hardcoded 5s+3s delay, with no retry"
angle: workaround-frontend
severity: medium
category: workaround
is_workaround: true
subsystem: "store/slices/agentsSlice (agent update coordination)"
evidence:
  - src/store/slices/agentsSlice.ts:128
  - src/store/slices/agentsSlice.ts:180
  - src/store/slices/agentsSlice.ts:183
  - src/store/slices/agentsSlice.ts:184
  - src/store/slices/agentsSlice.ts:189
  - src/store/slices/agentsSlice.ts:196
  - agent/src/handler/dispatch.rs:2705
  - agent/src/handler/dispatch.rs:2766
status: fixed
resolution: "#4311 — update reconnect retries with jittered backoff to a 120s deadline, cancellable, with a manual Reconnect on failure"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

When another host announces a coordinated agent update (`agent.update_pending`), `handleAgentUpdatePending` explicitly disconnects the agent and arms one `setTimeout` of `(estimatedRestartSecs + 3) * 1000`. The agent always sends a hardcoded `ESTIMATED_RESTART_SECS = 5` (dispatch.rs:2705), so the wait is about 8s. The timer then calls `connectRemoteAgent` exactly once. If that call fails (the agent is still verifying or swapping the binary, a slow host, or the requester's ack wait has not finished), the toast becomes `Couldn't reconnect … after the update.` and nothing retries. Because the disconnect was explicit, the backend's resilient redrive does not take over. On success, the toast says `reconnected to the updated version` even if the deferred update has not been applied yet.

## Why it matters

This is a wall-clock guess standing in for a readiness signal, on a flow where every agent-hosted session on this host is suspended. Any restart longer than about 8s leaves all of this host's agent tabs disconnected until the user notices and reconnects manually. A safety-critical terminal should not depend on a fixed 5-second estimate.

## Evidence

- `src/store/slices/agentsSlice.ts:128`
- `src/store/slices/agentsSlice.ts:180`
- `src/store/slices/agentsSlice.ts:183`
- `src/store/slices/agentsSlice.ts:184`
- `src/store/slices/agentsSlice.ts:189`
- `src/store/slices/agentsSlice.ts:196`
- `agent/src/handler/dispatch.rs:2705`
- `agent/src/handler/dispatch.rs:2766`

## Recommendation

Replace the one-shot timer with a bounded backoff reconnect loop, for example the existing `reconnectBackoff` util. Start at the estimate and keep retrying until a cap such as 60–120s, re-checking `agentUpdatePending` on each attempt. Better still, hand the reconnect to the backend redrive by marking the disconnect as update-suspended rather than user-initiated. Only claim 'updated version' after comparing the reconnected agent's reported version with `requestedByVersion`.

## Verification

Confirmed. In agentsSlice.ts:150-200, handleAgentUpdatePending explicitly disconnects, then sets one setTimeout of (max(est,1)+3)\*1000 and calls connectRemoteAgent once. On failure it shows a toast.error and never retries. dispatch.rs:2705 hardcodes ESTIMATED_RESTART_SECS=5, and its own comment says 'nothing waits on it'. The slice comment notes the agent only restarts after every host disconnects or a 10s window closes. So with a slow or non-acking peer, the reconnect at about 8s can land on the old process (the 'updated version' toast is then false) or fail and stay down. No backoff exists, and the explicit disconnect bypasses redrive.
