/**
 * Unit tests for the layout projection bridge (#2151 / #2283): the rich⇄minimal
 * tree mapping and the reconcile that re-hydrates minimal-tab diffs into rich
 * `TerminalTab`s by id. The dispatch/subscribe round-trip is exercised at the
 * appStore level in `appStore.layoutBridge.test.ts`; on-demand composition from a
 * region view in `appStore.layoutComposition.test.ts`.
 */
import { describe, it, expect } from "vitest";

import type { PanelNode, TabContent, TerminalTab } from "@/types/terminal";

import {
  collectTabs,
  composeLayoutFromView,
  type LayoutView,
  minimalNodesEqual,
  pruneDanglingTabs,
  reconcileLayoutFromView,
  reconcileNode,
  toMinimalNode,
} from "./layoutBridge";

function tab(id: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "local",
    contentType: "terminal",
    config: {} as TerminalTab["config"],
    panelId: "orig",
    isActive: false,
    ...extra,
  } as TerminalTab;
}

/** The non-structural content of a `tab(id)` — its {@link TabContent} form. */
function content(id: string, extra: Partial<TabContent> = {}): TabContent {
  const { panelId: _p, isActive: _a, ...rest } = tab(id);
  return { ...rest, ...extra };
}

/** Two-leaf split: `a` = [t1(active), t2], `b` = [t3]. */
function tree(): PanelNode {
  return {
    type: "split",
    id: "root",
    direction: "horizontal",
    sizes: [50, 50],
    children: [
      { type: "leaf", id: "a", tabs: [tab("t1"), tab("t2")], activeTabId: "t1" },
      { type: "leaf", id: "b", tabs: [tab("t3")], activeTabId: "t3" },
    ],
  };
}

describe("layoutBridge — tree mapping", () => {
  it("toMinimalNode strips tabs to the projected minimal form", () => {
    const min = toMinimalNode(tree());
    expect(min).toEqual({
      type: "split",
      id: "root",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        {
          type: "leaf",
          id: "a",
          tabs: [
            { id: "t1", sessionId: "sess-t1", contentType: "terminal" },
            { id: "t2", sessionId: "sess-t2", contentType: "terminal" },
          ],
          activeTabId: "t1",
        },
        {
          type: "leaf",
          id: "b",
          tabs: [{ id: "t3", sessionId: "sess-t3", contentType: "terminal" }],
          activeTabId: "t3",
        },
      ],
    });
  });

  it("collectTabs indexes every rich tab by id", () => {
    const map = collectTabs(tree());
    expect([...map.keys()].sort()).toEqual(["t1", "t2", "t3"]);
    expect(map.get("t1")?.title).toBe("Tab t1");
  });

  it("reconcileNode re-hydrates rich tabs and re-derives panelId + isActive", () => {
    const tabsById = collectTabs(tree());
    // A projected tree where t1 moved from a into b; b now active on t1.
    const projected = {
      type: "split" as const,
      id: "root",
      direction: "horizontal" as const,
      sizes: [50, 50],
      children: [
        {
          type: "leaf" as const,
          id: "a",
          tabs: [{ id: "t2", contentType: "terminal" }],
          activeTabId: "t2",
        },
        {
          type: "leaf" as const,
          id: "b",
          tabs: [
            { id: "t3", contentType: "terminal" },
            { id: "t1", contentType: "terminal" },
          ],
          activeTabId: "t1",
        },
      ],
    };
    const rich = reconcileNode(projected, tabsById) as Extract<PanelNode, { type: "split" }>;

    const leafB = rich.children[1] as Extract<PanelNode, { type: "leaf" }>;
    expect(leafB.tabs.map((t) => t.id)).toEqual(["t3", "t1"]);
    // Rich fields survive; panelId follows the containing leaf; isActive tracks activeTabId.
    const t1 = leafB.tabs.find((t) => t.id === "t1")!;
    expect(t1.title).toBe("Tab t1");
    expect(t1.panelId).toBe("b");
    expect(t1.isActive).toBe(true);
    expect(leafB.tabs.find((t) => t.id === "t3")!.isActive).toBe(false);
    // The split preserves geometry.
    expect(rich.sizes).toEqual([50, 50]);
  });

  it("reconcileNode throws on a tab absent from the index (triggers local fallback)", () => {
    const projected = {
      type: "leaf" as const,
      id: "a",
      tabs: [{ id: "ghost", contentType: "terminal" }],
      activeTabId: "ghost",
    };
    expect(() => reconcileNode(projected, new Map())).toThrow(/unknown tab ghost/);
  });
});

