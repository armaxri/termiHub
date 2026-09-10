---
id: SM-004
title: Client wall-clock connect deadline force-fails direct resilient tabs while the backend is still legitimately reconnecting
angle: state-machine-ux
severity: medium
category: bug
is_workaround: false
subsystem: src/store/appStore.ts + src-tauri/src/session_projection/redrive.rs
evidence:
  - src/store/appStore.ts:5980
  - src/store/appStore.ts:5723
  - src-tauri/src/session_projection/redrive.rs:1
  - src/utils/reconnectBackoff.ts:51
status: open
---

## What
`reconnectTerminal` clears the per-client wall-clock connect deadline **only** for
`isBackendDrivenAgentReconnectTabId` tabs (`appStore.ts:5980,5999-6007`). A **direct**
resilient SSH tab keeps a ~90s `connecting` deadline armed while the backend redrive
(`redrive.rs`) legitimately backs off up to `maxDelayMs=30s × maxAttempts=10`
(`reconnectBackoff.ts:51-57`, i.e. minutes). When the deadline fires,
`failTerminalConnectTimeout` (`appStore.ts:5723-5749`) writes a client spawn-error overlay
over a region that is still authoritatively `reconnecting`.

## Why it matters
Two truths for the same tab: the backend says "reconnecting, still trying" while the
frontend paints "connect timed out". The user sees a competing/wrong error overlay on top of
a healthy in-progress reconnect, and may act on the false failure (close the tab, retry)
while the backend loop is still succeeding underneath. This is exactly the optimistic-client
vs authoritative-backend disagreement the projection migration was meant to remove — a
residual client-authoritative timer on the reconnect hot path.

## Evidence
- `appStore.ts:5980,5999-6007` — deadline cleared only for backend-driven agent reconnect
  tabs, not direct resilient tabs.
- `appStore.ts:5723-5749` — `failTerminalConnectTimeout` overlays a spawn-error regardless of
  region status.
- `reconnectBackoff.ts:51-57` — backend backoff can legitimately exceed the client deadline.

## Recommendation
Make the backend region the single authority for reconnect timing on **all** resilient tabs
(direct and agent-hosted): clear/suppress the client wall-clock deadline whenever the region
is `reconnecting`, or drive the client deadline from the backend's remaining-backoff budget
so it can never fire under an active backend loop.
