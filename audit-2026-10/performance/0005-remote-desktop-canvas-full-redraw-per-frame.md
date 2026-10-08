---
id: PERF2-005
title: "Remote-desktop canvas reallocates and fully redraws on every frame event, with no RAF batching"
angle: performance
severity: low
category: perf
is_workaround: false
subsystem: src/components/RemoteDesktop/RemoteDesktopCanvas.tsx
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:153
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:170
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:175
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:189
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:209
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:258
---

## What

Each `remote-desktop-frame` event, even one with a single small dirty rect, runs `repaint()` synchronously (258). `repaint` assigns `canvas.width`/`canvas.height` on every call (170/175/189). That resets the 2D context state and clears, and may reallocate, the backing store even when the size has not changed. It then `drawImage`s the entire framebuffer region, scaled, onto the visible canvas (209). Repaints are not coalesced per animation frame, so a burst of N small VNC updates within one frame causes N full-surface reallocations and scaled blits.

## Why it matters

VNC servers often send many small updates per second: cursor trails, typing, progress bars. Each one costs a full-resolution scaled blit plus a canvas reset instead of a dirty-rect copy, and the total grows with update count, not with changed pixels. This adds to the IPC cost of the frame wire format and keeps the main thread busy, which hurts input latency in the remote session.

## Evidence

- `src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:153`
- `src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:170`
- `src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:175`
- `src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:189`
- `src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:209`
- `src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:258`

## Recommendation

Set the visible canvas size only when container size, scale mode or viewport actually change (in the resize effect), not inside every repaint. Coalesce repaints with one `requestAnimationFrame` per canvas: mark it dirty in the frame handler and repaint once per frame. Optionally blit only the union of dirty rects mapped through the scale geometry. Consider `createImageBitmap` plus an OffscreenCanvas/worker for decoding.

## Verification

Confirmed in code. Each remote-desktop-frame event calls repaintRef.current() synchronously. repaint() assigns canvas.width and canvas.height on every call in all three scale modes, which resets and clears the context, and then drawImages the whole region scaled. There is no RAF coalescing on the frontend, and the backend shows no frame-rate coalescing. I rate it low rather than medium: canvas resizing to the same dimensions is cheap in practice, a single scaled drawImage per update is GPU-accelerated, and the bigger costs are the per-rect ImageData copies and the IPC. Still a real inefficiency.
