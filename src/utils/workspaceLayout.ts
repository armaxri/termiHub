/**
 * Utility functions for workspace layout tree manipulation.
 */

import {
  WorkspaceLayoutNode,
  WorkspaceLeafNode,
  WorkspaceSplitNode,
  WorkspaceTabDef,
  WorkspaceTabGroupDef,
} from "@/types/workspace";
import { PanelNode, ConnectionConfig, TerminalTab, TabGroup } from "@/types/terminal";
import { SavedConnection } from "@/types/connection";

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
  let foundChildIdx: number | null = null;
  const newChildren = node.children.map((child, i) => {
    const result = splitAtIndex(child, targetIndex, direction, counter);
    if (result.newLeafIndex !== null) {
      foundIndex = result.newLeafIndex;
      foundChildIdx = i;
    }
    return result.node;
  });

  // If a child was split and this split has sizes, recalculate
  let newSizes = node.sizes;
  if (foundChildIdx !== null && newSizes) {
    newSizes = [...newSizes];
    const halfSize = newSizes[foundChildIdx] / 2;
    newSizes[foundChildIdx] = halfSize;
    // The split created a new split child (replacing the leaf), so sizes stay same length
    // unless the new split direction matches this node's direction — in that case the
    // splitAtIndex created a nested split, not an inline sibling, so sizes are unchanged.
  }

  return {
    node: { ...node, children: newChildren, ...(newSizes ? { sizes: newSizes } : {}) },
    newLeafIndex: foundIndex,
  };
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

  const results = node.children.map((child) => removeLeafAtIndex(child, targetIndex, counter));
  const newChildren = results.filter((child): child is WorkspaceLayoutNode => child !== null);

  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0];

  // Recalculate sizes if present
  let newSizes: number[] | undefined;
  if (node.sizes) {
    newSizes = [];
    let removedSize = 0;
    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) {
        removedSize += node.sizes[i] ?? 0;
      } else {
        newSizes.push(node.sizes[i] ?? 0);
      }
    }
    // Distribute removed size proportionally among remaining
    if (newSizes.length > 0 && removedSize > 0) {
      const remainingTotal = newSizes.reduce((a, b) => a + b, 0);
      if (remainingTotal > 0) {
        newSizes = newSizes.map((s) => s + (removedSize * s) / remainingTotal);
      } else {
        newSizes = newSizes.map(() => 100 / newSizes!.length);
      }
    }
  }

  return { ...node, children: newChildren, ...(newSizes ? { sizes: newSizes } : {}) };
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

/**
 * Move a tab from one leaf to another.
 * If the source leaf becomes empty and there are other leaves, it is removed.
 * Returns the updated layout, or the original if indices are invalid.
 */
export function moveTabBetweenLeaves(
  node: WorkspaceLayoutNode,
  fromLeafIndex: number,
  tabIndex: number,
  toLeafIndex: number
): WorkspaceLayoutNode {
  if (fromLeafIndex === toLeafIndex) return node;

  const leaves = getWorkspaceLeaves(node);
  const fromLeaf = leaves[fromLeafIndex];
  const toLeaf = leaves[toLeafIndex];
  if (!fromLeaf || !toLeaf) return node;
  if (tabIndex < 0 || tabIndex >= fromLeaf.tabs.length) return node;

  const tab = fromLeaf.tabs[tabIndex];

  // Add the tab to the target leaf
  let result = addTabToLeaf(node, toLeafIndex, tab);

  // Remove the tab from the source leaf — adjust index if target is before source
  // because addTabToLeaf doesn't change leaf ordering
  result = removeTabFromLeaf(result, fromLeafIndex, tabIndex);

  // If the source leaf is now empty and there's more than one leaf, remove it
  const updatedLeaves = getWorkspaceLeaves(result);
  const sourceLeaf = updatedLeaves[fromLeafIndex];
  if (sourceLeaf && sourceLeaf.tabs.length === 0 && updatedLeaves.length > 1) {
    const cleaned = removeWorkspaceLeaf(result, fromLeafIndex);
    if (cleaned) result = cleaned;
  }

  return result;
}

/**
 * Add a new empty leaf panel as a child of a specific split node.
 * Identifies the target split by reference equality.
 */
