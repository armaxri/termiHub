---
id: A11Y2-009
title: "Zoom overlay swallows Escape before the terminal and is not a modal dialog"
angle: accessibility
severity: medium
category: keyboard
is_workaround: false
subsystem: "src/components/SplitView"
evidence:
  - src/components/SplitView/SplitView.tsx:296-307
  - src/components/SplitView/SplitView.tsx:471-473
  - src/components/SplitView/SplitView.tsx:505-506
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

While a tab is zoomed, a window-level capture-phase keydown listener calls stopPropagation on every Escape and closes the zoom. Because window capture runs before the target, xterm's textarea never receives Escape. The overlay itself is a plain <div className="zoom-overlay"> with no role="dialog", aria-modal or focus containment, so Tab can move to the hidden panels underneath.

## Why it matters

Keyboard operability (WCAG 2.1.1, and 2.1.2 by analogy): in a zoomed terminal, vim, less, readline vi-mode, fzf and any TUI cannot receive Escape. Pressing Escape to leave insert mode instead closes the zoom, which is surprising and disorienting, especially for screen-reader users who get no announcement that the view changed. Without containment, focus also escapes into obscured content (2.4.3, 2.4.11 Focus Not Obscured).

## Recommendation

Do not intercept Escape when the event target is inside the zoomed terminal (an xterm helper textarea) or a Monaco editor. Rely on the existing Ctrl/Cmd+Shift+Enter toggle and the close button, or require a modifier such as Shift+Escape. Give the overlay role="dialog" aria-modal="true" aria-label={zoomedTabTitle}, keep focus inside it, and restore focus to the originating tab on close.

## Verification

Confirmed. SplitView.tsx:296-307 adds a window-capture keydown listener that stopPropagation()s Escape and closes the zoom, so a zoomed xterm never receives Escape. The 'Esc to close' hint shows this is intentional, but it still breaks vim and other TUIs. The overlay is a plain div with no dialog semantics.
