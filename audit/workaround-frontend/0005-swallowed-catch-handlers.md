---
id: WA-FE-005
title: ~40 async calls swallow errors with `.catch(() => {})`
angle: workaround-frontend
severity: medium
category: workaround
is_workaround: true
subsystem: components / hooks / store (widespread)
evidence:
  - src/store/appStore.ts:1901
  - src/store/appStore.ts:1916
  - src/store/appStore.ts:6204
  - src/components/OpenConnections/OpenConnectionsModal.tsx:295
  - src/components/Terminal/Terminal.tsx:1051
  - src/hooks/useConnectSavedConnection.ts:172
  - src/components/Sidebar/AgentNode.tsx:873
status: in-progress
resolution: "#2732 — critical catches fixed; low-impact remainder #2733"
---

## What
About 40 production call sites attach a no-op rejection handler, `.catch(() => {})`, to async
operations — many on genuinely important paths (closing sessions, detaching persistent tabs,
disconnecting agents, cancelling connects, removing credentials). Example:

```ts
apiDetachPersistentTab(sessionId, tab.id).catch(() => {});   // appStore.ts:1916
apiCloseTerminal(sessionId).catch(() => {});                 // appStore.ts:1918
apiDisconnectAgent(agentId).catch(() => {});                 // appStore.ts:6204
removeCredential(agent.id, resolution.credentialType).catch(() => {}); // AgentNode.tsx:873
```

## Why it matters
- A silently-swallowed rejection means a failed cleanup (session not actually closed, credential
  not actually removed, agent not actually disconnected) produces **no log, no toast, no trace**.
  For a tool whose CLAUDE.md mandates "every action gives feedback" and routes all diagnostics to
  the in-app LogViewer, `() => {}` is the opposite: it defeats both the feedback rule and the
  LogViewer debugging story. Connection/credential-leak investigations start blind.
- Some of these are legitimately fire-and-forget best-effort (e.g. `openUrl().catch`, fullscreen
  toggles), but they are indistinguishable at a glance from the ones that hide a real failure —
  the blanket pattern is the problem.

## Evidence
Representative sites listed above; full set (~40) spans `store/appStore.ts` (1901, 1916, 1918,
3442-3443, 3877, 6204), `OpenConnections/OpenConnectionsModal.tsx` (295-498, many),
`Terminal/Terminal.tsx` (1051, 1505), `Terminal/FileBrowserTab.tsx` (73, 99),
`hooks/useConnectSavedConnection.ts` (172), `hooks/useSessionFileSystem.ts` (330),
`hooks/useRemoteDesktopSession.ts` (153/206/303), `Sidebar/AgentNode.tsx` (873),
`RecentSessionsSidebar/RecentSessionsSidebar.tsx` (120), and others.

## Recommendation
Replace `.catch(() => {})` with `.catch((err) => frontendLog("<module>", ...))` at minimum so
failures are visible in the LogViewer, and surface a recoverable error (toast) on user-initiated
mutating actions (close/disconnect/remove-credential). Keep a genuinely-inert best-effort only
where losing the result is truly harmless, and make that explicit with a named helper
(`fireAndForget(promise, "reason")`) so intentional swallowing is auditable and the accidental
kind stops looking identical.