export function addLeafToSplit(
  root: WorkspaceLayoutNode,
  targetSplit: WorkspaceSplitNode
): WorkspaceLayoutNode {
  if (root.type === "leaf") return root;

  if (root === targetSplit) {
    const newLeaf: WorkspaceLeafNode = { type: "leaf", tabs: [] };
    // Recalculate sizes: take fair share from existing panels
    let newSizes: number[] | undefined;
    if (root.sizes) {
      const newCount = root.children.length + 1;
      const fairShare = 100 / newCount;
      const scaleFactor = (100 - fairShare) / 100;
      newSizes = root.sizes.map((s) => s * scaleFactor);
      newSizes.push(fairShare);
    }
    return {
      ...root,
      children: [...root.children, newLeaf],
      ...(newSizes ? { sizes: newSizes } : {}),
    };
  }

  return {
    ...root,
    children: root.children.map((child) => addLeafToSplit(child, targetSplit)),
  };
}

/**
 * Wrap a specific split node in a new split of a different direction,
 * adding a new empty leaf sibling. Identifies the target by reference equality.
 */
export function wrapSplitInNewDirection(
  root: WorkspaceLayoutNode,
  targetSplit: WorkspaceSplitNode,
  direction: "horizontal" | "vertical"
): WorkspaceLayoutNode {
  if (root === targetSplit) {
    const newLeaf: WorkspaceLeafNode = { type: "leaf", tabs: [] };
    return { type: "split", direction, children: [root, newLeaf] };
  }

  if (root.type === "leaf") return root;

  return {
    ...root,
    children: root.children.map((child) => wrapSplitInNewDirection(child, targetSplit, direction)),
  };
}

/**
 * Update or clear the sizes array on a split node identified by reference equality.
 * Pass `null` to clear sizes (revert to equal distribution).
 */
export function updateSplitSizes(
  root: WorkspaceLayoutNode,
  targetSplit: WorkspaceSplitNode,
  sizes: number[] | null
): WorkspaceLayoutNode {
  if (root === targetSplit) {
    if (sizes === null) {
      const { sizes: _removed, ...rest } = root;
      return rest as WorkspaceSplitNode;
    }
    return { ...root, sizes };
  }

  if (root.type === "leaf") return root;

  return {
    ...root,
    children: root.children.map((child) => updateSplitSizes(child, targetSplit, sizes)),
  };
}

// --- Panel tree building/capture for workspace launch ---

let panelIdCounter = 0;

function generatePanelId(): string {
  panelIdCounter++;
  return `ws-panel-${panelIdCounter}`;
}

let tabIdCounter = 0;

function generateTabId(): string {
  tabIdCounter++;
  return `ws-tab-${tabIdCounter}`;
}

/**
 * Build a PanelNode tree from a workspace layout definition.
 * Resolves connection refs to saved connections, falling back to inline configs.
 */
export function buildPanelTreeFromWorkspace(
  layout: WorkspaceLayoutNode,
  savedConnections: SavedConnection[],
  defaultShell: string
): PanelNode {
  if (layout.type === "leaf") {
    const panelId = generatePanelId();
    const tabs: TerminalTab[] = layout.tabs.map((tabDef) => {
      const tabId = generateTabId();
      const { config, title, connectionType } = resolveTabConfig(
        tabDef,
        savedConnections,
        defaultShell
      );
      return {
        id: tabId,
        sessionId: null,
        title,
        connectionType,
        contentType: "terminal" as const,
        config,
        panelId,
        isActive: false,
        initialCommand: tabDef.initialCommand,
      };
    });

    // Mark first tab as active
    if (tabs.length > 0) {
      tabs[0].isActive = true;
    }

    return {
      type: "leaf",
      id: panelId,
      tabs,
      activeTabId: tabs[0]?.id ?? null,
    };
  }

  return {
    type: "split",
    id: generatePanelId(),
    direction: layout.direction,
    children: layout.children.map((child) =>
      buildPanelTreeFromWorkspace(child, savedConnections, defaultShell)
    ),
    ...(layout.sizes ? { sizes: [...layout.sizes] } : {}),
  };
}

