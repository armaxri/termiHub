import { describe, it, expect } from "vitest";
import {
  WorkspaceLayoutNode,
  WorkspaceLeafNode,
  WorkspaceSplitNode,
  WorkspaceTabDef,
  WorkspaceTabGroupDef,
} from "@/types/workspace";
import { SavedConnection } from "@/types/connection";
import { PanelNode, TabGroup, LeafPanel } from "@/types/terminal";
import {
  getWorkspaceLeaves,
  countWorkspaceTabs,
  splitWorkspaceLeaf,
  addTabToLeaf,
  removeTabFromLeaf,
  removeWorkspaceLeaf,
  updateTabInLeaf,
  addLeafToSplit,
  wrapSplitInNewDirection,
  buildPanelTreeFromWorkspace,
  buildTabGroupsFromWorkspace,
  captureAllTabGroups,
  captureCurrentLayout,
  moveTabBetweenLeaves,
  updateSplitSizes,
} from "./workspaceLayout";

function tab(ref?: string): WorkspaceTabDef {
  return { connectionRef: ref };
}

function leaf(...tabs: WorkspaceTabDef[]): WorkspaceLeafNode {
  return { type: "leaf", tabs };
}

function hsplit(...children: WorkspaceLayoutNode[]): WorkspaceSplitNode {
  return { type: "split", direction: "horizontal", children };
}

function vsplit(...children: WorkspaceLayoutNode[]): WorkspaceSplitNode {
  return { type: "split", direction: "vertical", children };
}

function hsplitSized(sizes: number[], ...children: WorkspaceLayoutNode[]): WorkspaceSplitNode {
  return { type: "split", direction: "horizontal", children, sizes };
}

function vsplitSized(sizes: number[], ...children: WorkspaceLayoutNode[]): WorkspaceSplitNode {
  return { type: "split", direction: "vertical", children, sizes };
}

describe("getWorkspaceLeaves", () => {
  it("returns single leaf", () => {
    const node = leaf(tab("a"));
    expect(getWorkspaceLeaves(node)).toHaveLength(1);
  });

  it("returns all leaves from nested splits", () => {
    const node = hsplit(leaf(tab("a")), vsplit(leaf(tab("b")), leaf(tab("c"))));
    expect(getWorkspaceLeaves(node)).toHaveLength(3);
  });

  it("returns empty tabs from leaf", () => {
    const node = leaf();
    expect(getWorkspaceLeaves(node)).toEqual([leaf()]);
  });
});

describe("countWorkspaceTabs", () => {
  it("counts single leaf tabs", () => {
    expect(countWorkspaceTabs(leaf(tab("a"), tab("b")))).toBe(2);
  });

  it("counts across nested splits", () => {
    const node = hsplit(leaf(tab("a")), vsplit(leaf(tab("b"), tab("c")), leaf(tab("d"))));
    expect(countWorkspaceTabs(node)).toBe(4);
  });

  it("returns zero for empty leaf", () => {
    expect(countWorkspaceTabs(leaf())).toBe(0);
  });
});

describe("splitWorkspaceLeaf", () => {
  it("splits a single leaf into horizontal split", () => {
    const node = leaf(tab("a"));
    const { node: result, newLeafIndex } = splitWorkspaceLeaf(node, 0, "horizontal");
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.direction).toBe("horizontal");
      expect(result.children).toHaveLength(2);
      expect(result.children[0].type).toBe("leaf");
      expect(result.children[1].type).toBe("leaf");
    }
    expect(newLeafIndex).toBe(1);
  });

  it("splits second leaf in a horizontal split", () => {
    const node = hsplit(leaf(tab("a")), leaf(tab("b")));
    const { node: result } = splitWorkspaceLeaf(node, 1, "vertical");
    expect(getWorkspaceLeaves(result)).toHaveLength(3);
  });

  it("preserves original leaf tabs", () => {
    const node = leaf(tab("a"), tab("b"));
    const { node: result } = splitWorkspaceLeaf(node, 0, "horizontal");
    const leaves = getWorkspaceLeaves(result);
    expect(leaves[0].tabs).toHaveLength(2);
    expect(leaves[1].tabs).toHaveLength(0);
  });

  it("does not modify if index out of range", () => {
    const node = leaf(tab("a"));
    const { node: result } = splitWorkspaceLeaf(node, 5, "horizontal");
    // The tree should still have only one leaf (no split occurred)
    expect(getWorkspaceLeaves(result)).toHaveLength(1);
  });
});

