---
id: PERF-011
title: DOM-renderer terminals force a full-viewport repaint after every output flush
angle: performance
severity: low
category: perf
is_workaround: true
subsystem: src/components/Terminal/Terminal.tsx
evidence:
  - src/components/Terminal/Terminal.tsx:851
status: open
---

## What
After every batched output flush, the terminal runs `xterm.refresh(0, xterm.rows - 1)` —
forcing xterm's DOM renderer to repaint **every visible row**, not just the rows it marked
dirty. This is a deliberate fix for a WebView stale-row bug (#1849), gated to run only when
the WebGL renderer is not active (WebGL repaints its whole canvas anyway). So it is pure
extra work on the DOM-renderer fallback path.

## Why it matters
On the DOM-renderer path (WebGL unavailable, or after a GPU context loss falls back to DOM),
high-throughput output triggers a full-viewport DOM repaint on every RAF flush instead of
xterm's normal dirty-row-only repaint. For a tall terminal under sustained output this
multiplies per-frame DOM work. It is correctly avoided under WebGL (the default when
available), which bounds the blast radius — hence low severity — but it is a real cost
whenever WebGL is not in play (some Linux/VM/remote-display environments).

## Evidence
- `src/components/Terminal/Terminal.tsx:846-854` — `afterWrite` schedules a RAF that calls
  `xterm.scrollToBottom()` and, when `!webglRendererActiveRef.current`,
  `xterm.refresh(0, Math.max(0, xterm.rows - 1))` on every flush.
- The long comment at lines 816-833 documents it as the #1849 workaround for stale rows
  under WebView2/WebKit.

## Recommendation
- This is a stopgap for an upstream WebView/xterm repaint bug. Track whether newer
  xterm.js / WebView versions fix the stale-row issue so the forced full refresh can be
  removed on the DOM path.
- If it must stay, scope it more tightly — e.g. only refresh when a scroll/reflow actually
  occurred, or throttle the full refresh to at most once per few frames under sustained
  output — rather than every flush.
</content>
</invoke>
