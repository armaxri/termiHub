---
id: ARCH2-002
title: "VNC 'Browse remote files' backend registration is owned by a per-window frontend store and is torn down on a cross-window tab move"
angle: architecture-overall
severity: low
category: arch
is_workaround: false
subsystem: "src/hooks/useRemoteDesktopBrowse.ts, src/store/remoteDesktopBrowseStore.ts, src-tauri/src/session/graphical_browse.rs"
evidence:
  - src/hooks/useRemoteDesktopBrowse.ts:19
  - src/hooks/useRemoteDesktopBrowse.ts:21
  - src/hooks/useRemoteDesktopBrowse.ts:28
  - src/hooks/useRemoteDesktopSession.ts:315
  - src/store/remoteDesktopBrowseStore.ts:39
  - src/components/RemoteDesktop/browseRemoteFiles.ts:76
  - src-tauri/src/commands/remote_desktop_browse.rs:96
  - src-tauri/src/session/graphical_browse.rs:70
  - src-tauri/src/commands/remote_desktop.rs:752
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The side-channel file browser of a graphical session is a backend registry (`SideChannelBrowsers`, keyed by graphical session id). The frontend decides when that registration starts and ends. A plain Zustand store per window (`remoteDesktopBrowseStore`, keyed by tab id) records it. `useRemoteDesktopBrowse` registers it again on every return to live (a reconnect, line 28) and removes it in an unmount cleanup that always runs (`closeRemoteDesktopBrowser` → `remote_desktop_close_file_browser`, lines 19-22). The session hook skips its own teardown when the tab is moving to another window (`isSessionMoving`, useRemoteDesktopSession.ts:315-319). The browse hook has no such guard.

## Why it matters

Example: a user opens a VNC tab, clicks 'Browse remote files', then drags the tab into another window. The source window unmounts the tab, so the backend side channel of a session that is still live is removed. The destination window's store never held the source. The File Browser loses the remote host, and later `session_*` file calls for that id fail as an unknown session. The same ownership model means a WebView reload drops the browse source while the backend entry stays, and that entry is never registered again after the next reconnect. This contradicts ADR-14's rule that backend lifecycle is the authority and the UI only renders it.

## Recommendation

Tie the registration to the graphical session's own lifecycle in the backend. GraphicalSessionManager or its supervisor should register it again on reconnect and drop it when the session ends. The 'open source per session' state should be exposed through a projection, either a field in the session-lifecycle region or a small region, so every window, including after a move or reload, renders it. Until then, guard the browse hook's cleanup with the same `isSessionMoving` check and move the store entry to the destination window along with the tab.

## Verification

Confirmed. In useRemoteDesktopBrowse the cleanup always calls closeRemoteDesktopBrowser, which removes the backend side channel. It has no isSessionMoving guard, unlike useRemoteDesktopSession.ts:315. The per-window Zustand store is not carried over on a cross-window move. In practice the destination window just has no browse source until the user clicks 'Browse remote files' again, which re-registers it. Nothing crashes or corrupts, so the impact is a lost convenience, not 'later session\_\* calls fail' in any window that still has the tab. Lowered to low.
