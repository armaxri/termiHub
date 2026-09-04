/**
 * `useLayoutRenderTree` (#2283 slice E2) — after the layout data-flow inversion
 * completed, the hook is a thin read of the region-derived `appStore.rootPanel`
 * (the mirror composes it from the `layout@<clientId>` projection). The earlier
 * strangler machinery — a render flag, a faithful-mirror gate, and a
 * seed-on-drift effect — is gone, so this just pins that the hook returns the
 * current tree and re-renders when it changes.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PanelNode } from "@/types/terminal";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], powerMonitoringEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

import { useAppStore } from "./appStore";
import { useLayoutRenderTree } from "./useLayoutRenderTree";
import { layoutState, seedLayoutState } from "@/test/layoutState";

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => PanelNode; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: PanelNode = layoutState().rootPanel;

  function Probe() {
    latest = useLayoutRenderTree();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

function leaf(id: string): PanelNode {
  return { type: "leaf", id, tabs: [], activeTabId: null };
}

describe("useLayoutRenderTree", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("returns the current region-derived rootPanel", () => {
    const root = leaf("only");
    seedLayoutState({ rootPanel: root, activePanelId: "only" });
    const hook = renderHook();
    expect(hook.get()).toBe(root);
    hook.unmount();
  });

  it("re-renders when the rootPanel changes", () => {
    const hook = renderHook();
    const next = leaf("next");
    act(() => {
      seedLayoutState({ rootPanel: next, activePanelId: "next" });
    });
    expect(hook.get()).toBe(next);
    hook.unmount();
  });
});
