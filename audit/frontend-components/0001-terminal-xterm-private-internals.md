---
id: FEC-001
title: Terminal reaches into xterm.js private internals for cell width
angle: frontend-components
severity: high
category: arch
is_workaround: true
subsystem: src/components/Terminal
evidence:
  - src/components/Terminal/Terminal.tsx:169
status: fixed
resolution: "#2829 — isolated xterm private cell-width read behind typed xtermDimensions adapter + loud shape-test (public API floors sub-pixel width, infeasible); no inline as-any on layout path"
---

## What
The horizontal-scroll layout math reads the rendered cell width by casting the
xterm instance to `any` and drilling through several undocumented private
fields: `(xterm as any)._core?._renderService?.dimensions?.css?.cell?.width`.

## Why it matters
`_core`, `_renderService`, and `dimensions.css.cell.width` are all private,
unstable internals of `@xterm/xterm`. Any minor xterm upgrade can rename or
restructure them; because the access is guarded (`if (!cellWidth …) return`) the
failure mode is silent — horizontal scrolling stops sizing correctly with no
error, so a regression ships invisibly. The `as any` also defeats the compiler
on a hot layout path. This is the single hardest third-party coupling in the
component layer and is a release risk for a safety-critical build that must
survive dependency bumps.

## Evidence
`src/components/Terminal/Terminal.tsx:169`
```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cellWidth: number = (xterm as any)._core?._renderService?.dimensions?.css?.cell?.width;
if (!cellWidth || cellWidth <= 0) return;
```

## Recommendation
Derive cell width from public API only. `FitAddon.proposeDimensions()` already
exposes `cols`, and the container's content width is measurable via the DOM;
compute cell width as `availableWidth / cols` from public surfaces, or file an
upstream xterm request for a public dimensions accessor. If a private read is
truly unavoidable, isolate it behind one typed adapter module with a runtime
guard and a unit test that fails loudly (not silently) when the shape changes,
so an xterm upgrade surfaces the break in CI rather than in the field.