describe("addTabToLeaf", () => {
  it("adds tab to a leaf", () => {
    const node = leaf(tab("a"));
    const result = addTabToLeaf(node, 0, tab("b"));
    expect(result.type).toBe("leaf");
    if (result.type === "leaf") {
      expect(result.tabs).toHaveLength(2);
      expect(result.tabs[1].connectionRef).toBe("b");
    }
  });

  it("adds tab to the correct leaf in a split", () => {
    const node = hsplit(leaf(tab("a")), leaf(tab("b")));
    const result = addTabToLeaf(node, 1, tab("c"));
    const leaves = getWorkspaceLeaves(result);
    expect(leaves[0].tabs).toHaveLength(1);
    expect(leaves[1].tabs).toHaveLength(2);
    expect(leaves[1].tabs[1].connectionRef).toBe("c");
  });

  it("adds tab to empty leaf", () => {
    const node = leaf();
    const result = addTabToLeaf(node, 0, tab("a"));
    if (result.type === "leaf") {
      expect(result.tabs).toHaveLength(1);
    }
  });
});

describe("removeTabFromLeaf", () => {
  it("removes a tab by index", () => {
    const node = leaf(tab("a"), tab("b"), tab("c"));
    const result = removeTabFromLeaf(node, 0, 1);
    if (result.type === "leaf") {
      expect(result.tabs).toHaveLength(2);
      expect(result.tabs[0].connectionRef).toBe("a");
      expect(result.tabs[1].connectionRef).toBe("c");
    }
  });

  it("removes from correct leaf in split", () => {
    const node = hsplit(leaf(tab("a"), tab("b")), leaf(tab("c")));
    const result = removeTabFromLeaf(node, 0, 0);
    const leaves = getWorkspaceLeaves(result);
    expect(leaves[0].tabs).toHaveLength(1);
    expect(leaves[0].tabs[0].connectionRef).toBe("b");
  });

  it("results in empty leaf when last tab removed", () => {
    const node = leaf(tab("a"));
    const result = removeTabFromLeaf(node, 0, 0);
    if (result.type === "leaf") {
      expect(result.tabs).toHaveLength(0);
    }
  });
});

describe("removeWorkspaceLeaf", () => {
  it("returns null when removing only leaf", () => {
    const node = leaf(tab("a"));
    expect(removeWorkspaceLeaf(node, 0)).toBeNull();
  });

  it("collapses split to remaining leaf", () => {
    const node = hsplit(leaf(tab("a")), leaf(tab("b")));
    const result = removeWorkspaceLeaf(node, 0);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("leaf");
    if (result!.type === "leaf") {
      expect(result!.tabs[0].connectionRef).toBe("b");
    }
  });

  it("removes middle leaf from three-child split", () => {
    const node = hsplit(leaf(tab("a")), leaf(tab("b")), leaf(tab("c")));
    const result = removeWorkspaceLeaf(node, 1);
    expect(result).not.toBeNull();
    const leaves = getWorkspaceLeaves(result!);
    expect(leaves).toHaveLength(2);
    expect(leaves[0].tabs[0].connectionRef).toBe("a");
    expect(leaves[1].tabs[0].connectionRef).toBe("c");
  });

  it("handles nested removal with collapse", () => {
    const node = hsplit(leaf(tab("a")), vsplit(leaf(tab("b")), leaf(tab("c"))));
    const result = removeWorkspaceLeaf(node, 1); // Remove "b" leaf
    const leaves = getWorkspaceLeaves(result!);
    expect(leaves).toHaveLength(2);
  });
});

describe("updateTabInLeaf", () => {
  it("updates a tab at the given index", () => {
    const node = leaf(tab("a"), tab("b"));
    const result = updateTabInLeaf(node, 0, 1, (t) => ({ ...t, title: "Updated" }));
    if (result.type === "leaf") {
      expect(result.tabs[0].title).toBeUndefined();
      expect(result.tabs[1].title).toBe("Updated");
    }
  });

  it("updates tab in correct leaf of split", () => {
    const node = hsplit(leaf(tab("a")), leaf(tab("b")));
    const result = updateTabInLeaf(node, 1, 0, (t) => ({ ...t, initialCommand: "ls" }));
    const leaves = getWorkspaceLeaves(result);
    expect(leaves[1].tabs[0].initialCommand).toBe("ls");
  });

  it("preserves other leaves", () => {
    const node = hsplit(leaf(tab("a")), leaf(tab("b")));
    const result = updateTabInLeaf(node, 0, 0, (t) => ({ ...t, title: "X" }));
    const leaves = getWorkspaceLeaves(result);
    expect(leaves[0].tabs[0].title).toBe("X");
    expect(leaves[1].tabs[0].title).toBeUndefined();
  });
});

