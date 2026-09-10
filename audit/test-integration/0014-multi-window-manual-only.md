---
id: TIN-014
title: Multi-window is manual-only — the bridge harness is not multi-window aware
angle: test-integration
severity: medium
category: test-gap
is_workaround: false
subsystem: src/store/appStore.ts (multi-window), tests/system
evidence:
  - src/store/appStore.ts:775
  - docs/testing.md:2426
  - docs/testing.md:1021
status: open
---

## What

The multi-window feature (#1900 open-new-window, #1903 close-with-live-tabs /
per-OS quit policy, #1925 windowed-layout restore) is verified **manually only**.
Per `docs/testing.md`: move-a-live-tab-between-windows "cannot be automated on
macOS … and the Python bridge harness is **not yet multi-window aware**"
(~L2426), driven instead from the DevTools console and "required on macOS";
close-with-live-tabs / quit policy "cannot be automated — `tauri-driver` has no
macOS WKWebView driver (ADR-5) and window-close/Dock behaviour is OS-native"
(~L1021).

The bridge connects to a single page (`TestBridge` binds one page-scoped runner
socket), so a second spawned window is outside the harness's reach.

## Why it matters

- Multi-window touches window spawning, per-window store hydration, cross-window
  tab move, and OS-native quit/Dock behavior — a dense integration surface with
  **no** automated coverage, gated entirely on a human running console commands.
- It couples directly with workspace restore (TIN-013): windowed-layout restore
  (#1925) cannot be automated end-to-end while the harness can't see the second
  window, so that whole restore path is manual too.

## Evidence

- `appStore.ts:775-862, 1734-1795` — multi-window foundation, `openNewWindow`,
  restore-spawned secondary window hydration.
- `docs/testing.md` ~L2426 (move-tab manual, harness not multi-window aware),
  ~L1021 (close/quit manual).

## Recommendation

- Make the bridge multi-window aware: allow the runner to enumerate and address
  each app window's `TestBridge` (e.g. one runner socket per window, keyed by a
  window label), so multi-window journeys and windowed-layout restore can be
  driven automatically at least on Linux/Windows.
- Until then, keep the multi-window manual items explicitly release-gating (they
  are the only signal) and track the harness enhancement as the fix that retires
  them.
