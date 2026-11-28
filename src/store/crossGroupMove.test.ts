/**
 * Moving a dragged tab from the group it was dragged out of into a panel of the
 * group a dwell switched to (tab-groups concept, #6201).
 */
import { describe, it, expect } from "vitest";
import type { LeafPanel, PanelNode, TabGroup, TerminalTab } from "@/types/terminal";
import { getAllLeaves, findLeaf } from "@/utils/panelTree";
import { moveTabAcrossGroups } from "./crossGroupMove";

const tab = (id: string, panelId: string): TerminalTab =>
  ({ id, panelId, title: id, isActive: false }) as unknown as TerminalTab;
const leaf = (id: string, tabs: string[]): LeafPanel => ({
  type: "leaf",
  id,
  tabs: tabs.map((t) => tab(t, id)),
  activeTabId: tabs[0] ?? null,
});

function layout(): { rootPanel: PanelNode; tabGroups: TabGroup[]; activeTabGroupId: string } {
  // g1 (the drag's source, now inactive) holds two panels; g2 is active.
  const g1: PanelNode = {
    type: "split",
    id: "s1",
    direction: "horizontal",
    children: [leaf("p1", ["a", "b"]), leaf("p2", ["c"])],
  };
  const g2 = leaf("q1", ["x"]);
  return {
    rootPanel: g2,
    tabGroups: [
      { id: "g1", name: "One", rootPanel: g1, activePanelId: "p1" } as TabGroup,
      { id: "g2", name: "Two", rootPanel: g2, activePanelId: "q1" } as TabGroup,
    ],
    activeTabGroupId: "g2",
  };
}

const tabsOf = (node: PanelNode) => getAllLeaves(node).flatMap((l) => l.tabs.map((t) => t.id));

describe("moveTabAcrossGroups", () => {
  it("a centre drop stacks the tab into the target panel of the active group", () => {
    const next = moveTabAcrossGroups(layout(), {
      tabId: "a",
      fromGroupId: "g1",
      toGroupId: "g2",
      fromPanelId: "p1",
      toPanelId: "q1",
      edge: "center",
    })!;
    expect(tabsOf(next.rootPanel)).toEqual(["x", "a"]);
    const moved = findLeaf(next.rootPanel, "q1")!;
    expect(moved.activeTabId).toBe("a");
    expect(moved.tabs.find((t) => t.id === "a")?.panelId).toBe("q1");
    expect(next.activePanelId).toBe("q1");
    const source = next.tabGroups.find((g) => g.id === "g1")!;
    expect(tabsOf(source.rootPanel)).toEqual(["b", "c"]);
  });

  it("an edge drop splits the target panel with a new panel holding the tab", () => {
    const next = moveTabAcrossGroups(layout(), {
      tabId: "a",
      fromGroupId: "g1",
      toGroupId: "g2",
      fromPanelId: "p1",
      toPanelId: "q1",
      edge: "right",
    })!;
    const leaves = getAllLeaves(next.rootPanel);
    expect(leaves).toHaveLength(2);
    expect(leaves[0].id).toBe("q1");
    expect(leaves[1].tabs.map((t) => t.id)).toEqual(["a"]);
    expect(next.rootPanel.type === "split" && next.rootPanel.direction).toBe("horizontal");
    expect(next.activePanelId).toBe(leaves[1].id);
  });

  it("with no target panel, the tab goes to the active group's first panel", () => {
    const next = moveTabAcrossGroups(layout(), {
      tabId: "c",
      fromGroupId: "g1",
      toGroupId: "g2",
      fromPanelId: "p2",
      toPanelId: null,
      edge: "center",
    })!;
    expect(tabsOf(next.rootPanel)).toEqual(["x", "c"]);
  });

  it("prunes the source panel it emptied, keeping the source group's other panels", () => {
    const next = moveTabAcrossGroups(layout(), {
      tabId: "c",
      fromGroupId: "g1",
      toGroupId: "g2",
      fromPanelId: "p2",
      toPanelId: "q1",
      edge: "center",
    })!;
    const source = next.tabGroups.find((g) => g.id === "g1")!;
    expect(getAllLeaves(source.rootPanel).map((l) => l.id)).toEqual(["p1"]);
    expect(source.activePanelId).toBe("p1");
  });

  it.each([
    ["the source is the active group", { fromGroupId: "g2", fromPanelId: "q1", tabId: "x" }],
    ["the source group is unknown", { fromGroupId: "gone", fromPanelId: "p1", tabId: "a" }],
    ["the tab is not in the source panel", { fromGroupId: "g1", fromPanelId: "p2", tabId: "a" }],
  ])("returns null when %s", (_why, move) => {
    expect(
      moveTabAcrossGroups(layout(), { toGroupId: "g2", toPanelId: "q1", edge: "center", ...move })
    ).toBeNull();
  });

  it("puts the tab into the first panel of a group that is not the active one", () => {
    const three = layout();
    three.tabGroups.push({
      id: "g3",
      name: "Three",
      rootPanel: leaf("r1", ["z"]),
      activePanelId: "r1",
    } as TabGroup);
    const next = moveTabAcrossGroups(three, {
      tabId: "a",
      fromGroupId: "g1",
      toGroupId: "g3",
      fromPanelId: "p1",
      toPanelId: null,
      edge: "center",
    })!;
    const g3 = next.tabGroups.find((g) => g.id === "g3")!;
    expect(tabsOf(g3.rootPanel)).toEqual(["z", "a"]);
    expect(next.rootPanel).toBe(three.rootPanel); // the visible group is untouched
  });

  it("returns null for a target panel that is not in the target group", () => {
    expect(
      moveTabAcrossGroups(layout(), {
        tabId: "a",
        fromGroupId: "g1",
        toGroupId: "g2",
        fromPanelId: "p1",
        toPanelId: "p2",
        edge: "center",
      })
    ).toBeNull();
  });
});
