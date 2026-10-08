---
id: FEC2-002
title: "FEC-005 never fixed: each RemoteDesktop canvas and session hook still registers its own global Tauri listener on the frame path"
angle: frontend-components
severity: low
category: perf
is_workaround: false
subsystem: "src/components/RemoteDesktop"
evidence:
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:237-296
  - src/services/events.ts:97-112
  - src/hooks/useRemoteDesktopSession.ts:345-370
  - audit/frontend-components/0005-remotedesktop-per-component-global-listeners.md
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: FEC-005
---

## What

FEC-005 is marked `fixed` with resolution "#2777", but PR #2777 ("prevent leaked file/dir watchers on fast unmount (fec-013/005)") changed `useLocalDirWatch`, not RemoteDesktop. `RemoteDesktopCanvas` still calls `onRemoteDesktopFrame` and `onRemoteDesktopCursor` once per instance. Each is a separate `listen()` on `remote-desktop-frame`, and each one throws away payloads where `payload.session_id !== sessionId`. `useRemoteDesktopSession` does the same for state, clipboard and cert events. No dispatcher like `TerminalOutputDispatcher` exists. Only the resubscribe-on-scale-change part was later fixed by moving `repaint` and `onDimensions` into refs.

## Why it matters

Frames are the largest payloads in the app (`rect.data` is serialized as a byte array). With N open VNC/RDP tabs in a window, every frame of every session is delivered to and deserialized by N handlers, so the per-frame cost grows with the number of tabs. The new file-transfer features make keeping several graphical tabs open more likely. The audit record wrongly shows this as resolved.

## Evidence

- `src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:237-296`
- `src/services/events.ts:97-112`
- `src/hooks/useRemoteDesktopSession.ts:345-370`
- `audit/frontend-components/0005-remotedesktop-per-component-global-listeners.md`

## Recommendation

Add a `RemoteDesktopDispatcher` modeled on `TerminalOutputDispatcher`: one global listener per event type, routed through a Map keyed by session id, with per-session subscribe and unsubscribe. Route `RemoteDesktopCanvas` and `useRemoteDesktopSession` through it. Correct the FEC-005 resolution in the audit records.

## Verification

Confirmed. The FEC-005 record says `status: fixed, resolution: #2777`, but `gh pr view 2777` shows that PR touched only FileEditor and useLocalDirWatch files. `RemoteDesktopCanvas.tsx:243/280` still calls `onRemoteDesktopFrame`/`onRemoteDesktopCursor` once per instance and filters by `session_id`. `useRemoteDesktopSession.ts:345/365/370` does the same. No RemoteDesktop dispatcher exists. Only the resubscribe-on-scale-change part was fixed (`repaintRef`/`onDimensionsRef`). I lowered severity from medium: Tauri serializes an event's payload once into the webview and then calls each registered handler, so each extra tab mostly adds a cheap callback that returns early, not a full re-deserialization. The real problem is the wrong audit record plus a modest fan-out.
