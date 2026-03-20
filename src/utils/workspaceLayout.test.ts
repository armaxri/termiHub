import { describe, it, expect } from "vitest";
import { WorkspaceLayoutNode, WorkspaceLeafNode, WorkspaceTabDef } from "@/types/workspace";
import { SavedConnection } from "@/types/connection";
import { PanelNode } from "@/types/terminal";
import {
  getWorkspaceLeaves,
  countWorkspaceTabs,
  splitWorkspaceLeaf,
  addTabToLeaf,
  removeTabFromLeaf,
  removeWorkspaceLeaf,
  updateTabInLeaf,
  buildPanelTreeFromWorkspace,
  captureCurrentLayout,
} from "./workspaceLayout";

function tab(ref?: string): WorkspaceTabDef {
  return { connectionRef: ref };
}

function leaf(...tabs: WorkspaceTabDef[]): WorkspaceLeafNode {
  return { type: "leaf", tabs };
}

function hsplit(...children: WorkspaceLayoutNode[]): WorkspaceLayoutNode {
  return { type: "split", direction: "horizontal", children };
}

function vsplit(...children: WorkspaceLayoutNode[]): WorkspaceLayoutNode {
  return { type: "split", direction: "vertical", children };
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
