/**
 * Per-PR app-shell smoke test (#2065, follow-up to #2050).
 *
 * The audit in #2050 found the safety net is heavily nightly/manual: the per-PR
 * gate runs `pytest -m "not integration"` and never launches the real app, so a
 * broad boot/wiring break — a bad import, a provider removed, a hook that throws
 * on mount, a store selector that crashes on the initial state — could merge
 * without any per-PR check noticing.
 *
 * This is the *fast per-PR* half of that safety net (the slow, real-app
 * boot-under-CSP check lives in the nightly integration lane —
 * tests/system/tests/test_csp.py, #2059). It mounts the whole `App` shell in
 * jsdom against the default store state and asserts:
 *   1. the mount does not throw, and
 *   2. every top-level region (activity bar, terminal view, status bar,
 *      sidebar) is present and the ErrorBoundary did not trip.
 *
 * All Tauri IPC/event/window/dialog/fs APIs are already stubbed globally in
 * src/test/setup.ts, so no app build and no Docker are needed — it runs inside
 * the existing per-PR `pnpm test` (vitest) job on all three OSes. Runtime is a
 * fraction of a second: a single React-DOM createRoot mount, no real timers, no
 * network. It deliberately asserts only the coarse shell so it stays fast and
 * non-flaky; deep behavior is covered by the per-component tests and the nightly
 * integration lane.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import App from "./App";

describe("App shell smoke (#2065)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Boot from the pristine store state so the smoke reflects a cold app start,
    // independent of any state a prior test left behind. `loadFromBackend` is
    // neutered to a resolved no-op: with the Tauri `invoke` stubbed to return
    // `undefined` (src/test/setup.ts), the real hydration would overwrite the
    // store's default arrays with `undefined` and crash a consumer — a mock
    // artifact, not an app fault. Backend hydration against a real IPC is the
    // nightly integration lane's job (#2059); this fast smoke asserts only that
    // the shell boots and wires up against pristine state.
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      loadFromBackend: async () => {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("mounts the full app shell without throwing", async () => {
    // `await act(async …)` renders and then flushes the mount effects (the async
    // loadFromBackend / restore chain) so a throw from startup wiring surfaces
    // here rather than as a late unhandled rejection.
    await act(async () => {
      root.render(<App />);
    });

    // The root shell rendered (ErrorBoundary did not fall back to its error UI).
    const app = container.querySelector(".app");
    expect(app).not.toBeNull();

    // Each top-level region wired into App is present. A broken import or a hook
    // throwing on mount would collapse one of these to null.
    expect(container.querySelector(".activity-bar")).not.toBeNull();
    expect(container.querySelector(".terminal-view")).not.toBeNull();
    expect(container.querySelector('[data-testid="status-bar"]')).not.toBeNull();
    expect(container.querySelector(".sidebar")).not.toBeNull();
  });
});