describe("layoutBridge — render-from-projection helpers (#2151 step 3)", () => {
  it("minimalNodesEqual: a tree equals its own minimal projection", () => {
    expect(minimalNodesEqual(toMinimalNode(tree()), toMinimalNode(tree()))).toBe(true);
  });

  it("minimalNodesEqual: sensitive to tab order, active tab, sizes, and direction", () => {
    const base = toMinimalNode(tree());
    const reordered = toMinimalNode({
      type: "split",
      id: "root",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "leaf", id: "a", tabs: [tab("t2"), tab("t1")], activeTabId: "t1" },
        { type: "leaf", id: "b", tabs: [tab("t3")], activeTabId: "t3" },
      ],
    });
    expect(minimalNodesEqual(base, reordered)).toBe(false);

    const otherActive = toMinimalNode({
      type: "split",
      id: "root",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "leaf", id: "a", tabs: [tab("t1"), tab("t2")], activeTabId: "t2" },
        { type: "leaf", id: "b", tabs: [tab("t3")], activeTabId: "t3" },
      ],
    });
    expect(minimalNodesEqual(base, otherActive)).toBe(false);
  });

  it("reconcileNode: falls back to the tree, then throws only when absent from BOTH sources (#2283)", () => {
    const projected = {
      type: "leaf" as const,
      id: "a",
      tabs: [{ id: "ghost", contentType: "terminal" }],
      activeTabId: "ghost",
    };
    // Present in the content map (not the tree) → resolves via the map.
    const viaMap = reconcileNode(projected, new Map(), { ghost: content("ghost") });
    expect((viaMap as Extract<PanelNode, { type: "leaf" }>).tabs[0].title).toBe("Tab ghost");
    // Absent from both an empty tree index and an empty map → throws.
    expect(() => reconcileNode(projected, new Map(), {})).toThrow(/unknown tab ghost/);
  });
});

describe("layoutBridge — dangling-tab reconcile (SM-024)", () => {
  function view(root: PanelNode = tree()): LayoutView {
    return {
      groups: [{ id: "g1", name: "Main", root: toMinimalNode(root), activePanelId: "a" }],
      activeGroupId: "g1",
    };
  }
  const allContent = (): Record<string, TabContent> => ({
    t1: content("t1"),
    t2: content("t2"),
    t3: content("t3"),
  });

  it("returns the same view object when every tab has content", () => {
    const v = view();
    const pruned = pruneDanglingTabs(v, allContent());
    expect(pruned.view).toBe(v);
    expect(pruned.droppedTabIds).toEqual([]);
  });

  it("drops dangling tabs and keeps panel ids and tree shape", () => {
    const { t2: _drop, ...c } = allContent();
    const pruned = pruneDanglingTabs(view(), c);
    expect(pruned.droppedTabIds).toEqual(["t2"]);
    const root = pruned.view.groups[0].root;
    expect(root.type).toBe("split");
    if (root.type !== "split") return;
    expect(root.children.map((n) => n.id)).toEqual(["a", "b"]);
    const a = root.children[0];
    expect(a.type === "leaf" && a.tabs.map((t) => t.id)).toEqual(["t1"]);
  });

  it("repairs a leaf whose active tab was dropped (positional fallback)", () => {
    const { t1: _drop, ...c } = allContent();
    const a = pruneDanglingTabs(view(), c).view.groups[0].root;
    const leafA = a.type === "split" ? a.children[0] : a;
    expect(leafA.type === "leaf" && leafA.activeTabId).toBe("t2");
  });

  it("leaves an emptied leaf in place with no active tab", () => {
    const { t3: _drop, ...c } = allContent();
    const r = pruneDanglingTabs(view(), c).view.groups[0].root;
    const leafB = r.type === "split" ? r.children[1] : r;
    expect(leafB).toMatchObject({ type: "leaf", id: "b", tabs: [], activeTabId: null });
  });

  it("composes leniently where the strict compose returns null", () => {
    const { t2: _drop, ...c } = allContent();
    expect(composeLayoutFromView(view(), c, {})).toBeNull();
    const reconciled = reconcileLayoutFromView(view(), c, {});
    expect(reconciled?.droppedTabIds).toEqual(["t2"]);
    expect(collectTabs(reconciled!.composed.rootPanel).has("t2")).toBe(false);
    expect(collectTabs(reconciled!.composed.rootPanel).has("t1")).toBe(true);
  });

  it("is identical to the strict compose when nothing dangles", () => {
    const strict = composeLayoutFromView(view(), allContent(), {});
    const lenient = reconcileLayoutFromView(view(), allContent(), {});
    expect(lenient?.droppedTabIds).toEqual([]);
    expect(lenient?.composed).toEqual(strict);
  });

  it("returns null for an absent or group-less view", () => {
    expect(reconcileLayoutFromView(undefined, allContent(), {})).toBeNull();
    expect(reconcileLayoutFromView({ groups: [], activeGroupId: "" }, allContent(), {})).toBeNull();
  });
});
