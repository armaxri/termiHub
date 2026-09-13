---
id: MOCK-003
title: MockXTerm is hand-duplicated across 15 test files and omits `_core`; the real xterm private-access path is never exercised
angle: test-mocking
severity: medium
category: test-gap
is_workaround: false
subsystem: src/components/Terminal (tests)
evidence:
  - src/components/Terminal/Terminal.overlapping-connect.test.tsx:29
  - src/components/Terminal/Terminal.webgl-renderer.test.tsx
  - src/components/Terminal/Terminal.tsx:169
status: open
---

## What
`Terminal.tsx` is the app's connect/reconnect state machine and it is tested only by mounting
the component with `@xterm/xterm` fully replaced by a local `class MockXTerm`. That mock is
**copy-pasted into 15 separate Terminal test files**, each maintaining its own hand-written
shape of the xterm API surface:

```
src/components/Terminal/Terminal.overlapping-connect.test.tsx
src/components/Terminal/Terminal.agent-reconnect-resume.test.tsx
src/components/Terminal/Terminal.agent-reconnect.test.tsx
src/components/Terminal/Terminal.reconnect-scrollback.test.tsx
src/components/Terminal/Terminal.resize-dedup.test.tsx
src/components/Terminal/Terminal.inflight-per-attempt.test.tsx
src/components/Terminal/Terminal.webgl-renderer.test.tsx
src/components/Terminal/Terminal.backend-reattach.test.tsx
src/components/Terminal/Terminal.reconnect-fresh.test.tsx
src/components/Terminal/Terminal.highlighting.test.tsx
src/components/Terminal/TerminalAutoScroll.test.tsx
src/components/Terminal/Terminal.output-repaint.test.tsx
src/components/Terminal/Terminal.connect-toast.test.tsx
src/components/Terminal/Terminal.agent-reattach-scrollback.test.tsx
src/components/Terminal/Terminal.session-stability.test.tsx
```

The mock models `open/write/resize/buffer.active/parser/unicode/...` but has **no `_core`**
field (`Terminal.overlapping-connect.test.tsx:29-56`), while production code reaches into
xterm's private internals:

```
# src/components/Terminal/Terminal.tsx:169
(xterm as any)._core?._renderService?.dimensions?.css?.cell?.width
```

## Why it matters
- **Mock-vs-reality divergence + drift.** Fifteen independent hand-kept copies of the same
  external-API mock means: (a) they drift from each other and from the real `@xterm/xterm`
  contract silently, and (b) an xterm upgrade that renames a method or the private `_core`
  layout will not fail any test — the mock keeps returning the old shape. This is the
  canonical "green tests, broken reality" trap for the app's most reliability-critical
  component. (Deepens TFE-003, which noted the `_core` gap; the multiplication by 15 is the
  maintenance hazard.)
- Because `_core?.` is optional-chained, a real break degrades to `undefined` (cell width lost
  → fit/resize miscalculation) with **no test signal at all**.

## Evidence
- 15 files each declaring `class MockXTerm` (list above; grep `class MockXTerm`).
- Private-internal access with no mock backing: `Terminal.tsx:169`.

## Recommendation
1. Extract a single shared `MockXTerm` into `src/test/` so there is one authoritative double,
   killing the 15-way drift.
2. Add a **contract test** that imports the real `@xterm/xterm` (jsdom-mounted, not mocked) and
   asserts the private path `_core._renderService.dimensions.css.cell.width` resolves to a
   number — so an upstream rename fails CI. Better: stop reaching into `_core` and use a
   public API / the fit addon's reported dimensions, then delete the fragile access entirely.
