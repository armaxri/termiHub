/**
 * Branch coverage for the small UI-chrome slices (#2979): sidebar view/collapse
 * toggling and the debounced layout persistence (including its failure log) in
 * `uiChromeSlice`, the per-tab runtime maps in `tabRuntimeSlice`, and the
 * fallbacks in `panelZoomSlice.toggleZoomActiveTab`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const m = vi.hoisted(() => ({
  saveSettings: vi.fn(),
  frontendLog: vi.fn(),
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() => Promise.resolve({ version: "1", externalConnectionFiles: [] })),
  saveSettings: (s: unknown) => m.saveSettings(s),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/utils/frontendLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/frontendLog")>()),
  frontendLog: (...a: unknown[]) => m.frontendLog(...a),
}));

import { useAppStore } from "./appStore";
import { DEFAULT_LAYOUT, LAYOUT_PRESETS } from "@/types/connection";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { createLeafPanel } from "@/utils/panelTree";

/** Let the 300 ms layout-persist debounce fire and its promise settle. */
async function flushPersist(): Promise<void> {
  await vi.advanceTimersByTimeAsync(300);
}

describe("uiChromeSlice (#2979)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(useAppStore.getInitialState());
    m.saveSettings.mockReset().mockResolvedValue(undefined);
    m.frontendLog.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses the sidebar when its already-open view is re-selected, and re-opens it", () => {
    useAppStore.getState().setSidebarView("connections");
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);

    useAppStore.getState().setSidebarView("connections");
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    expect(useAppStore.getState().layoutConfig).toMatchObject({
      sidebarView: "connections",
      sidebarCollapsed: false,
    });
  });

  it("switches views without collapsing", () => {
    useAppStore.getState().setSidebarView("tunnels");
    expect(useAppStore.getState().sidebarView).toBe("tunnels");
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });

  it("toggles the sidebar and records it in the layout config", () => {
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(useAppStore.getState().layoutConfig.sidebarCollapsed).toBe(true);
  });

  it("sets the sidebar width and the layout dialog flag", () => {
    useAppStore.getState().setSidebarWidth(320);
    useAppStore.getState().setLayoutDialogOpen(true);
    expect(useAppStore.getState().sidebarWidth).toBe(320);
    expect(useAppStore.getState().layoutDialogOpen).toBe(true);
  });

  it("debounces layout persistence into one save of the latest config", async () => {
    useAppStore.getState().updateLayoutConfig({ sidebarCollapsed: true });
    useAppStore.getState().updateLayoutConfig({ sidebarCollapsed: false });
    await flushPersist();

    expect(m.saveSettings).toHaveBeenCalledTimes(1);
    expect(m.saveSettings.mock.calls[0][0].layout.sidebarCollapsed).toBe(false);
  });

  it("logs a failed layout-config save", async () => {
    m.saveSettings.mockRejectedValue(new Error("disk full"));
    useAppStore.getState().updateLayoutConfig({ sidebarCollapsed: true });
    await flushPersist();

    expect(m.frontendLog).toHaveBeenCalledWith(
      "app_store",
      "Failed to persist layout config: disk full"
    );
  });

  it("applies and persists a preset, logging a failed save", async () => {
    m.saveSettings.mockRejectedValue(new Error("disk full"));
    useAppStore.getState().updateLayoutConfig({ sidebarCollapsed: true });
    useAppStore.getState().applyLayoutPreset("zen");
    await flushPersist();

    expect(useAppStore.getState().layoutConfig).toEqual(LAYOUT_PRESETS.zen);
    // The preset's save superseded the pending config save.
    expect(m.saveSettings).toHaveBeenCalledTimes(1);
    expect(m.frontendLog).toHaveBeenCalledWith(
      "app_store",
      "Failed to persist layout preset: disk full"
    );
  });

  it("ignores an unknown preset", () => {
    useAppStore.getState().applyLayoutPreset("nope" as "zen");
    expect(useAppStore.getState().layoutConfig).toEqual(DEFAULT_LAYOUT);
  });

  describe("toggleActivityBarView", () => {
    it("never hides a required view", () => {
      useAppStore.getState().toggleActivityBarView("connections");
      expect(useAppStore.getState().layoutConfig.hiddenActivityBarViews ?? []).toEqual([]);
    });

    it("hides the active view and collapses the sidebar", async () => {
      useAppStore.setState({ sidebarView: "tunnels", sidebarCollapsed: false });

      useAppStore.getState().toggleActivityBarView("tunnels");
      await flushPersist();

      expect(useAppStore.getState().layoutConfig.hiddenActivityBarViews).toEqual(["tunnels"]);
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
      expect(m.saveSettings).toHaveBeenCalledTimes(1);
    });

    it("hides an inactive view without collapsing, then un-hides it", async () => {
      m.saveSettings.mockRejectedValue(new Error("ro"));

      useAppStore.getState().toggleActivityBarView("tunnels");
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
      useAppStore.getState().toggleActivityBarView("tunnels");
      await flushPersist();

      expect(useAppStore.getState().layoutConfig.hiddenActivityBarViews).toEqual([]);
      expect(m.frontendLog).toHaveBeenCalledWith(
        "app_store",
        "Failed to persist layout config: ro"
      );
    });
  });
});

describe("tabRuntimeSlice (#2979)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("tracks the working directory per tab", () => {
    useAppStore.getState().setTabCwd("t1", "/home");
    useAppStore.getState().setTabCwd("t1", "/tmp");
    useAppStore.getState().setTabCwd("t2", "/srv");
    expect(useAppStore.getState().tabCwds).toEqual({ t1: "/tmp", t2: "/srv" });
  });

  it("tracks horizontal scrolling per tab", () => {
    useAppStore.getState().setTabHorizontalScrolling("t1", true);
    useAppStore.getState().setTabHorizontalScrolling("t2", false);
    expect(useAppStore.getState().tabHorizontalScrolling).toEqual({ t1: true, t2: false });
  });

  it("sets and clears a tab color", () => {
    useAppStore.getState().setTabColor("t1", "#f00");
    useAppStore.getState().setTabColor("t2", "#0f0");
    useAppStore.getState().setTabColor("t1", null);
    expect(useAppStore.getState().tabColors).toEqual({ t2: "#0f0" });
  });
});

describe("panelZoomSlice.toggleZoomActiveTab (#2979)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("zooms the first panel's tab when the active panel id is stale", () => {
    useAppStore.getState().addTab("bash", "local");
    const leaf = layoutState().rootPanel;
    seedLayoutState({ activePanelId: "gone" });

    useAppStore.getState().toggleZoomActiveTab();

    expect(useAppStore.getState().zoomedTabId).toBe(
      leaf.type === "leaf" ? leaf.activeTabId : undefined
    );
  });

  it("does nothing when the active panel has no tab", () => {
    const empty = createLeafPanel();
    seedLayoutState({ rootPanel: empty, activePanelId: empty.id });

    useAppStore.getState().toggleZoomActiveTab();

    expect(useAppStore.getState().zoomedTabId).toBeNull();
  });
});
