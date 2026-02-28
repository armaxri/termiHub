import { describe, it, expect } from "vitest";
import type { LeafPanel, SplitContainer, TerminalTab, PanelNode } from "@/types/terminal";
import {
  createLeafPanel,
  findLeaf,
  findLeafByTab,
  getAllLeaves,
  updateLeaf,
  removeLeaf,
  splitLeaf,
  simplifyTree,
  edgeToSplit,
} from "./panelTree";

/** Create a minimal tab for testing. */
function makeTab(id: string, panelId: string): TerminalTab {
  return {
    id,
    sessionId: null,
    title: id,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: { shell: "zsh" } },
    panelId,
    isActive: false,
  };
}

/** Create a leaf with tabs for testing. */
function makeLeaf(id: string, tabIds: string[] = []): LeafPanel {
  const tabs = tabIds.map((tid) => makeTab(tid, id));
  return {
    type: "leaf",
    id,
    tabs,
    activeTabId: tabs.length > 0 ? tabs[0].id : null,
  };
}

/** Create a split container for testing. */
function makeSplit(
  id: string,
  direction: "horizontal" | "vertical",
  children: PanelNode[]
): SplitContainer {
  return { type: "split", id, direction, children };
}

describe("createLeafPanel", () => {
  it("returns a leaf with unique id", () => {
    const leaf = createLeafPanel();
    expect(leaf.type).toBe("leaf");
    expect(leaf.id).toBeTruthy();
    expect(leaf.tabs).toEqual([]);
    expect(leaf.activeTabId).toBeNull();
  });

  it("generates unique ids on successive calls", () => {
    const a = createLeafPanel();
    const b = createLeafPanel();
    expect(a.id).not.toBe(b.id);
  });
});

describe("findLeaf", () => {
  it("finds a single leaf by id", () => {
    const leaf = makeLeaf("leaf-1");
    expect(findLeaf(leaf, "leaf-1")).toBe(leaf);
  });

  it("finds a leaf in a nested split", () => {
    const leaf1 = makeLeaf("leaf-1");
    const leaf2 = makeLeaf("leaf-2");
    const split = makeSplit("split-1", "horizontal", [leaf1, leaf2]);
    expect(findLeaf(split, "leaf-2")).toBe(leaf2);
  });

  it("returns null for unknown id", () => {
    const leaf = makeLeaf("leaf-1");
    expect(findLeaf(leaf, "unknown")).toBeNull();
  });
});

describe("findLeafByTab", () => {
  it("finds leaf containing a tab", () => {
    const leaf = makeLeaf("leaf-1", ["tab-a", "tab-b"]);
    expect(findLeafByTab(leaf, "tab-b")).toBe(leaf);
  });

  it("returns null for unknown tab", () => {
    const leaf = makeLeaf("leaf-1", ["tab-a"]);
    expect(findLeafByTab(leaf, "tab-unknown")).toBeNull();
  });
});

describe("getAllLeaves", () => {
  it("returns single leaf in array", () => {
    const leaf = makeLeaf("leaf-1");
    expect(getAllLeaves(leaf)).toEqual([leaf]);
  });

  it("returns all leaves from nested tree", () => {
    const leaf1 = makeLeaf("leaf-1");
    const leaf2 = makeLeaf("leaf-2");
    const leaf3 = makeLeaf("leaf-3");
    const inner = makeSplit("s-inner", "vertical", [leaf2, leaf3]);
    const root = makeSplit("s-root", "horizontal", [leaf1, inner]);

    const leaves = getAllLeaves(root);
    expect(leaves).toHaveLength(3);
    expect(leaves.map((l) => l.id)).toEqual(["leaf-1", "leaf-2", "leaf-3"]);
  });
});

describe("updateLeaf", () => {
  it("updates matching leaf", () => {
    const leaf = makeLeaf("leaf-1", ["tab-1"]);
    const updated = updateLeaf(leaf, "leaf-1", (l) => ({
      ...l,
      activeTabId: "tab-1",
    }));
    expect((updated as LeafPanel).activeTabId).toBe("tab-1");
  });

  it("leaves non-matching leaves unchanged", () => {
    const leaf = makeLeaf("leaf-1");
    const result = updateLeaf(leaf, "other", (l) => ({
      ...l,
      activeTabId: "changed",
    }));
    expect(result).toBe(leaf); // same reference
  });
});