describe("moveTabBetweenLeaves", () => {
  it("moves a tab from one leaf to another in a horizontal split", () => {
    const node = hsplit(leaf(tab("a"), tab("b")), leaf(tab("c")));
    const result = moveTabBetweenLeaves(node, 0, 1, 1);
    const leaves = getWorkspaceLeaves(result);
    expect(leaves[0].tabs).toHaveLength(1);
    expect(leaves[0].tabs[0].connectionRef).toBe("a");
    expect(leaves[1].tabs).toHaveLength(2);
    expect(leaves[1].tabs[1].connectionRef).toBe("b");
  });

  it("removes empty source leaf when moving last tab", () => {
    const node = hsplit(leaf(tab("a")), leaf(tab("b")));
    const result = moveTabBetweenLeaves(node, 0, 0, 1);
    // Source leaf had one tab, should be removed — collapses to single leaf
    expect(result.type).toBe("leaf");
    if (result.type === "leaf") {
      expect(result.tabs).toHaveLength(2);
      expect(result.tabs[0].connectionRef).toBe("b");
      expect(result.tabs[1].connectionRef).toBe("a");
    }
  });

  it("moves a tab to an empty leaf", () => {
    const node = hsplit(leaf(tab("a"), tab("b")), leaf());
    const result = moveTabBetweenLeaves(node, 0, 0, 1);
    const leaves = getWorkspaceLeaves(result);
    expect(leaves[0].tabs).toHaveLength(1);
    expect(leaves[0].tabs[0].connectionRef).toBe("b");
    expect(leaves[1].tabs).toHaveLength(1);
    expect(leaves[1].tabs[0].connectionRef).toBe("a");
  });

  it("returns original node for same leaf index", () => {
    const node = hsplit(leaf(tab("a")), leaf(tab("b")));
    const result = moveTabBetweenLeaves(node, 0, 0, 0);
    expect(result).toBe(node);
  });

  it("returns original node for invalid from index", () => {
    const node = hsplit(leaf(tab("a")), leaf(tab("b")));
    const result = moveTabBetweenLeaves(node, 5, 0, 0);
    expect(result).toBe(node);
  });

  it("returns original node for invalid to index", () => {
    const node = hsplit(leaf(tab("a")), leaf(tab("b")));
    const result = moveTabBetweenLeaves(node, 0, 0, 5);
    expect(result).toBe(node);
  });

  it("returns original node for invalid tab index", () => {
    const node = hsplit(leaf(tab("a")), leaf(tab("b")));
    const result = moveTabBetweenLeaves(node, 0, 5, 1);
    expect(result).toBe(node);
  });
});

describe("addLeafToSplit", () => {
  it("adds a new empty leaf to a horizontal split", () => {
    const split = hsplit(leaf(tab("a")), leaf(tab("b"))) as WorkspaceSplitNode;
    const result = addLeafToSplit(split, split);
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.children).toHaveLength(3);
      expect(result.children[2].type).toBe("leaf");
      if (result.children[2].type === "leaf") {
        expect(result.children[2].tabs).toHaveLength(0);
      }
    }
  });

  it("adds a leaf to a nested split by reference", () => {
    const inner = vsplit(leaf(tab("b")), leaf(tab("c"))) as WorkspaceSplitNode;
    const root = hsplit(leaf(tab("a")), inner);
    const result = addLeafToSplit(root, inner);
    const leaves = getWorkspaceLeaves(result);
    expect(leaves).toHaveLength(4);
  });

  it("returns unchanged tree if target not found", () => {
    const root = hsplit(leaf(tab("a")), leaf(tab("b")));
    const unrelated = vsplit(leaf(tab("x"))) as WorkspaceSplitNode;
    const result = addLeafToSplit(root, unrelated);
    expect(getWorkspaceLeaves(result)).toHaveLength(2);
  });

  it("returns leaf unchanged when root is leaf", () => {
    const root = leaf(tab("a"));
    const target = vsplit(leaf(tab("x"))) as WorkspaceSplitNode;
    const result = addLeafToSplit(root, target);
    expect(result).toBe(root);
  });
});

