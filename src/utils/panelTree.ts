import { LeafPanel, PanelNode, SplitContainer, DropEdge } from "@/types/terminal";

export type FocusDirection = "up" | "down" | "left" | "right";

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

/**
 * Build the path from root to a leaf, returning the list of ancestor nodes
 * and the child index at each level.
 */
function buildPath(
  root: PanelNode,
  leafId: string
): { node: SplitContainer; childIndex: number }[] | null {
  if (root.type === "leaf") {
    return root.id === leafId ? [] : null;
  }
  for (let i = 0; i < root.children.length; i++) {
    const sub = buildPath(root.children[i], leafId);
    if (sub !== null) {
      return [{ node: root, childIndex: i }, ...sub];
    }
  }
  return null;
}

/**
 * Mark every ancestor SplitContainer of the given leaf with `lastActiveLeafId`.
 * Returns a new tree (immutable). If the leaf is not found, returns the tree unchanged.
 */
export function markActiveLeaf(root: PanelNode, leafId: string): PanelNode {
  if (root.type === "leaf") return root;

  let changed = false;
  const newChildren = root.children.map((child) => {
    const updated = markActiveLeaf(child, leafId);
    if (updated !== child) changed = true;
    return updated;
  });

  // Check if the leaf is somewhere in this subtree
  const containsLeaf = findLeaf(root, leafId) !== null;
  if (!containsLeaf) {
    return changed ? { ...root, children: newChildren } : root;
  }

  // Update lastActiveLeafId if it changed
  if (root.lastActiveLeafId === leafId && !changed) return root;
  return { ...root, children: newChildren, lastActiveLeafId: leafId };
}

/** Get the first leaf by walking into the first/last child recursively. */
function edgeLeaf(node: PanelNode, side: "first" | "last"): LeafPanel {
  if (node.type === "leaf") return node;
  const idx = side === "first" ? 0 : node.children.length - 1;
  return edgeLeaf(node.children[idx], side);
}

/**
 * Return the preferred leaf when entering a subtree: if the node has a
 * `lastActiveLeafId` that still exists in the subtree, return that leaf.
 * Otherwise fall back to the edge leaf (first or last).
 */
function preferredLeaf(node: PanelNode, fallbackSide: "first" | "last"): LeafPanel {
  if (node.type === "leaf") return node;
  if (node.lastActiveLeafId) {
    const remembered = findLeaf(node, node.lastActiveLeafId);
    if (remembered) return remembered;
  }
  return edgeLeaf(node, fallbackSide);
}

/**
 * Find the adjacent leaf panel in the given direction.
 * Returns null if there is no panel in that direction.
 *
 * When entering a subtree, prefers the last-focused leaf within that subtree
 * (via `lastActiveLeafId`), falling back to the nearest edge leaf.
 *
 * - left/right navigate across horizontal splits
 * - up/down navigate across vertical splits
 */
export function findAdjacentLeaf(
  root: PanelNode,
  currentLeafId: string,
  direction: FocusDirection
): LeafPanel | null {
  const path = buildPath(root, currentLeafId);
  if (!path) return null;

  // Determine which split axis and which direction along it
  const axis: "horizontal" | "vertical" =
    direction === "left" || direction === "right" ? "horizontal" : "vertical";
  const delta = direction === "right" || direction === "down" ? 1 : -1;

  // Walk up the path to find the nearest ancestor split matching the axis
  for (let i = path.length - 1; i >= 0; i--) {
    const { node: split, childIndex } = path[i];
    if (split.direction !== axis) continue;

    const siblingIndex = childIndex + delta;
    if (siblingIndex < 0 || siblingIndex >= split.children.length) continue;

    // Walk into the sibling subtree, preferring the last-focused leaf
    const fallbackSide = delta > 0 ? "first" : "last";
    return preferredLeaf(split.children[siblingIndex], fallbackSide);
  }

  return null;
}
