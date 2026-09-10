---
id: SM-011
title: Tab-strip status dot renders from an untyped remoteStates map that is blind to sessionLost/failed
angle: state-machine-ux
severity: high
category: bug
is_workaround: false
subsystem: src/store/appStore.ts (remoteStates) + src/components/Tab*
evidence:
  - src/store/appStore.ts:1218
  - src/store/appStore.ts:6042
  - src/components/Terminal/TerminalView.tsx:128
  - src-tauri/src/session_projection/store.rs:63
status: open
---

## What
The tab-strip status dot renders from `remoteStates` — an **untyped `Record<string,string>`**
(`appStore.ts:1218`) written by a plain reducer `setRemoteState` (`:6042-6044`) that was never
migrated to a projection region. It is populated either with a dead vocabulary (direct
SSH/telnet never emit `remote-state-change`, `TerminalView.tsx:65-72`) or a verbatim copy of
the agent transport's 4 strings (`Disconnected|Connecting|Connected|Reconnecting`,
`TerminalView.tsx:128-134`). It has **no knowledge of the richer session-lifecycle states**
`SessionLost` and `Failed` (`session_projection/store.rs:63-72`) — no `setRemoteState` call
exists on those paths.

## Why it matters
When an agent recovers its transport but a specific shell session does not
(`SessionStatus::SessionLost`), the terminal body correctly shows the SessionLost overlay,
but the **tab-strip dot stays on the last agent-transport string — often green/"connected"**.
The compact indicator the user scans across many tabs actively lies about which sessions are
alive. This is the exact "two truth sources, the compact indicator lies" defect (old agent
G5) reborn against the newer 6-state session machine, on the safety-critical is-this-session-
live signal.

## Evidence
- `appStore.ts:1218` — `remoteStates` is an untyped string map, never a region.
- `appStore.ts:6042-6044` — `setRemoteState` plain reducer.
- `TerminalView.tsx:128-134` — writes only the agent's 4-value transport string.
- `session_projection/store.rs:63-72` — `SessionLost`/`Failed` exist but never reach the dot.

## Recommendation
Render the tab dot from the authoritative `session-lifecycle` region (which knows
`SessionLost`/`Failed`) and retire the `remoteStates` map entirely. This also removes one of
the three parallel reconnect vocabularies (see SM-020).
