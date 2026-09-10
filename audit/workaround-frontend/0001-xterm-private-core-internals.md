---
id: WA-FE-001
title: Reach into xterm.js private internals (_core._renderService) for cell width
angle: workaround-frontend
severity: high
category: workaround
is_workaround: true
subsystem: components/Terminal
evidence:
  - src/components/Terminal/Terminal.tsx:168
  - src/components/Terminal/Terminal.tsx:169
status: open
---

## What
The horizontal-scroll width computation reads xterm.js **private, undocumented**
internals through an `as any` cast:

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cellWidth: number = (xterm as any)._core?._renderService?.dimensions?.css?.cell?.width;
```

`_core`, `_renderService`, and `dimensions.css.cell.width` are all private fields of
the xterm.js `Terminal` object (leading underscores, not on the public type). The `as any`
cast is required precisely because these members do not exist on the public API surface,
and it is paired with a suppressed `no-explicit-any` lint.

## Why it matters
- The `as any` bypasses TypeScript entirely — a rename or restructure of xterm's internal
  render service (routine across xterm minor/major versions) silently returns `undefined`,
  and horizontal-scroll width computation quietly stops working with no compile error and
  no test failure (unit tests mock xterm).
- It couples a core, always-on rendering path (terminal horizontal scroll) to an
  implementation detail of a third-party library, which is exactly the kind of brittle
  coupling that should not ship in a "ventilator-grade" release.

## Evidence
`src/components/Terminal/Terminal.tsx:157-184` (`updateHorizontalScrollWidth`). The comment
acknowledges it is using "the same source FitAddon uses internally" — i.e. it is
deliberately shadowing a private FitAddon computation.

## Recommendation
Prefer a public API. `FitAddon.proposeDimensions()` is already called two lines above; xterm
also exposes cell geometry via the public options / `ITerminalOptions`. If no public accessor
gives the CSS cell width, compute it from the measured element (`xterm.element` width ÷ cols)
or file an upstream request, but do not read `_core._renderService`. At minimum, isolate this
into a single guarded helper with a runtime assertion + fallback so an xterm upgrade degrades
loudly (logged) rather than silently. Removing the `as any` and the lint suppression is the
signal the workaround is gone.
