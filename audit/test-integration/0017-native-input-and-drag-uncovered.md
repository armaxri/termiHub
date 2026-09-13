---
id: TIN-017
title: The bridge injects synthetic DOM events, so native input and key drag/drop gestures are uncovered
angle: test-integration
severity: medium
category: test-gap
is_workaround: false
subsystem: src/testbridge, tests/system
evidence:
  - docs/test-bridge.md:567
  - docs/testing.md:1413
status: open
---

## What

The test bridge drives the app by injecting **synthetic** DOM events, so by
design it "faithfully tests app logic, rendering, terminal I/O, and state — but
**not** the native OS input pipeline (native drag-and-drop coordinates, IME, real
keyboard focus)" (`docs/test-bridge.md:567-573`). On top of that, several
layout/split gestures have **no stable testid to drive over the bridge** —
drag-to-edge, drag-to-center, cross-panel move, tab-move-across-groups — so they
are proven only by a headless component suite, not end-to-end
(`docs/testing.md:1413`). Native input was historically the `tauri-driver`
domain (Linux/Windows) plus manual macOS, and `tauri-driver` is now retired
except for the smoke test with no macOS driver.

## Why it matters

- Drag-and-drop tab/split reorganisation and cross-group tab moves are core,
  high-touch UX. The component suite verifies the reducer/DOM logic, but the real
  pointer-gesture path (drop zones, coordinates, `@dnd-kit` sensors under real
  input) has no end-to-end coverage — a regression only reachable via genuine
  pointer events would be caught only manually.
- IME and real keyboard-focus paths (relevant for non-Latin input and terminal
  focus edge cases) are entirely unautomated across the stack now that
  `tauri-driver` is retired.

## Evidence

- `docs/test-bridge.md:567-573` — "Not covered": native input pipeline, DnD
  coordinates, IME, real keyboard focus.
- `docs/testing.md:1413` — drag drop-zone gestures "have no stable testid to
  drive over the bridge," component-suite only.

## Recommendation

- Add stable testids to the split/drag drop zones so at least the app-logic side
  of the gesture (synthetic drag → correct layout mutation) is bridge-drivable
  end-to-end, closing the "component-suite only" gap for the common ops.
- For genuinely native input (real pointer DnD, IME, focus), keep a small,
  explicitly release-gating manual matrix, and evaluate whether the retired
  `tauri-driver` real-input path is worth reviving on Linux/Windows for the DnD
  and focus cases it used to cover.
