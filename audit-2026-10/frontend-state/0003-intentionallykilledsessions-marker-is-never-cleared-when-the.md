---
id: FES2-003
title: "intentionallyKilledSessions marker is never cleared when the kill fails, so a later genuine drop is classified as a user kill and skips auto-reconnect"
angle: frontend-state
severity: low
category: correctness
is_workaround: false
subsystem: src/store/slices/terminalSessionStateSlice.ts
evidence:
  - src/store/slices/terminalSessionStateSlice.ts:399
  - src/store/slices/terminalSessionStateSlice.ts:406
  - src/store/slices/terminalSessionStateSlice.ts:514
  - src/store/slices/terminalSessionStateSlice.ts:388
  - src/components/Terminal/Terminal.tsx:1076
  - src/components/OpenConnections/OpenConnectionsModal.tsx:436
  - src/components/OpenConnections/OpenConnectionsModal.tsx:452
status: fixed
resolution: "#4388 — a rejected kill/detach now clears the intentional-kill marker (disconnectTerminal + Open Connections)"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

markSessionKilled(sessionId) is set before the close or detach call: in disconnectTerminal (via fireAndForget) and in the Open Connections kill handlers. The marker is removed only by consumeSessionKilled, inside the Terminal exit subscriber. When the close/detach rejects, the session stays live, but nothing clears the marker. The Open Connections handler even keeps the row 'still live' (UX-033) and leaves the marker set. Markers for sessions that have no mounted Terminal in this window are also never consumed.

## Why it matters

Later, the still-live session may drop for real (network loss). The exit handler then consumes the stale marker and classifies the exit as 'killed'. setTerminalExited then folds session.disconnect instead of session.reconnect, so a resilient tab that opted into auto-reconnect silently does not reconnect, and the overlay presents it as a user disconnect. The trigger is rare (a kill must first fail), but the effect is a missed reconnect on the reconnect hot path.

## Evidence

- `src/store/slices/terminalSessionStateSlice.ts:399`
- `src/store/slices/terminalSessionStateSlice.ts:406`
- `src/store/slices/terminalSessionStateSlice.ts:514`
- `src/store/slices/terminalSessionStateSlice.ts:388`
- `src/components/Terminal/Terminal.tsx:1076`
- `src/components/OpenConnections/OpenConnectionsModal.tsx:436`
- `src/components/OpenConnections/OpenConnectionsModal.tsx:452`

## Recommendation

Clear the marker when the kill/detach promise rejects: in disconnectTerminal, replace fireAndForget with a .catch that calls consumeSessionKilled(sessionId) and logs; in the OpenConnectionsModal failure branches, do the same for the failed ids. Optionally give markers a short TTL or drop them on session.remove so unconsumed ones cannot build up.

## Verification

Confirmed. markSessionKilled is set before the drop in disconnectTerminal (terminalSessionStateSlice.ts:514), and fireAndForget does not undo it on rejection. OpenConnectionsModal handleKillLocal and killSessions also keep the marker when closeTerminal rejects. consumeSessionKilled is called only from the Terminal exit subscriber (Terminal.tsx:1076). A later genuine exit on the same session id is then classified as killed, so setTerminalExited folds session.disconnect instead of session.reconnect. The trigger needs a failed kill first, so the rating is low.