describe("removeLeaf", () => {
  it("returns null when removing root leaf", () => {
    const leaf = makeLeaf("leaf-1");
    expect(removeLeaf(leaf, "leaf-1")).toBeNull();
  });

  it("returns non-matching leaf unchanged", () => {
    const leaf = makeLeaf("leaf-1");
    expect(removeLeaf(leaf, "other")).toBe(leaf);
  });

  it("unwraps single-child parent after removal", () => {
    const leaf1 = makeLeaf("leaf-1");
    const leaf2 = makeLeaf("leaf-2");
    const split = makeSplit("split-1", "horizontal", [leaf1, leaf2]);

    const result = removeLeaf(split, "leaf-1");
    // Should unwrap to just leaf-2 instead of split with one child
    expect(result).toBe(leaf2);
  });
});

describe("splitLeaf", () => {
  it("wraps leaf in split container with new leaf", () => {
    const existing = makeLeaf("leaf-1");
    const newLeaf = makeLeaf("new-leaf");
    const result = splitLeaf(existing, "leaf-1", newLeaf, "horizontal", "after");

    expect(result.type).toBe("split");
    const split = result as SplitContainer;
    expect(split.direction).toBe("horizontal");
    expect(split.children).toHaveLength(2);
    expect((split.children[0] as LeafPanel).id).toBe("leaf-1");
    expect((split.children[1] as LeafPanel).id).toBe("new-leaf");
  });

  it("inserts before when position is before", () => {
    const existing = makeLeaf("leaf-1");
    const newLeaf = makeLeaf("new-leaf");
    const result = splitLeaf(existing, "leaf-1", newLeaf, "vertical", "before");

    const split = result as SplitContainer;
    expect((split.children[0] as LeafPanel).id).toBe("new-leaf");
    expect((split.children[1] as LeafPanel).id).toBe("leaf-1");
  });

  it("inserts as sibling when directions match", () => {
    const leaf1 = makeLeaf("leaf-1");
    const leaf2 = makeLeaf("leaf-2");
    const split = makeSplit("split-1", "horizontal", [leaf1, leaf2]);
    const newLeaf = makeLeaf("new-leaf");

    const result = splitLeaf(split, "leaf-1", newLeaf, "horizontal", "after");
    const container = result as SplitContainer;
    expect(container.children).toHaveLength(3);
    expect((container.children[0] as LeafPanel).id).toBe("leaf-1");
    expect((container.children[1] as LeafPanel).id).toBe("new-leaf");
    expect((container.children[2] as LeafPanel).id).toBe("leaf-2");
  });
});

describe("simplifyTree", () => {
  it("returns leaf unchanged", () => {
    const leaf = makeLeaf("leaf-1");
    expect(simplifyTree(leaf)).toBe(leaf);
  });

  it("flattens same-direction nesting", () => {
    const leaf1 = makeLeaf("leaf-1");
    const leaf2 = makeLeaf("leaf-2");
    const leaf3 = makeLeaf("leaf-3");
    const inner = makeSplit("inner", "horizontal", [leaf2, leaf3]);
    const outer = makeSplit("outer", "horizontal", [leaf1, inner]);

    const result = simplifyTree(outer);
    expect(result.type).toBe("split");
    const split = result as SplitContainer;
    expect(split.children).toHaveLength(3);
  });

  it("unwraps single-child containers", () => {
    const leaf = makeLeaf("leaf-1");
    const split = makeSplit("split-1", "horizontal", [leaf]);
    const result = simplifyTree(split);
    expect(result).toBe(leaf);
  });
});

describe("edgeToSplit", () => {
  it("maps left to horizontal/before", () => {
    expect(edgeToSplit("left")).toEqual({ direction: "horizontal", position: "before" });
  });

  it("maps right to horizontal/after", () => {
    expect(edgeToSplit("right")).toEqual({ direction: "horizontal", position: "after" });
  });

  it("maps top to vertical/before", () => {
    expect(edgeToSplit("top")).toEqual({ direction: "vertical", position: "before" });
  });

  it("maps bottom to vertical/after", () => {
    expect(edgeToSplit("bottom")).toEqual({ direction: "vertical", position: "after" });
  });

  it("returns null for center", () => {
    expect(edgeToSplit("center")).toBeNull();
  });
});
