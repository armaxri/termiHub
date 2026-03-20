/**
 * Utility functions for workspace layout tree manipulation.
 */

import {
  WorkspaceLayoutNode,
  WorkspaceLeafNode,
  WorkspaceSplitNode,
  WorkspaceTabDef,
} from "@/types/workspace";
import { PanelNode, ConnectionConfig, TerminalTab } from "@/types/terminal";
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
