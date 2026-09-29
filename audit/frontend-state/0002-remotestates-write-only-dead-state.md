---
id: FES-002
title: remoteStates map is write-only dead state — fed on every session event, read by nothing
angle: frontend-state
severity: medium
category: workaround
is_workaround: true
subsystem: src/store/appStore
evidence:
  - src/store/appStore.ts:1218
  - src/store/appStore.ts:6042
  - src/components/Terminal/TerminalView.tsx:78
  - src/components/Terminal/TerminalView.tsx:133
  - src/utils/tabStatus.ts:4
status: fixed
resolution: "#2730"
---

## What
The store carries an untyped `remoteStates: Record<string, string>` map
(`appStore.ts:1218`) with a `setRemoteState(sessionId, state)` writer
(`appStore.ts:6042-6044`). It is written on **every** session-state event, in two places
in `TerminalView` (`:78` and, per active-session tab, `:133`). **Nothing in the codebase
ever reads it** — a whole-repo search finds only the type declaration, the initializer,
and the two write sites; no selector, component, or util consumes the value.

The status indicator it was meant to feed has moved: `tabStatus.ts:4-7` documents that
the per-tab status is now derived from the `tabId`-keyed lifecycle maps, and explicitly
calls `remoteStates` "the **legacy** `remoteStates` map, which is keyed by `session_id`
and fed by a **never-firing event**."

## Why it matters
1. **Dead state that must be deleted before release.** It is a stopgap left over from the
   projection inversion. Keeping it invites a future reader to wire it back to the stale,
   session-id-keyed, string-typed source that `tabStatus` was written to replace — a
   regression to the "lying status dot" class of bug.
2. **Spurious writes / re-renders.** Every session-state event still calls `set(...)` to
   grow/replace this map. Any store subscriber that is not perfectly selector-scoped
   re-renders on each of these writes for zero benefit, on a hot path (per-tab, per state
   transition).
3. **Untyped.** `Record<string, string>` accepts any backend state string, so if it were
   ever read it would provide no exhaustiveness or correctness guarantee — the opposite of
   the typed lifecycle maps that replaced it.

## Evidence
- `src/store/appStore.ts:1218-1219` — `remoteStates: Record<string, string>` +
  `setRemoteState` signature.
- `src/store/appStore.ts:6042-6044` — initializer and the only writer.
- `src/components/Terminal/TerminalView.tsx:78,133` — the two call sites; `:129-134`
  comment claims it keeps the "compact tab-strip dot" in agreement, but the dot no longer
  reads this map.
- `src/utils/tabStatus.ts:4-7` — documents `remoteStates` as legacy, session-id-keyed, fed
  by a never-firing event; status is now `tabId`-derived.

## Recommendation
Delete `remoteStates`, `setRemoteState`, and both `TerminalView` write sites. Confirm
`tabStatus`-derived status covers every case the two write sites intended (the agent
drop/reconnect dot). Add nothing back; if a session-id-keyed view is ever needed, source it
from the authoritative session-lifecycle region, not a hand-fed string map.
