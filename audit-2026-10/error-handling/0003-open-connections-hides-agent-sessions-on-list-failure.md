---
id: ERR2-003
title: "Open Connections hides an agent's live sessions when listing them fails, and 'kill all agents' gives no feedback on failure"
angle: error-handling
severity: low
category: silent-failure
is_workaround: false
subsystem: "src/components/OpenConnections/OpenConnectionsModal.tsx"
evidence:
  - src/components/OpenConnections/OpenConnectionsModal.tsx:249
  - src/components/OpenConnections/OpenConnectionsModal.tsx:251
  - src/components/OpenConnections/OpenConnectionsModal.tsx:987
  - src/components/OpenConnections/OpenConnectionsModal.tsx:988
  - src/components/OpenConnections/OpenConnectionsModal.tsx:508
  - src/components/OpenConnections/OpenConnectionsModal.tsx:509
  - src/components/OpenConnections/OpenConnectionsModal.tsx:589
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: new
---

## What

loadData() fetches each agent's sessions with `listAgentSessions(a.id).catch(() => [])` (line 251). If that call fails (timeout, agent busy, or a transport blip), the agent is recorded as having zero sessions, and the 'Sessions on <agent>' section is not rendered at all (`if (sessions.length === 0) return null`, line 988). Nothing is logged and no toast is shown.
handleKillAllAgents (line 508) uses `await Promise.all(connectedAgents.map(disconnectRemoteAgent))` with no catch and no toast. Its sibling handlers, such as handleKillAllAgentSessions at 589, use Promise.allSettled and report failures through frontendError and toast.

## Why it matters

Open Connections is where users go to find and stop what is still running. If it silently drops live sessions on an agent, the user may wrongly conclude nothing is running there and leave remote shells or processes alive. If a bulk disconnect partly fails, the user gets no signal, and the only trace is a generic unhandled-rejection log. Both behaviours break the 'no silent failure' rule that ERR-002 and ERR-008 established.

## Recommendation

1. Record a per-agent load error instead of [], for example an agentSessionErrors map. Render the agent's section with an inline 'Could not list sessions: <reason>' row and a retry button, and log it via frontendError.
2. Change handleKillAllAgents to Promise.allSettled with the same failure counting, toast and frontendError pattern as handleKillAllAgentSessions.

## Verification

Half confirmed. The listing part is real. OpenConnectionsModal.tsx:251 uses `listAgentSessions(a.id).catch(() => [])` with no log, and line 988 then hides the agent's section, so live sessions disappear silently. The kill-all part is refuted. handleKillAllAgents calls the store's disconnectRemoteAgent (agentsSlice.ts:345), which catches each error itself, logs it with frontendLog and shows toast.error. Promise.all never rejects there and failures are reported. Low, for the listing half only.
