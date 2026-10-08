---
id: WA-FE2-001
title: "fitTerminal unconditionally scrolls to the bottom on every slot adoption, so zooming or moving a tab loses the user's scroll position"
angle: workaround-frontend
severity: medium
category: workaround
is_workaround: true
subsystem: "components/Terminal (TerminalRegistry) + SplitView slot adoption"
evidence:
  - src/components/Terminal/TerminalRegistry.tsx:320
  - src/components/Terminal/TerminalRegistry.tsx:321
  - src/components/Terminal/TerminalRegistry.tsx:322
  - src/components/SplitView/SplitView.tsx:1252
  - src/components/SplitView/SplitView.tsx:1254
  - src/components/SplitView/SplitView.tsx:609
  - src/components/SplitView/SplitView.tsx:1074
  - src/components/SplitView/SplitView.tsx:1105
  - src/components/Terminal/Terminal.tsx:1821
  - src/components/Terminal/Terminal.tsx:1822
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The repaint fix for #1823 in `fitTerminal` runs `requestAnimationFrame(() => { xterm.scrollToBottom(); xterm.refresh(...) })` on every call, with no check of the user's scroll state. TerminalSlot's adopt effect calls fitTerminal twice per reparent (a sync call plus one in rAF). Slots are keyed on zoom state (`ts-${tab.id}-${z|n}` and `zoom-slot-${id}`), so zoom in, zoom out, and cross-panel moves all remount the slot and reach this path. The ResizeObserver path in Terminal.tsx:1821 guards the same scroll with `if (!userScrolledUpRef.current)`; the registry path does not.

## Why it matters

Say a user has scrolled up to read earlier output and zooms the pane (Cmd/Ctrl+Shift+Enter) or drags the tab to another panel. They are jumped to the bottom twice and lose their place. The fix for #1823 only needed the `refresh()`; the forced `scrollToBottom()` came along with it as a side effect. This is the same class of 'yanked to bottom' bug that #2682 fixed for output writes.

## Evidence

- `src/components/Terminal/TerminalRegistry.tsx:320`
- `src/components/Terminal/TerminalRegistry.tsx:321`
- `src/components/Terminal/TerminalRegistry.tsx:322`
- `src/components/SplitView/SplitView.tsx:1252`
- `src/components/SplitView/SplitView.tsx:1254`
- `src/components/SplitView/SplitView.tsx:609`
- `src/components/SplitView/SplitView.tsx:1074`
- `src/components/SplitView/SplitView.tsx:1105`
- `src/components/Terminal/Terminal.tsx:1821`
- `src/components/Terminal/Terminal.tsx:1822`

## Recommendation

Before `fitAddon.fit()` in fitTerminal, capture `const buf = xterm.buffer.active; const atBottom = buf.viewportY >= buf.baseY;`. In the rAF, call `scrollToBottom()` only when `atBottom` is true, and keep the unconditional `refresh(0, rows-1)`. Add a TerminalRegistry test showing that adopting a scrolled-up terminal keeps its viewportY.

## Verification

Confirmed. TerminalRegistry.fitTerminal (around lines 320-330) calls xterm.scrollToBottom() inside the rAF with no check of the user's scroll position. The comment shows only refresh() was needed for #1823. SplitView TerminalSlot's tryAdopt (around 1250-1254) calls fitTerminal synchronously and again in a rAF on every reparent, and the zoom slot is keyed `zoom-slot-${id}` (line 610), so zooming remounts and adopts. The ResizeObserver path in Terminal.tsx:1821 guards the same scroll with `if (!userScrolledUpRef.current)`; this path does not. A scrolled-up user loses their place on zoom or move.
