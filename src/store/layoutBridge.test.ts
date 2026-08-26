/**
 * Unit tests for the layout projection bridge (#2151 / #2283): the rich⇄minimal
 * tree mapping, the reconcile that re-hydrates minimal-tab diffs into rich
 * `TerminalTab`s by id, and `composeLayoutState` (the region→appStore mirror's
 * core). The dispatch/subscribe round-trip is exercised at the appStore level in
 * `appStore.layoutBridge.test.ts`.
 */
import { describe, it, expect } from "vitest";

import type { PanelNode, TabContent, TerminalTab } from "@/types/terminal";

import {
  buildLayoutSnapshot,
  collectTabs,
  composeLayoutState,
  composeRenderTree,
  type LayoutView,
  minimalNodesEqual,
  reconcileNode,
  toMinimalGroup,
  toMinimalNode,
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

describe("layoutBridge — composeLayoutState (region→appStore mirror, #2283 slice E1)", () => {
  /** A well-formed tab: `panelId`/`isActive` consistent with its leaf, so a
   * reconcile round-trip reproduces it exactly (as the reducers keep them). */
  function wtab(id: string, panelId: string, active: boolean, extra: Partial<TerminalTab> = {}) {
    return tab(id, { panelId, isActive: active, ...extra });
  }

  /** Two-leaf split with consistent tab fields and a directional mark on `root`. */
  function wtree(): PanelNode {
    return {
      type: "split",
      id: "root",
      direction: "horizontal",
      sizes: [40, 60],
      lastActiveLeafId: "a",
      children: [
        {
          type: "leaf",
          id: "a",
          tabs: [wtab("t1", "a", true), wtab("t2", "a", false)],
          activeTabId: "t1",
        },
        { type: "leaf", id: "b", tabs: [wtab("t3", "b", true)], activeTabId: "t3" },
      ],
    };
  }

  function g2tree(): PanelNode {
    return { type: "leaf", id: "g2root", tabs: [wtab("t9", "g2root", true)], activeTabId: "t9" };
  }

  function contentMap(...ids: string[]): Record<string, TabContent> {
    return Object.fromEntries(ids.map((id) => [id, content(id)]));
  }

  function viewFrom(
    groups: TabGroup[],
    activeGroupId: string,
    activeRoot: PanelNode,
    activePanelId: string | null
  ): LayoutView {
    const snap = buildLayoutSnapshot(groups, activeGroupId, activeRoot, activePanelId);
    return { groups: snap.groups.map(toMinimalGroup), activeGroupId };
  }

  it("is the faithful inverse of buildLayoutSnapshot for a multi-group layout", () => {
    const g1Root = wtree();
    const groups: TabGroup[] = [
      { id: "g1", name: "Main", rootPanel: g1Root, activePanelId: "a" },
      { id: "g2", name: "Two", color: "#f00", rootPanel: g2tree(), activePanelId: "g2root" },
    ];
    const view = viewFrom(groups, "g1", g1Root, "a");
    const composed = composeLayoutState(view, g1Root, groups, contentMap("t1", "t2", "t3", "t9"));

    expect(composed).not.toBeNull();
    expect(composed!.rootPanel).toEqual(g1Root);
    expect(composed!.activePanelId).toBe("a");
    expect(composed!.activeTabGroupId).toBe("g1");
    expect(composed!.tabGroups).toEqual(groups);
    // The directional mark on `root` survives the projection round-trip.
    expect((composed!.rootPanel as { lastActiveLeafId?: string }).lastActiveLeafId).toBe("a");
  });

  it("sources content solely from tabContent, never the current tree (#2566)", () => {
    const g1Root = wtree();
    const view = viewFrom(
      [{ id: "g1", name: "Main", rootPanel: g1Root, activePanelId: "a" }],
      "g1",
      g1Root,
      "a"
    );
    // A current tree whose in-tree tab content is deliberately wrong: with the
    // fallback dropped (#2566) these stale titles must NOT leak into the result;
    // every tab's content is re-attached from `tabContent` alone.
    const staleLeafA = {
      type: "leaf" as const,
      id: "a",
      tabs: [wtab("t1", "a", true, { title: "STALE" }), wtab("t2", "a", false, { title: "STALE" })],
      activeTabId: "t1",
    };
    const staleLeafB = {
      type: "leaf" as const,
      id: "b",
      tabs: [wtab("t3", "b", true, { title: "STALE" })],
      activeTabId: "t3",
    };
    const staleTree = { ...g1Root, children: [staleLeafA, staleLeafB] } as PanelNode;
    const staleGroups: TabGroup[] = [
      { id: "g1", name: "Main", rootPanel: staleTree, activePanelId: "a" },
    ];
    const composed = composeLayoutState(view, staleTree, staleGroups, contentMap("t1", "t2", "t3"));
    // Composed from tabContent (title "Tab tN"), byte-identical to the real tree.
    expect(composed!.rootPanel).toEqual(g1Root);
  });

  it("re-attaches each tab's content from tabContent (#2566)", () => {
    const g1Root = wtree();
    const groups: TabGroup[] = [{ id: "g1", name: "Main", rootPanel: g1Root, activePanelId: "a" }];
    const view = viewFrom(groups, "g1", g1Root, "a");
    const composed = composeLayoutState(view, g1Root, groups, {
      t1: content("t1", { title: "Overridden" }),
      t2: content("t2"),
      t3: content("t3"),
    });
    const leafA = (composed!.rootPanel as { children: PanelNode[] }).children[0] as {
      tabs: TerminalTab[];
    };
    expect(leafA.tabs[0].title).toBe("Overridden");
  });

  it("keeps the active group's tabGroups entry verbatim (appStore staleness convention)", () => {
    // The active group's live tree is the top-level rootPanel; its tabGroups
    // entry is intentionally left as the last-saved (stale) tree.
    const liveRoot = wtree();
    const staleEntry: PanelNode = {
      type: "leaf",
      id: "stale",
      tabs: [wtab("t1", "stale", true)],
      activeTabId: "t1",
    };
    const groups: TabGroup[] = [
      { id: "g1", name: "Main", rootPanel: staleEntry, activePanelId: "stale" },
    ];
    const view = viewFrom(groups, "g1", liveRoot, "a");
    const composed = composeLayoutState(view, liveRoot, groups, contentMap("t1", "t2", "t3"));
    // Top-level rootPanel is the live tree; the active group's entry stays stale.
    expect(composed!.rootPanel).toEqual(liveRoot);
    expect(composed!.tabGroups[0].rootPanel).toBe(staleEntry);
  });

  it("returns null for an empty/absent view (mirror leaves appStore untouched)", () => {
    const root = wtree();
    const groups: TabGroup[] = [{ id: "g1", name: "Main", rootPanel: root, activePanelId: "a" }];
    expect(composeLayoutState(undefined, root, groups, {})).toBeNull();
    expect(composeLayoutState(null, root, groups, {})).toBeNull();
    expect(composeLayoutState({ groups: [], activeGroupId: "g1" }, root, groups, {})).toBeNull();
  });

  it("returns null when the view references a tab absent from tabContent (transient guard)", () => {
    const root = wtree();
    const groups: TabGroup[] = [{ id: "g1", name: "Main", rootPanel: root, activePanelId: "a" }];
    const ghost: LayoutView = {
      groups: [
        {
          id: "g1",
          name: "Main",
          root: {
            type: "leaf",
            id: "a",
            tabs: [{ id: "ghost", contentType: "terminal" }],
            activeTabId: "ghost",
          },
          activePanelId: "a",
        },
      ],
      activeGroupId: "g1",
    };
    // Even with the tab present in the current tree, an id absent from tabContent
    // now yields null — the content fallback is gone (#2566); the null guard stays.
    const treeWithGhost: PanelNode = {
      type: "leaf",
      id: "a",
      tabs: [tab("ghost")],
      activeTabId: "ghost",
    };
    expect(composeLayoutState(ghost, treeWithGhost, groups, {})).toBeNull();
  });

  it("reconstructs byte-identical rich tabs of every content type from tabContent alone (#2566)", () => {
    // One tab per `TabContentType`, each carrying its representative meta. The
    // content map is the sole content source; the current tree passed to
    // composeLayoutState is intentionally EMPTY, so a byte-identical result proves
    // composition never consults the in-tree rich tabs for content.
    const rich: TerminalTab[] = [
      wtab("terminal", "leaf1", true, { contentType: "terminal" }),
      wtab("agentError", "leaf1", false, {
        contentType: "agent-error",
        agentErrorMeta: {
          agentId: "ag1",
          agentName: "Agent One",
          definitionId: "def1",
          definitionName: "Def One",
          error: "boom",
          initialCommand: "tmux attach",
        },
      }),
      wtab("settings", "leaf1", false, { contentType: "settings" }),
      wtab("editor", "leaf1", false, {
        contentType: "editor",
        editorMeta: { filePath: "/tmp/f.txt", isRemote: false },
      }),
      wtab("connEditor", "leaf1", false, {
        contentType: "connection-editor",
        connectionEditorMeta: { connectionId: "c1", folderId: null },
      }),
      wtab("logViewer", "leaf1", false, { contentType: "log-viewer" }),
      wtab("tunnelEditor", "leaf1", false, {
        contentType: "tunnel-editor",
        tunnelEditorMeta: { tunnelId: "tun1" },
      }),
      wtab("workspaceEditor", "leaf1", false, {
        contentType: "workspace-editor",
        workspaceEditorMeta: { workspaceId: "ws1" },
      }),
      wtab("netDiag", "leaf1", false, {
        contentType: "network-diagnostic",
        networkDiagnosticMeta: { tool: "ping", prefillHost: "example.com" },
      }),
      wtab("pluginDetail", "leaf1", false, {
        contentType: "plugin-detail",
        pluginDetailMeta: { pluginId: "plug1" },
      }),
      wtab("fileBrowser", "leaf1", false, { contentType: "file-browser" }),
      wtab("remoteDesktop", "leaf1", false, { contentType: "remote-desktop" }),
    ];
    const richRoot: PanelNode = {
      type: "leaf",
      id: "leaf1",
      tabs: rich,
      activeTabId: "terminal",
    };
    const groups: TabGroup[] = [
      { id: "g1", name: "Main", rootPanel: richRoot, activePanelId: "leaf1" },
    ];
    const view = viewFrom(groups, "g1", richRoot, "leaf1");

    // Full content map (from the rich tabs) is the ONLY content source. The
    // current tree handed to composeLayoutState is an empty leaf: if the dropped
    // fallback were still consulted for content, reconcile would throw → null.
    const tabContent: Record<string, TabContent> = Object.fromEntries(
      rich.map((t) => {
        const { panelId: _p, isActive: _a, ...c } = t;
        return [t.id, c];
      })
    );
    const emptyTree: PanelNode = { type: "leaf", id: "leaf1", tabs: [], activeTabId: "" };
    const emptyGroups: TabGroup[] = [
      { id: "g1", name: "Main", rootPanel: emptyTree, activePanelId: "leaf1" },
    ];

    const composed = composeLayoutState(view, emptyTree, emptyGroups, tabContent);
    expect(composed).not.toBeNull();
    // Byte-identical to the original rich tree, reconstructed from tabContent only.
    expect(composed!.rootPanel).toEqual(richRoot);
  });
});
