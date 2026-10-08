---
id: DEAD2-005
title: "Frontend comments and docs still describe removed appStore fallbacks and faithful-mirror gates; one {@link} is broken"
angle: deadcode-flags
severity: low
category: stale-docs
is_workaround: false
subsystem: "src/store, src/components, src/hooks"
evidence:
  - src/store/useSessionLifecycle.ts:18
  - src/store/useSessionLifecycle.ts:21
  - src/store/useSessionLifecycle.ts:57
  - src/hooks/useFileBrowser.ts:28
  - src/store/sessionBridge.ts:717
  - src/components/OpenConnections/OpenConnectionsModal.tsx:110
  - src/components/OpenConnections/OpenConnectionsModal.tsx:122
  - src/components/OpenConnections/OpenConnectionsModal.tsx:132
  - src/components/OpenConnections/OpenConnectionsModal.tsx:149
  - src/components/Sidebar/AgentNode.tsx:693
  - src/components/Sidebar/ConnectionList.tsx:701
  - src/components/Sidebar/ConnectionList.tsx:706
  - src/components/SplitView/SplitView.tsx:236
  - src/components/SplitView/SplitView.tsx:252
  - src/components/SplitView/SplitView.tsx:841
  - src/components/Terminal/TerminalView.tsx:291
  - src/components/StatusBar/StatusBar.tsx:570
  - src/components/Terminal/TerminalConnectionOverlay.tsx:90
  - src/components/Terminal/TerminalDisconnectOverlay.tsx:71
  - src/components/Terminal/TabBar.tsx:68
  - src/components/Sidebar/FileBrowser.tsx:1142
  - src/utils/reconnectBackoff.ts:15
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The bridge and hook modules now say plainly that they have no appStore seed, mirror gate or fallback (e.g. useProjectedAgents.ts:21, useProjectedMonitors.ts:16). About 20 call-site comments still say the data is sourced from the region 'when it faithfully mirrors appStore, else appStore verbatim' or that it 'falls back to appStore'. The useSessionLifecycle.ts header has a '# Safety — Faithful-mirror gate' section describing a fallback to the local record. It links to `projectedReconnectMirrors`, which no longer exists, and names `appStore.terminalAutoReconnect`, which was deleted in #2205 PR-B. OpenConnectionsModal.tsx:122 says tunnelStates is 'kept in sync by tunnel events', but it is fed by the tunnels projection, and those events have no listener. reconnectBackoff.ts:15 says the store's setTimeout drives the machine and calls reconnectTerminal, but that engine was removed. sessionBridge.ts:717 is still headed 'Render cut: faithful-mirror gate'. DEAD-011 fixed the same problem in the Rust module headers; this is the frontend counterpart.

## Why it matters

These comments describe a safety net that is gone. Someone debugging a blank or stale panel will look for an appStore fallback that does not exist, or will assume the region failing is harmless because the code 'falls back'. The broken {@link} also shows up in typedoc and IDE hovers.

## Evidence

- `src/store/useSessionLifecycle.ts:18`
- `src/store/useSessionLifecycle.ts:21`
- `src/store/useSessionLifecycle.ts:57`
- `src/hooks/useFileBrowser.ts:28`
- `src/store/sessionBridge.ts:717`
- `src/components/OpenConnections/OpenConnectionsModal.tsx:110`
- `src/components/OpenConnections/OpenConnectionsModal.tsx:122`
- `src/components/OpenConnections/OpenConnectionsModal.tsx:132`
- `src/components/OpenConnections/OpenConnectionsModal.tsx:149`
- `src/components/Sidebar/AgentNode.tsx:693`
- `src/components/Sidebar/ConnectionList.tsx:701`
- `src/components/Sidebar/ConnectionList.tsx:706`
- `src/components/SplitView/SplitView.tsx:236`
- `src/components/SplitView/SplitView.tsx:252`
- `src/components/SplitView/SplitView.tsx:841`
- `src/components/Terminal/TerminalView.tsx:291`
- `src/components/StatusBar/StatusBar.tsx:570`
- `src/components/Terminal/TerminalConnectionOverlay.tsx:90`
- `src/components/Terminal/TerminalDisconnectOverlay.tsx:71`
- `src/components/Terminal/TabBar.tsx:68`
- `src/components/Sidebar/FileBrowser.tsx:1142`
- `src/utils/reconnectBackoff.ts:15`

## Recommendation

Do a sweep: replace each '(falls back to appStore …)' or 'faithfully mirrors appStore, else appStore verbatim' comment with 'sourced from the authoritative <domain> region'. Rewrite the useSessionLifecycle.ts header and its useSessionAutoReconnect doc, and drop the projectedReconnectMirrors link. Fix useFileBrowser.ts:28-30, OpenConnectionsModal.tsx:122-124, reconnectBackoff.ts:5-16 and the sessionBridge.ts:717 heading. An ESLint no-restricted-syntax rule, or a grep in CI for 'else `appStore` verbatim', would stop it coming back.

## Verification

Confirmed. useSessionLifecycle.ts:21 has {@link projectedReconnectMirrors}, and that symbol is not defined anywhere. appStore.ts no longer has a terminalAutoReconnect field, yet the comments still name it. 17 non-test comment lines still say 'faithfully mirrors'/'falls back to appStore'. OpenConnectionsModal.tsx:122 still says 'kept in sync by tunnel events'. The reconnectBackoff.ts header and the sessionBridge.ts:717 heading still describe the removed engine and gate. These are stale docs only, with no runtime effect.
