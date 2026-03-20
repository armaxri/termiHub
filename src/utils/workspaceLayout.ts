/**
 * Utility functions for workspace layout tree manipulation.
 */

import {
  WorkspaceLayoutNode,
  WorkspaceLeafNode,
  WorkspaceSplitNode,
  WorkspaceTabDef,
} from "@/types/workspace";

/** Get all leaf nodes from a workspace layout tree. */
export function getWorkspaceLeaves(node: WorkspaceLayoutNode): WorkspaceLeafNode[] {
  if (node.type === "leaf") return [node];
  return node.children.flatMap(getWorkspaceLeaves);
}

/** Count total tabs across all leaves. */
export function countWorkspaceTabs(node: WorkspaceLayoutNode): number {
  if (node.type === "leaf") return node.tabs.length;
  return node.children.reduce((sum, child) => sum + countWorkspaceTabs(child), 0);
}

/**
 * Split a leaf at the given path index into two leaves.
 * Returns a new tree with the split applied, or the original if path is invalid.
 * The `leafIndex` identifies the leaf by its position in a depth-first traversal.
 */
export function splitWorkspaceLeaf(
  node: WorkspaceLayoutNode,
  leafIndex: number,
  direction: "horizontal" | "vertical"
): { node: WorkspaceLayoutNode; newLeafIndex: number } {
  const result = splitAtIndex(node, leafIndex, direction, { current: 0 });
  return { node: result.node, newLeafIndex: result.newLeafIndex ?? leafIndex + 1 };
}

interface Counter {
  current: number;
}

function splitAtIndex(
  node: WorkspaceLayoutNode,
  targetIndex: number,
  direction: "horizontal" | "vertical",
  counter: Counter
): { node: WorkspaceLayoutNode; newLeafIndex: number | null } {
  if (node.type === "leaf") {
    if (counter.current === targetIndex) {
      counter.current++;
      const newLeaf: WorkspaceLeafNode = { type: "leaf", tabs: [] };
      const newLeafIdx = counter.current;
      counter.current++;
      const split: WorkspaceSplitNode = {
        type: "split",
        direction,
        children: [node, newLeaf],
      };
      return { node: split, newLeafIndex: newLeafIdx };
    }
    counter.current++;
    return { node, newLeafIndex: null };
  }

  let foundIndex: number | null = null;
  const newChildren = node.children.map((child) => {
    const result = splitAtIndex(child, targetIndex, direction, counter);
    if (result.newLeafIndex !== null) foundIndex = result.newLeafIndex;
    return result.node;
  });

  return { node: { ...node, children: newChildren }, newLeafIndex: foundIndex };
}

/** Add a tab to a leaf at the given index. */
export function addTabToLeaf(
  node: WorkspaceLayoutNode,
  leafIndex: number,
  tab: WorkspaceTabDef
): WorkspaceLayoutNode {
  const counter: Counter = { current: 0 };
  return addTabAtIndex(node, leafIndex, tab, counter);
}

function addTabAtIndex(
  node: WorkspaceLayoutNode,
  targetIndex: number,
  tab: WorkspaceTabDef,
  counter: Counter
): WorkspaceLayoutNode {
  if (node.type === "leaf") {
    if (counter.current === targetIndex) {
      counter.current++;
      return { ...node, tabs: [...node.tabs, tab] };
    }
    counter.current++;
    return node;
  }

  return {
    ...node,
    children: node.children.map((child) => addTabAtIndex(child, targetIndex, tab, counter)),
  };
}

/** Remove a tab from a leaf at the given index. */
export function removeTabFromLeaf(
  node: WorkspaceLayoutNode,
  leafIndex: number,
  tabIndex: number
): WorkspaceLayoutNode {
  const counter: Counter = { current: 0 };
  return removeTabAtIndex(node, leafIndex, tabIndex, counter);
}

function removeTabAtIndex(
  node: WorkspaceLayoutNode,
  targetLeaf: number,
  tabIndex: number,
  counter: Counter
): WorkspaceLayoutNode {
  if (node.type === "leaf") {
    if (counter.current === targetLeaf) {
      counter.current++;
      const newTabs = node.tabs.filter((_, i) => i !== tabIndex);
      return { ...node, tabs: newTabs };
    }
    counter.current++;
    return node;
  }

  return {
    ...node,
    children: node.children.map((child) => removeTabAtIndex(child, targetLeaf, tabIndex, counter)),
  };
}

/**
 * Remove a leaf at the given index from the tree.
 * If the parent split has only one child left, collapses to that child.
 */
export function removeWorkspaceLeaf(
  node: WorkspaceLayoutNode,
  leafIndex: number
): WorkspaceLayoutNode | null {
  const counter: Counter = { current: 0 };
  return removeLeafAtIndex(node, leafIndex, counter);
}

function removeLeafAtIndex(
  node: WorkspaceLayoutNode,
  targetIndex: number,
  counter: Counter
): WorkspaceLayoutNode | null {
  if (node.type === "leaf") {
    if (counter.current === targetIndex) {
      counter.current++;
      return null; // Remove this leaf
    }
    counter.current++;
    return node;
  }

  const newChildren = node.children
    .map((child) => removeLeafAtIndex(child, targetIndex, counter))
    .filter((child): child is WorkspaceLayoutNode => child !== null);

  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0];
  return { ...node, children: newChildren };
}

/** Update a tab at a specific leaf and tab index. */
export function updateTabInLeaf(
  node: WorkspaceLayoutNode,
  leafIndex: number,
  tabIndex: number,
  updater: (tab: WorkspaceTabDef) => WorkspaceTabDef
): WorkspaceLayoutNode {
  const counter: Counter = { current: 0 };
  return updateTabAtIndex(node, leafIndex, tabIndex, updater, counter);
}

function updateTabAtIndex(
  node: WorkspaceLayoutNode,
  targetLeaf: number,
  tabIndex: number,
  updater: (tab: WorkspaceTabDef) => WorkspaceTabDef,
  counter: Counter
): WorkspaceLayoutNode {
  if (node.type === "leaf") {
    if (counter.current === targetLeaf) {
      counter.current++;
      return {
        ...node,
        tabs: node.tabs.map((t, i) => (i === tabIndex ? updater(t) : t)),
      };
    }
    counter.current++;
    return node;
  }

  return {
    ...node,
    children: node.children.map((child) =>
      updateTabAtIndex(child, targetLeaf, tabIndex, updater, counter)
    ),
  };
}
