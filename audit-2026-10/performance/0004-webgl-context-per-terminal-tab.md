---
id: PERF2-004
title: "Every terminal tab holds its own WebGL2 context forever; past the engine's active-context cap the oldest terminals lose WebGL for good"
angle: performance
severity: medium
category: perf
is_workaround: false
subsystem: src/components/Terminal/Terminal.tsx
status: fixed
resolution: "#4308 — WebGL contexts are leased only to on-screen terminals from a pool capped at 12 (LRU eviction); hidden tabs release theirs and a lost context is retried on the next show"
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - src/components/Terminal/Terminal.tsx:1487
  - src/components/Terminal/Terminal.tsx:1489
  - src/components/Terminal/Terminal.tsx:1490
  - src/components/Terminal/Terminal.tsx:1887
  - src/components/Terminal/Terminal.tsx:965
---

## What

Each Terminal instance loads a `WebglAddon` right after `open()` (1489) and only disposes it on unmount or context loss (1887/1490). Terminals for background tabs stay mounted (parked), so every open terminal tab and split pane in a window keeps a live WebGL2 context with its own glyph atlas textures. Browser engines cap active WebGL contexts per page: 16 in both WebKit (WKWebView/WebKitGTK) and Chromium (WebView2). Creating context 17 makes the engine force-lose the oldest one. `onContextLoss` is deliberately one-shot (it does not re-create the context), so that terminal stays on the DOM renderer for the rest of its life. It then also pays the per-flush full-viewport refresh (PERF-011, line 965).

## Why it matters

Users with many tabs, which is the point of a terminal hub, get earlier tabs silently downgraded to the much slower DOM renderer, with the full repaint on every flush. GPU memory also grows linearly with tab count: atlas textures and framebuffers for terminals nobody is looking at.

## Evidence

- `src/components/Terminal/Terminal.tsx:1487`
- `src/components/Terminal/Terminal.tsx:1489`
- `src/components/Terminal/Terminal.tsx:1490`
- `src/components/Terminal/Terminal.tsx:1887`
- `src/components/Terminal/Terminal.tsx:965`

## Recommendation

Make WebGL a resource of visible terminals only. Dispose the WebglAddon when a terminal is parked or hidden and load it again when it becomes visible. Alternatively keep an LRU pool capped at about 8–12 contexts and evict the least recently visible terminal. Allow a context-lost terminal to try WebGL again when it next becomes visible instead of making the fallback permanent. Add a test with the test-bridge `loseTerminalWebglContext` verb, or a pool unit test.

## Verification

Confirmed. Every Terminal loads a WebglAddon after open() and disposes it only on effect cleanup or context loss. Terminals for background tabs stay mounted in the TerminalRegistry parking div, so their contexts stay live. onContextLoss is one-shot by design (the comment says 'we do not try to re-create the context'), so a terminal whose context the browser evicts stays on the DOM renderer for good. There is no pool, cap, or dispose-on-hide logic. The exact per-page context cap depends on the engine but is commonly 16. With many tabs open, the older ones will be downgraded.