describe("wrapSplitInNewDirection", () => {
  it("wraps a horizontal split in a vertical split", () => {
    const split = hsplit(leaf(tab("a")), leaf(tab("b"))) as WorkspaceSplitNode;
    const result = wrapSplitInNewDirection(split, split, "vertical");
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.direction).toBe("vertical");
      expect(result.children).toHaveLength(2);
      expect(result.children[0].type).toBe("split");
      expect(result.children[1].type).toBe("leaf");
    }
  });

  it("wraps a nested split by reference", () => {
    const inner = vsplit(leaf(tab("b")), leaf(tab("c"))) as WorkspaceSplitNode;
    const root = hsplit(leaf(tab("a")), inner);
    const result = wrapSplitInNewDirection(root, inner, "horizontal");
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.direction).toBe("horizontal");
      // First child is still leaf "a", second child is now a new horizontal split
      expect(result.children[0].type).toBe("leaf");
      const wrapped = result.children[1];
      expect(wrapped.type).toBe("split");
      if (wrapped.type === "split") {
        expect(wrapped.direction).toBe("horizontal");
        expect(wrapped.children[0]).toBe(inner);
        expect(wrapped.children[1].type).toBe("leaf");
      }
    }
  });

  it("returns unchanged tree if target not found", () => {
    const root = hsplit(leaf(tab("a")), leaf(tab("b")));
    const unrelated = vsplit(leaf(tab("x"))) as WorkspaceSplitNode;
    const result = wrapSplitInNewDirection(root, unrelated, "vertical");
    expect(getWorkspaceLeaves(result)).toHaveLength(2);
  });
});

// --- Panel tree build/capture tests ---

const savedConnections: SavedConnection[] = [
  {
    id: "conn-1",
    name: "Dev Server",
    config: { type: "ssh", config: { host: "dev.example.com" } },
    folderId: null,
  },
  {
    id: "conn-2",
    name: "Local Shell",
    config: { type: "local", config: { shell: "bash" } },
    folderId: null,
  },
];

describe("buildPanelTreeFromWorkspace", () => {
  it("builds a single leaf panel", () => {
    const layout: WorkspaceLayoutNode = leaf({ connectionRef: "conn-1" });
    const result = buildPanelTreeFromWorkspace(layout, savedConnections, "bash");
    expect(result.type).toBe("leaf");
    if (result.type === "leaf") {
      expect(result.tabs).toHaveLength(1);
      expect(result.tabs[0].config.type).toBe("ssh");
      expect(result.tabs[0].title).toBe("Dev Server");
      expect(result.tabs[0].isActive).toBe(true);
    }
  });

  it("builds a split panel tree", () => {
    const layout: WorkspaceLayoutNode = hsplit(
      leaf({ connectionRef: "conn-1" }),
      leaf({ connectionRef: "conn-2" })
    );
    const result = buildPanelTreeFromWorkspace(layout, savedConnections, "bash");
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.direction).toBe("horizontal");
      expect(result.children).toHaveLength(2);
    }
  });

  it("uses title override from tab def", () => {
    const layout: WorkspaceLayoutNode = leaf({ connectionRef: "conn-1", title: "Custom Title" });
    const result = buildPanelTreeFromWorkspace(layout, savedConnections, "bash");
    if (result.type === "leaf") {
      expect(result.tabs[0].title).toBe("Custom Title");
    }
  });

  it("falls back to inline config when ref not found", () => {
    const layout: WorkspaceLayoutNode = leaf({
      connectionRef: "nonexistent",
      inlineConfig: { type: "local", config: { shell: "zsh" } },
      title: "Fallback",
    });
    const result = buildPanelTreeFromWorkspace(layout, savedConnections, "bash");
    if (result.type === "leaf") {
      expect(result.tabs[0].config.type).toBe("local");
      expect(result.tabs[0].title).toBe("Fallback");
    }
  });

  it("falls back to default shell when no ref or inline", () => {
    const layout: WorkspaceLayoutNode = leaf({});
    const result = buildPanelTreeFromWorkspace(layout, savedConnections, "zsh");
    if (result.type === "leaf") {
      expect(result.tabs[0].config.type).toBe("local");
      expect((result.tabs[0].config.config as Record<string, unknown>).shell).toBe("zsh");
    }
  });

  it("preserves initial command", () => {
    const layout: WorkspaceLayoutNode = leaf({
      connectionRef: "conn-1",
      initialCommand: "npm start",
    });
    const result = buildPanelTreeFromWorkspace(layout, savedConnections, "bash");
    if (result.type === "leaf") {
      expect(result.tabs[0].initialCommand).toBe("npm start");
    }
  });
});

