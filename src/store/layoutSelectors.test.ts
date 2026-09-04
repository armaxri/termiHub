/**
 * `layoutSelectors` (#2562) — the single region-derived read surface that funnels
 * every component/hook/util read of `appStore.rootPanel` / `tabGroups` /
 * `activePanelId` / `activeTabGroupId`. These tests pin that each accessor mirrors
 * the current field exactly, and that the derived helpers reproduce the
 * group-tree / all-tabs idioms they replaced byte-for-byte, so the later field
 * deletion has a behaviour-preserving seam to swap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import type { PanelNode, TabGroup, TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";

import { useAppStore } from "./appStore";
import { seedLayoutState } from "@/test/layoutState";
import {
  activeTreeTabs,
  getActivePanelId,
  getActiveTabGroupId,
  getAllTabsAcrossGroupTrees,
  getLayoutRenderTree,
  getLayoutTabGroups,
  groupRenderTree,
  groupRenderTreesOf,
} from "./layoutSelectors";

function tab(id: string): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "local",
    contentType: "terminal",
    config: {} as TerminalTab["config"],
    panelId: "p",
    isActive: false,
  } as TerminalTab;
}

function leaf(id: string, tabs: TerminalTab[]): PanelNode {
  return { type: "leaf", id, tabs, activeTabId: tabs[0]?.id ?? null };
}

function group(id: string, root: PanelNode): TabGroup {
  return { id, name: id, rootPanel: root, activePanelId: root.id };
}

describe("layoutSelectors", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  describe("field accessors mirror the store", () => {
    it("return the current mirror-field values", () => {
      const activeRoot = leaf("A", [tab("t1")]);
      const groups = [group("g1", activeRoot), group("g2", leaf("B", [tab("t2")]))];
      seedLayoutState({
        rootPanel: activeRoot,
        tabGroups: groups,
        activeTabGroupId: "g1",
        activePanelId: "A",
      });

      // The accessors compose from the region view (#2562), so they return a
      // freshly-composed tree (structurally equal, not the same object ref).
      const tree = getLayoutRenderTree();
      expect(tree.id).toBe("A");
      expect(getAllLeaves(tree).flatMap((l) => l.tabs.map((t) => t.id))).toEqual(["t1"]);
      expect(getLayoutTabGroups().map((g) => g.id)).toEqual(["g1", "g2"]);
      expect(getActiveTabGroupId()).toBe("g1");
      expect(getActivePanelId()).toBe("A");
    });
  });

  describe("groupRenderTree", () => {
    it("serves the live active tree for the active group, stored tree otherwise", () => {
      const activeTree = leaf("live", [tab("t1")]);
      const g1 = group("g1", leaf("stale", [tab("old")]));
      const g2 = group("g2", leaf("B", [tab("t2")]));

      expect(groupRenderTree(g1, activeTree, "g1")).toBe(activeTree);
      expect(groupRenderTree(g2, activeTree, "g1")).toBe(g2.rootPanel);
    });
  });

  describe("groupRenderTreesOf", () => {
    it("maps every group to its render tree (active → live rootPanel)", () => {
      const activeRoot = leaf("live", [tab("t1")]);
      const g1 = group("g1", leaf("stale", [tab("old")]));
      const g2 = group("g2", leaf("B", [tab("t2")]));
      seedLayoutState({
        rootPanel: activeRoot,
        tabGroups: [g1, g2],
        activeTabGroupId: "g1",
        activePanelId: "live",
      });

      const trees = groupRenderTreesOf(useAppStore.getState());
      expect(trees.map((t) => getAllLeaves(t).flatMap((l) => l.tabs.map((x) => x.id)))).toEqual([
        ["t1"],
        ["t2"],
      ]);
    });
  });

  describe("activeTreeTabs", () => {
    it("returns every tab of the active render tree", () => {
      const activeRoot: PanelNode = {
        type: "split",
        id: "root",
        direction: "horizontal",
        children: [leaf("a", [tab("t1"), tab("t2")]), leaf("b", [tab("t3")])],
      };
      seedLayoutState({
        rootPanel: activeRoot,
        tabGroups: [group("g1", activeRoot)],
        activeTabGroupId: "g1",
        activePanelId: "a",
      });

      expect(activeTreeTabs(useAppStore.getState()).map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    });
  });

  describe("getAllTabsAcrossGroupTrees", () => {
    it("unions every group's composed tree (active group appears once)", () => {
      const activeRoot = leaf("A", [tab("t1")]);
      const g1 = group("g1", leaf("A-stale", [tab("t1")]));
      const g2 = group("g2", leaf("B", [tab("t2")]));
      seedLayoutState({
        rootPanel: activeRoot,
        tabGroups: [g1, g2],
        activeTabGroupId: "g1",
        activePanelId: "A",
      });

      // Post-#2562 the composed active-group entry is the live tree, so there is no
      // stale duplicate: g1 → t1, g2 → t2. The `.find()` callers still match.
      expect(getAllTabsAcrossGroupTrees().map((t) => t.id)).toEqual(["t1", "t2"]);
    });
  });
});
