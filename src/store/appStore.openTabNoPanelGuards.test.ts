import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Branch-coverage suite (TFE-005) for the "no target panel" bail-outs shared by
 * every open-in-panel / tab-opening action in appStore.
 *
 * Each of these actions resolves a `targetPanelId` as
 * `state.activePanelId ?? getAllLeaves(rootPanel)[0]?.id` and guards with
 * `if (!targetPanelId) return state;` (or an equivalent no-tab early return).
 * That guard only fires in the degenerate layout where the panel tree has **no
 * leaves at all** and no active panel — e.g. a corrupt/empty restored layout.
 * The guard's job is to keep the action a **safe no-op** in that state: it must
 * neither throw nor create a tab against an undefined panel id (which would
 * corrupt the tree / the by-id content map). These branches were previously
 * unexecuted; the tests drive the zero-leaf state and assert the safe no-op plus
 * each action's still-correct side effect.
 */

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

import { useAppStore } from "./appStore";
import { seedLayoutState, layoutState } from "@/test/layoutState";
import { getAllLeaves } from "@/utils/panelTree";
import type { SplitContainer } from "@/types/terminal";

/** A panel tree with zero leaves: an empty split, plus no active panel. This is
 * the only shape that makes `targetPanelId` resolve to undefined. */
function seedZeroLeafLayout(): void {
  const emptyRoot: SplitContainer = {
    type: "split",
    id: "root-empty",
    direction: "horizontal",
    children: [],
    sizes: [],
  };
  seedLayoutState({ rootPanel: emptyRoot, activePanelId: null });
}

/** Total number of tabs across the (composed) panel tree. */
function totalTabs(): number {
  return getAllLeaves(layoutState().rootPanel).reduce((n, leaf) => n + leaf.tabs.length, 0);
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  seedZeroLeafLayout();
});

describe("TFE-005 — open-in-panel actions no-op safely with no target panel", () => {
  it("preconditions: the seeded layout has zero leaves and no active panel", () => {
    expect(getAllLeaves(layoutState().rootPanel)).toHaveLength(0);
    expect(layoutState().activePanelId).toBeNull();
    expect(totalTabs()).toBe(0);
  });

  it("addTab returns an empty id and creates no tab", () => {
    const id = useAppStore.getState().addTab("Shell", "local", undefined, undefined);
    expect(id).toBe("");
    expect(totalTabs()).toBe(0);
    expect(getAllLeaves(layoutState().rootPanel)).toHaveLength(0);
  });

  it("openSettingsTab creates no tab but still records the deep-link target", () => {
    useAppStore.getState().openSettingsTab({ category: "general" });
    expect(totalTabs()).toBe(0);
    // The bail-out still returns the nav intent, so the pending category sticks.
    expect(useAppStore.getState().pendingSettingsCategory).toBe("general");
  });

  it("openLogViewerTab creates no tab", () => {
    useAppStore.getState().openLogViewerTab();
    expect(totalTabs()).toBe(0);
  });

  it("openNetworkDiagnosticTab creates no tab", () => {
    useAppStore.getState().openNetworkDiagnosticTab("ping", "example.com");
    expect(totalTabs()).toBe(0);
  });

  it("openEditorTab creates no tab", () => {
    useAppStore.getState().openEditorTab("/tmp/file.txt", false, undefined, undefined);
    expect(totalTabs()).toBe(0);
  });

  it("openScratchEditorTab creates no tab", () => {
    useAppStore.getState().openScratchEditorTab("Scratch", "scratch.txt", "hello");
    expect(totalTabs()).toBe(0);
  });

  it("openConnectionEditorTab creates no tab", () => {
    useAppStore.getState().openConnectionEditorTab("conn-1", null);
    expect(totalTabs()).toBe(0);
  });

  it("openAgentDefinitionEditorTab creates no tab", () => {
    useAppStore.getState().openAgentDefinitionEditorTab("agent-1", "def-1", null);
    expect(totalTabs()).toBe(0);
  });

  it("openTunnelEditorTab creates no tab", () => {
    useAppStore.getState().openTunnelEditorTab(null);
    expect(totalTabs()).toBe(0);
  });

  it("openWorkspaceEditorTab creates no tab", () => {
    useAppStore.getState().openWorkspaceEditorTab(null);
    expect(totalTabs()).toBe(0);
  });

  it("selectPlugin creates no tab but still marks the plugin selected", () => {
    useAppStore.getState().selectPlugin("plugin-x");
    expect(totalTabs()).toBe(0);
    // The bail-out still returns { selectedPluginId }, so selection is recorded.
    expect(useAppStore.getState().selectedPluginId).toBe("plugin-x");
  });
});
