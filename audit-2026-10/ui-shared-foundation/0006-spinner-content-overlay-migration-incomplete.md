---
id: UISF2-006
title: "Spinner/ContentOverlay migration incomplete: overlays still hand-roll Loader2 + per-component spin classes; FileBrowserTab re-implements the overlay without a live region"
angle: ui-shared-foundation
severity: low
category: ui
is_workaround: false
subsystem: "src/components/Terminal, src/components/RemoteDesktop"
status: open
resolution: ""
audit: "2026-10"
commit: "663465d52"
relation: previous-incomplete
previous_id: UISF-001
evidence:
  - src/components/Terminal/TerminalConnectionOverlay.tsx:188
  - src/components/Terminal/TerminalConnectionOverlay.tsx:206
  - src/components/Terminal/TerminalConnectionOverlay.tsx:261
  - src/components/Terminal/TerminalConnectionOverlay.tsx:321
  - src/components/Terminal/TerminalDisconnectOverlay.tsx:293
  - src/components/RemoteDesktop/RemoteDesktopOverlay.tsx:43
  - src/components/RemoteDesktop/RemoteDesktopOverlay.tsx:57
  - src/components/Terminal/FileBrowserTab.tsx:131
  - src/components/Sidebar/ConnectionPathDialog.tsx:43
  - src/components/Terminal/TerminalConnectionOverlay.css:28
  - src/components/Terminal/FileBrowserTab.css:57
  - src/components/RemoteDesktop/RemoteDesktopTab.css:141
  - src/components/Terminal/AgentErrorTab.css:71
  - src/components/Sidebar/ConnectionPathDialog.css:81
---

## What

ui/Spinner exists, and its docstring says to use it instead of `<Loader2 className="…__spin">` plus a per-component spin class. The busy states of the shared ContentOverlay still receive hand-rolled spinners: TerminalConnectionOverlay ×4, TerminalDisconnectOverlay, and the RD reconnecting state, each with its own `--spin` CSS. RemoteDesktopOverlay even mixes the two: connecting uses `<Spinner>` (:43), reconnecting uses a hand-rolled RefreshCw spin (:57). FileBrowserTab hand-builds the full overlay skeleton (icon + heading + hint + action) instead of ContentOverlay. Its connecting/error phases therefore have no `role=status`/live region, while ContentOverlay's `busy` provides one.

## Why it matters

Six or more per-component spin keyframe/size classes remain, so reduced-motion behaviour (#4039) has to be kept in sync per site. The FileBrowserTab 'Connecting…'/'Could not open connection' states are not announced to screen readers, unlike every other connection overlay. This is what changed since UISF-001/UISF-008 were closed: the overlays moved to ContentOverlay, but the icon slot and FileBrowserTab were left behind.

## Evidence

- `src/components/Terminal/TerminalConnectionOverlay.tsx:188`
- `src/components/Terminal/TerminalConnectionOverlay.tsx:206`
- `src/components/Terminal/TerminalConnectionOverlay.tsx:261`
- `src/components/Terminal/TerminalConnectionOverlay.tsx:321`
- `src/components/Terminal/TerminalDisconnectOverlay.tsx:293`
- `src/components/RemoteDesktop/RemoteDesktopOverlay.tsx:43`
- `src/components/RemoteDesktop/RemoteDesktopOverlay.tsx:57`
- `src/components/Terminal/FileBrowserTab.tsx:131`
- `src/components/Sidebar/ConnectionPathDialog.tsx:43`
- `src/components/Terminal/TerminalConnectionOverlay.css:28`
- `src/components/Terminal/FileBrowserTab.css:57`
- `src/components/RemoteDesktop/RemoteDesktopTab.css:141`
- `src/components/Terminal/AgentErrorTab.css:71`
- `src/components/Sidebar/ConnectionPathDialog.css:81`

## Recommendation

Pass `<Spinner size={32} label={null} className="…__icon"/>` to every ContentOverlay busy state. For the RefreshCw reconnect glyph, either use Spinner or add an `icon` prop to Spinner. Delete the `__spin`/`--spin` classes. Rebuild FileBrowserTab's three phases on `<ContentOverlay busy={phase==='connecting'} …>`. ConnectionPathDialog's per-hop status can use `<Spinner size={15}>` for the connecting state.

## Verification

Confirmed. TerminalConnectionOverlay has 4 hand-rolled \*\*icon--spin icons, and RemoteDesktopOverlay mixes Spinner (:43) with a hand-rolled `rd-overlay__spin` (:59). FileBrowserTab uses Loader2 and has no ContentOverlay or role=status, while ContentOverlay's busy sets role=status/aria-live. The reduced-motion argument is weaker than stated, because all sites share the motion-essential-spinner class, but the consistency and live-region gaps are real.
