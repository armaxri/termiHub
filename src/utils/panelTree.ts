import { LeafPanel, PanelNode, DropEdge } from "@/types/terminal";

let panelCounter = 0;

/** Generate a unique panel ID. */
export function generatePanelId(): string {
  panelCounter++;
  return `panel-${Date.now()}-${panelCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Create a new empty leaf panel. */
export function createLeafPanel(): LeafPanel {
  return { type: "leaf", id: generatePanelId(), tabs: [], activeTabId: null };
}

/** Find a leaf by ID. */
export function findLeaf(root: PanelNode, leafId: string): LeafPanel | null {
  if (root.type === "leaf") {
    return root.id === leafId ? root : null;
  }
  for (const child of root.children) {
    const found = findLeaf(child, leafId);
    if (found) return found;
  }
  return null;
}

/** Find the leaf containing a specific tab. */
export function findLeafByTab(root: PanelNode, tabId: string): LeafPanel | null {
  if (root.type === "leaf") {
    return root.tabs.some((t) => t.id === tabId) ? root : null;
  }
  for (const child of root.children) {
    const found = findLeafByTab(child, tabId);
    if (found) return found;
  }
  return null;
}

/** Get a flat list of all leaves in the tree. */
export function getAllLeaves(root: PanelNode): LeafPanel[] {
  if (root.type === "leaf") return [root];
  const result: LeafPanel[] = [];
  for (const child of root.children) {
    result.push(...getAllLeaves(child));
  }
  return result;
}

/** Immutably update a single leaf by ID. */
export function updateLeaf(
  root: PanelNode,
  leafId: string,
  updater: (leaf: LeafPanel) => LeafPanel
): PanelNode {
  if (root.type === "leaf") {
    return root.id === leafId ? updater(root) : root;
  }
  return {
    ...root,
    children: root.children.map((child) => updateLeaf(child, leafId, updater)),
  };
}

/**
 * Remove a leaf from the tree and unwrap single-child splits.
 * Returns null if the removed leaf was the root.
 */
export function removeLeaf(root: PanelNode, leafId: string): PanelNode | null {
  if (root.type === "leaf") {
    return root.id === leafId ? null : root;
  }

  const newChildren: PanelNode[] = [];
  for (const child of root.children) {
    const result = removeLeaf(child, leafId);
    if (result !== null) {
      newChildren.push(result);
    }
  }

  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0];
  return { ...root, children: newChildren };
}

/**
 * Split a leaf by wrapping it in a SplitContainer with a new leaf.
 * If the parent already splits in the same direction, inserts as sibling instead of nesting.
 */
export function splitLeaf(
  root: PanelNode,
  targetId: string,
  newLeaf: LeafPanel,
  direction: "horizontal" | "vertical",
  position: "before" | "after"
): PanelNode {
  if (root.type === "leaf") {
    if (root.id !== targetId) return root;
    const children = position === "before" ? [newLeaf, root] : [root, newLeaf];
    return {
      type: "split",
      id: generatePanelId(),
      direction,
      children,
    };
  }

  // Check if target is a direct child and directions match — insert as sibling
  const targetIndex = root.children.findIndex((c) => c.type === "leaf" && c.id === targetId);
  if (targetIndex !== -1 && root.direction === direction) {
    const insertIdx = position === "before" ? targetIndex : targetIndex + 1;
    const newChildren = [...root.children];
    newChildren.splice(insertIdx, 0, newLeaf);
    return { ...root, children: newChildren };
  }

  // Recurse into children
  return {
    ...root,
    children: root.children.map((child) =>
      splitLeaf(child, targetId, newLeaf, direction, position)
    ),
  };
}

/** Flatten same-direction nesting and unwrap single-child containers. */
export function simplifyTree(root: PanelNode): PanelNode {
  if (root.type === "leaf") return root;

  // First simplify children
  let children = root.children.map(simplifyTree);

  // Flatten children that split in the same direction
  const flattened: PanelNode[] = [];
  for (const child of children) {
    if (child.type === "split" && child.direction === root.direction) {
      flattened.push(...child.children);
    } else {
      flattened.push(child);
    }
  }
  children = flattened;

  if (children.length === 0) return createLeafPanel();
  if (children.length === 1) return children[0];
  return { ...root, children };
}

/** Convert a DropEdge to split direction and position, or null for center. */
export function edgeToSplit(
  edge: DropEdge
): { direction: "horizontal" | "vertical"; position: "before" | "after" } | null {
  switch (edge) {
    case "left":
      return { direction: "horizontal", position: "before" };
    case "right":
      return { direction: "horizontal", position: "after" };
    case "top":
      return { direction: "vertical", position: "before" };
    case "bottom":
      return { direction: "vertical", position: "after" };
    case "center":
      return null;
  }
}