describe("captureCurrentLayout", () => {
  it("captures a single leaf panel", () => {
    const panel: PanelNode = {
      type: "leaf",
      id: "p1",
      tabs: [
        {
          id: "t1",
          sessionId: "s1",
          title: "Dev Server",
          connectionType: "ssh",
          contentType: "terminal",
          config: { type: "ssh", config: { host: "dev.example.com" } },
          panelId: "p1",
          isActive: true,
        },
      ],
      activeTabId: "t1",
    };
    const result = captureCurrentLayout(panel, savedConnections);
    expect(result.type).toBe("leaf");
    if (result.type === "leaf") {
      expect(result.tabs).toHaveLength(1);
      expect(result.tabs[0].connectionRef).toBe("conn-1");
    }
  });

  it("captures a split layout", () => {
    const panel: PanelNode = {
      type: "split",
      id: "s1",
      direction: "horizontal",
      children: [
        {
          type: "leaf",
          id: "p1",
          tabs: [
            {
              id: "t1",
              sessionId: null,
              title: "Dev Server",
              connectionType: "ssh",
              contentType: "terminal",
              config: { type: "ssh", config: { host: "dev.example.com" } },
              panelId: "p1",
              isActive: true,
            },
          ],
          activeTabId: "t1",
        },
        {
          type: "leaf",
          id: "p2",
          tabs: [
            {
              id: "t2",
              sessionId: null,
              title: "Local Shell",
              connectionType: "local",
              contentType: "terminal",
              config: { type: "local", config: { shell: "bash" } },
              panelId: "p2",
              isActive: true,
            },
          ],
          activeTabId: "t2",
        },
      ],
    };
    const result = captureCurrentLayout(panel, savedConnections);
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.direction).toBe("horizontal");
      expect(result.children).toHaveLength(2);
    }
  });

  it("uses inline config for unmatched connections", () => {
    const panel: PanelNode = {
      type: "leaf",
      id: "p1",
      tabs: [
        {
          id: "t1",
          sessionId: null,
          title: "Custom",
          connectionType: "telnet",
          contentType: "terminal",
          config: { type: "telnet", config: { host: "some.host", port: 23 } },
          panelId: "p1",
          isActive: true,
        },
      ],
      activeTabId: "t1",
    };
    const result = captureCurrentLayout(panel, savedConnections);
    if (result.type === "leaf") {
      expect(result.tabs[0].connectionRef).toBeUndefined();
      expect(result.tabs[0].inlineConfig).toBeDefined();
      expect(result.tabs[0].inlineConfig!.type).toBe("telnet");
    }
  });

  it("skips non-terminal tabs", () => {
    const panel: PanelNode = {
      type: "leaf",
      id: "p1",
      tabs: [
        {
          id: "t1",
          sessionId: null,
          title: "Settings",
          connectionType: "local",
          contentType: "settings",
          config: { type: "local", config: {} },
          panelId: "p1",
          isActive: true,
        },
        {
          id: "t2",
          sessionId: null,
          title: "Terminal",
          connectionType: "local",
          contentType: "terminal",
          config: { type: "local", config: { shell: "bash" } },
          panelId: "p1",
          isActive: false,
        },
      ],
      activeTabId: "t1",
    };
    const result = captureCurrentLayout(panel, savedConnections);
    if (result.type === "leaf") {
      expect(result.tabs).toHaveLength(1);
    }
  });
});

// --- Sizes propagation and manipulation tests ---

describe("sizes propagation in buildPanelTreeFromWorkspace", () => {
  it("propagates sizes from workspace split to runtime split", () => {
    const layout = hsplitSized(
      [60, 40],
      leaf({ connectionRef: "conn-1" }),
      leaf({ connectionRef: "conn-2" })
    );
    const result = buildPanelTreeFromWorkspace(layout, savedConnections, "bash");
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.sizes).toEqual([60, 40]);
    }
  });

  it("does not add sizes when absent", () => {
    const layout = hsplit(leaf({ connectionRef: "conn-1" }), leaf({ connectionRef: "conn-2" }));
    const result = buildPanelTreeFromWorkspace(layout, savedConnections, "bash");
    if (result.type === "split") {
      expect(result.sizes).toBeUndefined();
    }
  });
});

describe("sizes propagation in captureCurrentLayout", () => {
  it("propagates sizes from runtime split to workspace split", () => {
    const panel: PanelNode = {
      type: "split",
      id: "s1",
      direction: "horizontal",
      sizes: [70, 30],
      children: [
        {
          type: "leaf",
          id: "p1",
          tabs: [
            {
              id: "t1",
              sessionId: null,
              title: "Dev Server",
              connectionType: "ssh",
              contentType: "terminal",
              config: { type: "ssh", config: { host: "dev.example.com" } },
              panelId: "p1",
              isActive: true,
            },
          ],
          activeTabId: "t1",
        },
        {
          type: "leaf",
          id: "p2",
          tabs: [
            {
              id: "t2",
              sessionId: null,
              title: "Local Shell",
              connectionType: "local",
              contentType: "terminal",
              config: { type: "local", config: { shell: "bash" } },
              panelId: "p2",
              isActive: true,
            },
          ],
          activeTabId: "t2",
        },
      ],
    };
    const result = captureCurrentLayout(panel, savedConnections);
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.sizes).toEqual([70, 30]);
    }
  });

  it("does not add sizes when runtime split has no sizes", () => {
    const panel: PanelNode = {
      type: "split",
      id: "s1",
      direction: "horizontal",
      children: [
        {
          type: "leaf",
          id: "p1",
          tabs: [
            {
              id: "t1",
              sessionId: null,
              title: "Dev Server",
              connectionType: "ssh",
              contentType: "terminal",
              config: { type: "ssh", config: { host: "dev.example.com" } },
              panelId: "p1",
              isActive: true,
            },
          ],
          activeTabId: "t1",
        },
        {
          type: "leaf",
          id: "p2",
          tabs: [
            {
              id: "t2",
              sessionId: null,
              title: "Local Shell",
              connectionType: "local",
              contentType: "terminal",
              config: { type: "local", config: { shell: "bash" } },
              panelId: "p2",
              isActive: true,
            },
          ],
          activeTabId: "t2",
        },
      ],
    };
    const result = captureCurrentLayout(panel, savedConnections);
    if (result.type === "split") {
      expect(result.sizes).toBeUndefined();
    }
  });
});

