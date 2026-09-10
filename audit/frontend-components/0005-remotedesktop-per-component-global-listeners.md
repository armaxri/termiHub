---
id: FEC-005
title: RemoteDesktop registers per-component global Tauri listeners on the high-volume frame path
angle: frontend-components
severity: medium
category: perf
is_workaround: false
subsystem: src/components/RemoteDesktop
evidence:
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:172
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:203
  - src/hooks/useRemoteDesktopSession.ts:214
status: open
---

## What
Both `RemoteDesktopCanvas` and `useRemoteDesktopSession` subscribe to backend
events by calling the global `listen()`-based helpers (`onRemoteDesktopFrame`,
`onRemoteDesktopCursor`, `onRemoteDesktopState`, `onRemoteDesktopClipboard`,
`onRemoteDesktopCertPrompt`) **per component instance**, then filter inside the
callback by `payload.session_id`. Each registration is a separate global Tauri
listener.

## Why it matters
This is exactly the O(N) fan-out anti-pattern that the terminal path was
deliberately refactored away from with `TerminalOutputDispatcher` (one global
listener, Map-routed per session). Every open remote-desktop tab receives and
JSON-deserialises **every** `remote-desktop-frame` event for **every** session,
then discards the ones that don't match — and frames are the app's largest
payloads (full/partial framebuffers). With two or more RDP/VNC tabs this
multiplies per-frame deserialisation cost by the number of open tabs.

Additionally, the frame-subscription effect's dependency array is
`[sessionId, ensureFramebuffer, repaint, onDimensions]`
(`RemoteDesktopCanvas.tsx:203`). `repaint` is `useCallback([scaleMode])`, so
**changing the scale mode tears down and re-registers the frame + cursor
listeners**, and resets `firstFramePaintedRef` — during the async
`listen().then(...)` re-registration window, frames can be dropped, and the
`onFirstFrame` placeholder-clear can re-fire. Nothing about painting a frame
depends on `scaleMode` at subscription time (repaint reads it live), so the
resubscribe is unnecessary churn on the hot path.

## Evidence
`src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:172-203`,
`src/hooks/useRemoteDesktopSession.ts:214-241`.

## Recommendation
Introduce a `RemoteDesktopDispatcher` mirroring `TerminalOutputDispatcher`: one
global listener per event type, Map-routed per `session_id`, with per-session
subscribe/unsubscribe. Have the canvas and the session hook subscribe through
it. Separately, drop `repaint`/`onDimensions` from the frame-subscription effect
deps (route them through refs like `onFirstFrameRef`) so the frame feed is
subscribed once per `sessionId` and never re-subscribed on a scale-mode change.