function resolveTabConfig(
  tabDef: WorkspaceTabDef,
  savedConnections: SavedConnection[],
  defaultShell: string
): { config: ConnectionConfig; title: string; connectionType: string } {
  // Try to resolve by connection ref
  if (tabDef.connectionRef) {
    const saved = savedConnections.find((c) => c.id === tabDef.connectionRef);
    if (saved) {
      return {
        config: saved.config,
        title: tabDef.title ?? saved.name,
        connectionType: saved.config.type,
      };
    }
  }

  // Fall back to inline config
  if (tabDef.inlineConfig) {
    return {
      config: tabDef.inlineConfig as ConnectionConfig,
      title: tabDef.title ?? "Terminal",
      connectionType: (tabDef.inlineConfig as ConnectionConfig).type ?? "local",
    };
  }

  // Default: local shell
  return {
    config: { type: "local", config: { shell: defaultShell } },
    title: tabDef.title ?? "Terminal",
    connectionType: "local",
  };
}

/**
 * Capture the current live panel tree as a workspace layout definition.
 * Matches tabs to saved connection IDs where possible.
 */
export function captureCurrentLayout(
  rootPanel: PanelNode,
  savedConnections: SavedConnection[]
): WorkspaceLayoutNode {
  if (rootPanel.type === "leaf") {
    return {
      type: "leaf",
      tabs: rootPanel.tabs
        .filter((tab) => tab.contentType === "terminal")
        .map((tab) => captureTab(tab, savedConnections)),
    };
  }

  return {
    type: "split",
    direction: rootPanel.direction,
    children: rootPanel.children.map((child) => captureCurrentLayout(child, savedConnections)),
    ...(rootPanel.sizes ? { sizes: [...rootPanel.sizes] } : {}),
  };
}

function captureTab(tab: TerminalTab, savedConnections: SavedConnection[]): WorkspaceTabDef {
  // Try to match to a saved connection by config type and matching fields
  const matchedConnection = savedConnections.find(
    (c) =>
      c.config.type === tab.config.type &&
      JSON.stringify(c.config.config) === JSON.stringify(tab.config.config)
  );

  if (matchedConnection) {
    return {
      connectionRef: matchedConnection.id,
      title: tab.title !== matchedConnection.name ? tab.title : undefined,
      initialCommand: tab.initialCommand,
    };
  }

  return {
    inlineConfig: tab.config as { type: string; config: Record<string, unknown> },
    title: tab.title,
    initialCommand: tab.initialCommand,
  };
}

let groupIdCounter = 0;

function generateWorkspaceGroupId(): string {
  groupIdCounter++;
  return `ws-group-${groupIdCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Build an array of TabGroup objects from workspace tab group definitions.
 * Each group gets a fresh ID and a newly-built PanelNode tree.
 */
export function buildTabGroupsFromWorkspace(
  tabGroupDefs: WorkspaceTabGroupDef[],
  savedConnections: SavedConnection[],
  defaultShell: string
): TabGroup[] {
  return tabGroupDefs.map((def) => {
    const rootPanel = buildPanelTreeFromWorkspace(def.layout, savedConnections, defaultShell);
    const firstLeaf =
      rootPanel.type === "leaf" ? rootPanel : getAllWorkspaceLeafPanels(rootPanel)[0];
    return {
      id: generateWorkspaceGroupId(),
      name: def.name,
      color: def.color,
      rootPanel,
      activePanelId: firstLeaf?.id ?? null,
    };
  });
}

/** Collect all leaf panels from a PanelNode tree (used internally). */
function getAllWorkspaceLeafPanels(node: PanelNode): Extract<PanelNode, { type: "leaf" }>[] {
  if (node.type === "leaf") return [node];
  return node.children.flatMap(getAllWorkspaceLeafPanels);
}

/**
 * Capture all live tab groups as WorkspaceTabGroupDef[].
 * The active group uses the provided live rootPanel; inactive groups use their
 * saved rootPanel from the tabGroups array.
 */
export function captureAllTabGroups(
  tabGroups: TabGroup[],
  activeTabGroupId: string,
  liveRootPanel: PanelNode,
  savedConnections: SavedConnection[]
): WorkspaceTabGroupDef[] {
  return tabGroups.map((group) => {
    const panelTree = group.id === activeTabGroupId ? liveRootPanel : group.rootPanel;
    return {
      name: group.name,
      color: group.color,
      layout: captureCurrentLayout(panelTree, savedConnections),
    };
  });
}