describe("removeWorkspaceLeaf with sizes", () => {
  it("redistributes sizes when removing a child from a sized split", () => {
    const node = hsplitSized([50, 25, 25], leaf(tab("a")), leaf(tab("b")), leaf(tab("c")));
    const result = removeWorkspaceLeaf(node, 0);
    expect(result).not.toBeNull();
    if (result?.type === "split") {
      expect(result.children).toHaveLength(2);
      expect(result.sizes).toBeDefined();
      const total = result.sizes!.reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(100);
    }
  });

  it("drops sizes when collapsing to single leaf", () => {
    const node = hsplitSized([60, 40], leaf(tab("a")), leaf(tab("b")));
    const result = removeWorkspaceLeaf(node, 0);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("leaf");
  });
});

describe("addLeafToSplit with sizes", () => {
  it("assigns fair share from existing panels when sizes present", () => {
    const split = hsplitSized([60, 40], leaf(tab("a")), leaf(tab("b")));
    const result = addLeafToSplit(split, split);
    if (result.type === "split") {
      expect(result.children).toHaveLength(3);
      expect(result.sizes).toBeDefined();
      const total = result.sizes!.reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(100);
      // New panel gets ~33.3%, existing scale down proportionally
      expect(result.sizes![2]).toBeCloseTo(100 / 3, 0);
    }
  });

  it("does not add sizes when split has no sizes", () => {
    const split = hsplit(leaf(tab("a")), leaf(tab("b"))) as WorkspaceSplitNode;
    const result = addLeafToSplit(split, split);
    if (result.type === "split") {
      expect(result.sizes).toBeUndefined();
    }
  });
});

describe("updateSplitSizes", () => {
  it("sets sizes on a split node", () => {
    const split = hsplit(leaf(tab("a")), leaf(tab("b"))) as WorkspaceSplitNode;
    const result = updateSplitSizes(split, split, [70, 30]);
    if (result.type === "split") {
      expect(result.sizes).toEqual([70, 30]);
    }
  });

  it("clears sizes when null passed", () => {
    const split = hsplitSized([60, 40], leaf(tab("a")), leaf(tab("b")));
    const result = updateSplitSizes(split, split, null);
    if (result.type === "split") {
      expect(result.sizes).toBeUndefined();
    }
  });

  it("updates nested split by reference", () => {
    const inner = vsplitSized([30, 70], leaf(tab("b")), leaf(tab("c")));
    const root = hsplit(leaf(tab("a")), inner);
    const result = updateSplitSizes(root, inner, [50, 50]);
    if (result.type === "split") {
      const updatedInner = result.children[1];
      if (updatedInner.type === "split") {
        expect(updatedInner.sizes).toEqual([50, 50]);
      }
    }
  });
});

describe("splitWorkspaceLeaf with sized parent", () => {
  it("splitting a leaf inside a sized split does not break sizes length", () => {
    const node = hsplitSized([60, 40], leaf(tab("a")), leaf(tab("b")));
    // Splitting leaf 0 vertically creates a nested vsplit inside the hsplit
    const { node: result } = splitWorkspaceLeaf(node, 0, "vertical");
    if (result.type === "split") {
      // The hsplit still has 2 direct children (one is now a vsplit)
      expect(result.children).toHaveLength(2);
      // Sizes should still be valid (same length as children)
      expect(result.sizes).toHaveLength(2);
    }
  });
});

