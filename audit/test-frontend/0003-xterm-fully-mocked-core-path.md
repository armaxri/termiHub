---
id: TFE-003
title: xterm fully mocked; private _core render path never exercised (silent-break risk)
angle: test-frontend
severity: medium
category: test-gap
is_workaround: false
subsystem: components/Terminal
evidence:
  - src/components/Terminal/Terminal.tsx:169
  - src/components/Terminal/Terminal.agent-reconnect.test.tsx:33
status: open
---

## What

Every Terminal component test replaces `@xterm/xterm` with a hand-written
`MockXTerm` that has **no `_core`**. But production code reaches into xterm's
private internals:

```ts
// Terminal.tsx:169
const cellWidth: number =
  (xterm as any)._core?._renderService?.dimensions?.css?.cell?.width;
```

No test in the tree references `_core`, `_renderService`, or `cellWidth`
(`grep -rl "_core\|_renderService\|cellWidth" src --include="*.test.*"` → none). The
mock returns an object without those fields, so under test `cellWidth` is always
`undefined` and the optional-chaining fallback silently swallows it.

## Why it matters

`_core._renderService.dimensions.css.cell.width` is an **undocumented private xterm
API**. An xterm minor/major upgrade that renames or restructures it (they have done
so historically) would make `cellWidth` silently `undefined` in production — with
**green CI**, because the mock never had the field and no assertion depends on it.
This is the same class of "over-mocking hides real integration break" that the audit
brief calls out. Whatever `cellWidth` feeds (fit/sizing math) would regress with no
signal.

## Evidence

- `src/components/Terminal/Terminal.tsx:169` — `(xterm as any)._core?...` with
  `as any` + optional chaining, no runtime guard/log if it resolves undefined.
- `src/components/Terminal/Terminal.agent-reconnect.test.tsx:33` — `MockXTerm` class;
  defines `buffer`, `parser`, `options`, etc. but **not** `_core`.

## Recommendation

Two complementary fixes:
1. **Isolate the private access** behind a tiny helper (e.g. `getCellWidth(xterm)`)
   that returns `null` on absence and **logs via `frontendLog`** when the private
   shape is missing — so a broken upgrade is observable, not swallowed. Unit-test the
   helper with both a present and an absent `_core`.
2. Add at least one test whose `MockXTerm` **does** expose a representative `_core`
   shape, so the happy path is exercised and a shape change in production code is
   caught. Longer term, prefer a public xterm API for cell dimensions if one exists.
