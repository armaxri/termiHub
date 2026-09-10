---
id: MOCK-008
title: Global jsdom fidelity hacks (FileBrowser dimension/scroll overrides) and a leaked-timer workaround make component tests diverge from real browser behavior
angle: test-mocking
severity: medium
category: workaround
is_workaround: true
subsystem: src/test/setup.ts
evidence:
  - src/test/setup.ts:74
  - src/test/setup.ts:107
  - src/test/setup.ts:133
  - src/test/setup.ts:59
status: open
---

## What
`src/test/setup.ts` installs a set of global, prototype-level overrides so that jsdom
component tests behave differently from bare jsdom — and, in one case, differently to route
around a real upstream bug:

1. **Hard-coded FileBrowser viewport.** `offsetHeight`/`clientHeight`/`offsetWidth`/
   `clientWidth`/`scrollHeight` are monkey-patched on `HTMLElement.prototype` to report a fixed
   `2000×300` box for any element with class `file-browser__list` (`:74-101`). The
   virtualizer's row math is therefore validated against a **constant synthetic size**, not
   the real measured layout — a real-world sizing regression (0-height container, wrong
   overscan) is invisible.
2. **Backed scrollTop/scrollLeft + a re-implemented `scrollTo`** that also synthesizes
   `scroll`+`scrollend` events (`:107-149`). This is a hand-rolled reimplementation of browser
   scroll semantics; if `@tanstack/react-virtual` changes how it reads scroll state, the fake
   diverges silently.
3. **A leaked-timer workaround.** The `onscrollend` shim (`:59-62`) exists specifically to
   steer react-virtual **away from a debounced `setTimeout` its cleanup never clears** — a real
   leaked-timer defect that "throws an unhandled 'window is not defined' that fails the whole
   run" per the in-file comment. The test harness papers over the leak rather than the leak
   being fixed (or pinned by a test that asserts no timer survives unmount).

## Why it matters
- These are **infrastructure-level fidelity compromises**: they make the FileBrowser suite pass
  by feeding it a fabricated layout and scroll model. The virtualization behavior that users
  actually see (measured heights, real scroll offsets) is not what the tests exercise, so the
  suite can be green while the real windowed list mis-renders.
- The leaked-timer shim (`is_workaround`) hides a genuine resource leak: a debounce timer that
  outlives unmount. In production that same un-cleared timer fires after the FileBrowser goes
  away — a latent post-unmount callback / potential leak that the workaround deliberately keeps
  invisible.

## Evidence
- Fixed-size overrides: `src/test/setup.ts:74-101`.
- Reimplemented scroll storage + `scrollTo` event synthesis: `:107-149`.
- Leaked-timer avoidance shim with explanatory comment: `:50-62`.

## Recommendation
- Replace the constant-size FileBrowser overrides with a per-test explicit sizing helper (or a
  jsdom layout shim scoped to the test that needs it), so the virtualizer is tested against
  varied/edge sizes (including 0-height) rather than one magic constant.
- Fix the leaked-timer at the source: ensure the FileBrowser virtualizer's cleanup clears its
  debounce timer, and add a regression test asserting **no pending timer/callback survives
  unmount** (fake timers + `vi.getTimerCount()`), instead of steering around it via the
  `onscrollend` capability shim.