describe("buildTabGroupsFromWorkspace", () => {
  const savedConnections: SavedConnection[] = [
    {
      id: "conn-1",
      name: "Dev Server",
      folderId: null,
      config: { type: "local", config: { shell: "bash" } },
    },
    {
      id: "conn-2",
      name: "Prod",
      folderId: null,
      config: { type: "local", config: { shell: "zsh" } },
    },
  ];

  it("builds one TabGroup per definition", () => {
    const defs: WorkspaceTabGroupDef[] = [
      { name: "Dev", layout: leaf(tab("conn-1")) },
      { name: "Deploy", layout: leaf(tab("conn-2")) },
    ];
    const groups = buildTabGroupsFromWorkspace(defs, savedConnections, "bash");
    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe("Dev");
    expect(groups[1].name).toBe("Deploy");
  });

  it("each group has a unique id", () => {
    const defs: WorkspaceTabGroupDef[] = [
      { name: "A", layout: leaf() },
      { name: "B", layout: leaf() },
    ];
    const groups = buildTabGroupsFromWorkspace(defs, savedConnections, "bash");
    expect(groups[0].id).not.toBe(groups[1].id);
  });

  it("propagates color from definition", () => {
    const defs: WorkspaceTabGroupDef[] = [{ name: "Dev", color: "#ff6b6b", layout: leaf() }];
    const groups = buildTabGroupsFromWorkspace(defs, savedConnections, "bash");
    expect(groups[0].color).toBe("#ff6b6b");
  });

  it("sets activePanelId to first leaf panel id", () => {
    const defs: WorkspaceTabGroupDef[] = [{ name: "Main", layout: leaf(tab("conn-1")) }];
    const groups = buildTabGroupsFromWorkspace(defs, savedConnections, "bash");
    const panel = groups[0].rootPanel;
    expect(groups[0].activePanelId).toBe(panel.id);
  });

  it("builds correct panel tree (split layout)", () => {
    const defs: WorkspaceTabGroupDef[] = [
      { name: "Main", layout: hsplit(leaf(tab("conn-1")), leaf(tab("conn-2"))) },
    ];
    const groups = buildTabGroupsFromWorkspace(defs, savedConnections, "bash");
    expect(groups[0].rootPanel.type).toBe("split");
    if (groups[0].rootPanel.type === "split") {
      expect(groups[0].rootPanel.children).toHaveLength(2);
    }
  });

  it("returns empty array for empty defs", () => {
    const groups = buildTabGroupsFromWorkspace([], savedConnections, "bash");
    expect(groups).toHaveLength(0);
  });
});

describe("captureAllTabGroups", () => {
  function makeLeafPanel(tabTitle: string): LeafPanel {
    return {
      type: "leaf",
      id: `panel-${tabTitle}`,
      tabs: [
        {
          id: `tab-${tabTitle}`,
          sessionId: null,
          title: tabTitle,
          connectionType: "local",
          contentType: "terminal",
          config: { type: "local", config: { shell: "bash" } },
          panelId: `panel-${tabTitle}`,
          isActive: true,
        },
      ],
      activeTabId: `tab-${tabTitle}`,
    };
  }

  const savedConnections: SavedConnection[] = [];

  it("captures one def per group", () => {
    const panel1 = makeLeafPanel("alpha");
    const panel2 = makeLeafPanel("beta");

    const groups: TabGroup[] = [
      { id: "g1", name: "Dev", rootPanel: panel1, activePanelId: panel1.id },
      { id: "g2", name: "Deploy", rootPanel: panel2, activePanelId: panel2.id },
    ];

    const defs = captureAllTabGroups(groups, "g1", panel1, savedConnections);
    expect(defs).toHaveLength(2);
    expect(defs[0].name).toBe("Dev");
    expect(defs[1].name).toBe("Deploy");
  });

  it("uses liveRootPanel for active group", () => {
    const savedPanel = makeLeafPanel("old");
    const livePanel = makeLeafPanel("live");

    const groups: TabGroup[] = [
      { id: "g1", name: "Main", rootPanel: savedPanel, activePanelId: savedPanel.id },
    ];

    const defs = captureAllTabGroups(groups, "g1", livePanel, savedConnections);
    expect(defs[0].layout.type).toBe("leaf");
    if (defs[0].layout.type === "leaf") {
      // livePanel has tab titled "live"
      expect(defs[0].layout.tabs[0].title).toBe("live");
    }
  });

  it("uses saved rootPanel for inactive groups", () => {
    const activePanel = makeLeafPanel("active");
    const inactivePanel = makeLeafPanel("inactive");

    const groups: TabGroup[] = [
      { id: "g1", name: "Active", rootPanel: activePanel, activePanelId: activePanel.id },
      { id: "g2", name: "Inactive", rootPanel: inactivePanel, activePanelId: inactivePanel.id },
    ];

    const defs = captureAllTabGroups(groups, "g1", activePanel, savedConnections);
    expect(defs[1].name).toBe("Inactive");
    if (defs[1].layout.type === "leaf") {
      expect(defs[1].layout.tabs[0].title).toBe("inactive");
    }
  });

  it("propagates group color", () => {
    const panel = makeLeafPanel("x");
    const groups: TabGroup[] = [
      { id: "g1", name: "Dev", color: "#abc", rootPanel: panel, activePanelId: panel.id },
    ];
    const defs = captureAllTabGroups(groups, "g1", panel, savedConnections);
    expect(defs[0].color).toBe("#abc");
  });
});

