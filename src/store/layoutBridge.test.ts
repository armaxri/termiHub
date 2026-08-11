/**
 * Unit tests for the layout projection bridge (#2151 step 2): the rich⇄minimal
 * tree mapping, the reconcile that re-hydrates minimal-tab diffs into rich
 * `TerminalTab`s by id, and the feature flag. The dispatch/subscribe round-trip
 * is exercised at the appStore level in `appStore.layoutBridge.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";

import type { PanelNode, TabContent, TerminalTab } from "@/types/terminal";

import {
  buildLayoutSnapshot,
  collectTabs,
  composeRenderTree,
  type LayoutSnapshot,
  type LayoutView,
  layoutIntentsEnabled,
  layoutRenderFromProjectionEnabled,
  minimalNodesEqual,
  reconcileNode,
  setLayoutIntentsEnabled,
  setLayoutRenderFromProjectionEnabled,
  toMinimalNode,
  viewMatchesTree,
} from "./layoutBridge";
import type { TabGroup } from "@/types/terminal";

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
  /** The projected multi-group view of `tree()`: a single active group `g1`
   * holding the tree, focused on panel `a` (#2283 slice C). */
  function view(): LayoutView {
    return {
      groups: [{ id: "g1", name: "Main", root: toMinimalNode(tree()), activePanelId: "a" }],
      activeGroupId: "g1",
    };
  }

  /** A single-group `appStore` snapshot mirroring `view()`. */
  function snapshot(root: PanelNode = tree(), activePanelId: string | null = "a"): LayoutSnapshot {
    const groups: TabGroup[] = [{ id: "g1", name: "Main", rootPanel: root, activePanelId }];
    return buildLayoutSnapshot(groups, "g1", root, activePanelId);
  }

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

  it("viewMatchesTree: true only when structure AND active panel align", () => {
    expect(viewMatchesTree(view(), snapshot())).toBe(true);
    // Active panel differs.
    expect(viewMatchesTree(view(), snapshot(tree(), "b"))).toBe(false);
    // A view missing a tab appStore still has (local add not yet in the region).
    const stale: LayoutView = {
      groups: [
        {
          id: "g1",
          name: "Main",
          root: toMinimalNode({
            type: "split",
            id: "root",
            direction: "horizontal",
            sizes: [50, 50],
            children: [
              { type: "leaf", id: "a", tabs: [tab("t1")], activeTabId: "t1" },
              { type: "leaf", id: "b", tabs: [tab("t3")], activeTabId: "t3" },
            ],
          }),
          activePanelId: "a",
        },
      ],
      activeGroupId: "g1",
    };
    expect(viewMatchesTree(stale, snapshot())).toBe(false);
    expect(viewMatchesTree(null, snapshot())).toBe(false);
  });

  it("viewMatchesTree (multi-group): all groups must match, in order (#2283)", () => {
    // Two groups: g1 active holding the tree, g2 a single leaf.
    const g2Root: PanelNode = { type: "leaf", id: "z", tabs: [tab("t9")], activeTabId: "t9" };
    const groups: TabGroup[] = [
      { id: "g1", name: "Main", rootPanel: tree(), activePanelId: "a" },
      { id: "g2", name: "Second", rootPanel: g2Root, activePanelId: "z" },
    ];
    const snap = buildLayoutSnapshot(groups, "g1", tree(), "a");
    const mirror: LayoutView = {
      groups: [
        { id: "g1", name: "Main", root: toMinimalNode(tree()), activePanelId: "a" },
        { id: "g2", name: "Second", root: toMinimalNode(g2Root), activePanelId: "z" },
      ],
      activeGroupId: "g1",
    };
    expect(viewMatchesTree(mirror, snap)).toBe(true);

    // A non-active group's tree drifts → the whole gate fails (forces a reseed).
    const drifted: LayoutView = {
      ...mirror,
      groups: [
        mirror.groups[0],
        { id: "g2", name: "Second", root: toMinimalNode(tree()), activePanelId: "a" },
      ],
    };
    expect(viewMatchesTree(drifted, snap)).toBe(false);

    // Group metadata (name) drifts → fails.
    const renamed: LayoutView = {
      ...mirror,
      groups: [{ ...mirror.groups[0], name: "Renamed" }, mirror.groups[1]],
    };
    expect(viewMatchesTree(renamed, snap)).toBe(false);

    // activeGroupId differs → fails.
    expect(viewMatchesTree({ ...mirror, activeGroupId: "g2" }, snap)).toBe(false);

    // Group order / count differs → fails.
    expect(viewMatchesTree({ ...mirror, groups: [mirror.groups[1], mirror.groups[0]] }, snap)).toBe(
      false
    );
    expect(viewMatchesTree({ ...mirror, groups: [mirror.groups[0]] }, snap)).toBe(false);
  });

  it("composeRenderTree (multi-group): composes the active group whichever it is (#2283)", () => {
    // g1 = tree(); g2 = a single-leaf tree. The composed output tracks the active
    // group, and tab/panel ids are preserved (xterm reparents, never remounts).
    const g2Root: PanelNode = {
      type: "leaf",
      id: "z",
      tabs: [tab("t9")],
      activeTabId: "t9",
    };
    const two: LayoutView = {
      groups: [
        { id: "g1", name: "Main", root: toMinimalNode(tree()), activePanelId: "a" },
        { id: "g2", name: "Second", root: toMinimalNode(g2Root), activePanelId: "z" },
      ],
      activeGroupId: "g1",
    };
    // Active = g1 → composes tree() from g1's rich root (structure preserved;
    // reconcile re-derives panelId/isActive).
    expect(toMinimalNode(composeRenderTree(two, tree()))).toEqual(toMinimalNode(tree()));
    // Switch active to g2 → composes the g2 tree from g2's rich root, ids intact.
    const g2 = composeRenderTree({ ...two, activeGroupId: "g2" }, g2Root) as Extract<
      PanelNode,
      { type: "leaf" }
    >;
    expect(g2.id).toBe("z");
    expect(g2.tabs.map((t) => t.id)).toEqual(["t9"]);
  });

  it("composeRenderTree: structure from the view, rich content from appStore by id", () => {
    const rich = composeRenderTree(view(), tree()) as Extract<PanelNode, { type: "split" }>;
    const leafA = rich.children[0] as Extract<PanelNode, { type: "leaf" }>;
    // Same structure as the source tree, with rich fields re-hydrated.
    expect(leafA.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(leafA.tabs[0].title).toBe("Tab t1");
    expect(leafA.tabs[0].isActive).toBe(true);
    expect(leafA.tabs[0].panelId).toBe("a");
    expect(rich.sizes).toEqual([50, 50]);
  });

  it("composeRenderTree: content sourced from the tabContent map when present (#2283)", () => {
    // The by-id content map wins over the in-tree tab: t1's title comes from the
    // map, proving the render composition reads content from the map seam.
    const contentById = {
      t1: { ...content("t1"), title: "From map" },
      t2: content("t2"),
      t3: content("t3"),
    };
    const rich = composeRenderTree(view(), tree(), contentById) as Extract<
      PanelNode,
      { type: "split" }
    >;
    const leafA = rich.children[0] as Extract<PanelNode, { type: "leaf" }>;
    expect(leafA.tabs[0].title).toBe("From map");
    // Structure is still re-derived from the view, not the map.
    expect(leafA.tabs[0].panelId).toBe("a");
    expect(leafA.tabs[0].isActive).toBe(true);
  });

  it("composeRenderTree: falls back to the in-tree tab for ids absent from the map (#2283)", () => {
    // Only t1 is in the map; t2/t3 must fall back to the in-tree TerminalTab so
    // not-yet-mapped tabs render exactly as before.
    const contentById = { t1: { ...content("t1"), title: "Mapped t1" } };
    const rich = composeRenderTree(view(), tree(), contentById) as Extract<
      PanelNode,
      { type: "split" }
    >;
    const leafA = rich.children[0] as Extract<PanelNode, { type: "leaf" }>;
    expect(leafA.tabs[0].title).toBe("Mapped t1"); // from map
    expect(leafA.tabs[1].title).toBe("Tab t2"); // fallback to in-tree
    const leafB = rich.children[1] as Extract<PanelNode, { type: "leaf" }>;
    expect(leafB.tabs[0].title).toBe("Tab t3"); // fallback to in-tree
  });

  it("composeRenderTree output is identical whether content comes from the map or the tree (#2283)", () => {
    // Parity: a map that faithfully mirrors the tree yields byte-identical output.
    const contentById = { t1: content("t1"), t2: content("t2"), t3: content("t3") };
    const fromTree = composeRenderTree(view(), tree());
    const fromMap = composeRenderTree(view(), tree(), contentById);
    expect(fromMap).toEqual(fromTree);
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

describe("layoutBridge — feature flags", () => {
  afterEach(() => {
    setLayoutIntentsEnabled(null);
    setLayoutRenderFromProjectionEnabled(null);
  });

  it("mutation cut is on by default (#2184: GUI-verified parity-clean)", () => {
    setLayoutIntentsEnabled(null);
    expect(layoutIntentsEnabled()).toBe(true);
  });

  it("render cut is on by default (step 3: parity-safe by construction)", () => {
    setLayoutRenderFromProjectionEnabled(null);
    expect(layoutRenderFromProjectionEnabled()).toBe(true);
  });

  it("honours programmatic overrides on each flag independently", () => {
    setLayoutIntentsEnabled(true);
    expect(layoutIntentsEnabled()).toBe(true);
    setLayoutIntentsEnabled(false);
    expect(layoutIntentsEnabled()).toBe(false);

    setLayoutRenderFromProjectionEnabled(false);
    expect(layoutRenderFromProjectionEnabled()).toBe(false);
    setLayoutRenderFromProjectionEnabled(true);
    expect(layoutRenderFromProjectionEnabled()).toBe(true);
  });
});