// --- agentRef resolution ---

describe("agentRef workspace tab resolution", () => {
  const agentContext = {
    agents: [
      { id: "agent-1", name: "Pi Server", connected: true },
      { id: "agent-2", name: "Work Server", connected: false },
    ],
    definitions: {
      "agent-1": [
        {
          id: "def-shell",
          name: "Bash Shell",
          sessionType: "shell",
          persistent: false,
          config: { shell: "/bin/bash" },
        },
      ],
    },
  };

  it("resolves agentRef to terminal tab when agent is connected", () => {
    const layout: WorkspaceLayoutNode = {
      type: "leaf",
      tabs: [{ agentRef: { agentId: "agent-1", definitionId: "def-shell" } }],
    };
    const panel = buildPanelTreeFromWorkspace(layout, [], "zsh", agentContext);
    expect(panel.type).toBe("leaf");
    if (panel.type === "leaf") {
      const tab = panel.tabs[0];
      expect(tab.contentType).toBe("terminal");
      expect(tab.connectionType).toBe("remote-session");
      expect(tab.config.config).toMatchObject({ agentId: "agent-1", sessionType: "shell" });
      expect(tab.workspaceAgentRef).toEqual({ agentId: "agent-1", definitionId: "def-shell" });
      expect(tab.agentErrorMeta).toBeUndefined();
    }
  });

  it("resolves agentRef to agent-error tab when agent is disconnected", () => {
    const layout: WorkspaceLayoutNode = {
      type: "leaf",
      tabs: [{ agentRef: { agentId: "agent-2", definitionId: "def-shell" } }],
    };
    const panel = buildPanelTreeFromWorkspace(layout, [], "zsh", agentContext);
    expect(panel.type).toBe("leaf");
    if (panel.type === "leaf") {
      const tab = panel.tabs[0];
      expect(tab.contentType).toBe("agent-error");
      expect(tab.agentErrorMeta?.agentId).toBe("agent-2");
      expect(tab.agentErrorMeta?.error).toContain("not connected");
      expect(tab.workspaceAgentRef).toEqual({ agentId: "agent-2", definitionId: "def-shell" });
    }
  });

  it("resolves agentRef to agent-error tab when definition is not found", () => {
    const layout: WorkspaceLayoutNode = {
      type: "leaf",
      tabs: [{ agentRef: { agentId: "agent-1", definitionId: "missing-def" } }],
    };
    const panel = buildPanelTreeFromWorkspace(layout, [], "zsh", agentContext);
    expect(panel.type).toBe("leaf");
    if (panel.type === "leaf") {
      const tab = panel.tabs[0];
      expect(tab.contentType).toBe("agent-error");
      expect(tab.agentErrorMeta?.error).toContain("not found");
    }
  });

  it("resolves agentRef to agent-error tab when agent context is absent", () => {
    const layout: WorkspaceLayoutNode = {
      type: "leaf",
      tabs: [{ agentRef: { agentId: "agent-1", definitionId: "def-shell" } }],
    };
    const panel = buildPanelTreeFromWorkspace(layout, [], "zsh");
    expect(panel.type).toBe("leaf");
    if (panel.type === "leaf") {
      expect(panel.tabs[0].contentType).toBe("agent-error");
    }
  });

  it("captures agent-error tab back as agentRef", () => {
    const layout: WorkspaceLayoutNode = {
      type: "leaf",
      tabs: [
        {
          agentRef: { agentId: "agent-2", definitionId: "def-shell" },
          title: "My Shell",
          initialCommand: "ls",
        },
      ],
    };
    const panel = buildPanelTreeFromWorkspace(layout, [], "zsh", agentContext);
    const captured = captureCurrentLayout(panel, []);
    expect(captured.type).toBe("leaf");
    if (captured.type === "leaf") {
      const tabDef = captured.tabs[0];
      expect(tabDef.agentRef).toEqual({ agentId: "agent-2", definitionId: "def-shell" });
      expect(tabDef.title).toBe("My Shell");
      expect(tabDef.initialCommand).toBe("ls");
    }
  });
});
