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
import { ConnectionConfig, TerminalTab, TabGroup, AgentErrorMeta } from "@/types/terminal";
import { SavedConnection } from "@/types/connection";
import {
  Model,
  type IJsonModel,
  type IJsonTabSetNode,
  type IJsonRowNode,
  type IJsonTabNode,
} from "flexlayout-react";
import { registerModel } from "@/utils/layoutModels";

/** Minimal agent state passed in during workspace launch to resolve agentRef tabs. */
export interface AgentContext {
  agents: Array<{ id: string; name: string; connected: boolean }>;
  definitions: Record<
    string,
    Array<{
      id: string;
      name: string;
      sessionType: string;
      persistent: boolean;
      config: Record<string, unknown>;
    }>
  >;
}

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

// --- Tab group building/capture for workspace launch ---

let tabIdCounter = 0;

function generateTabId(): string {
  tabIdCounter++;
  return `ws-tab-${tabIdCounter}`;
}

type ResolvedTab =
  | {
      kind: "terminal";
      config: ConnectionConfig;
      title: string;
      connectionType: string;
      workspaceAgentRef?: { agentId: string; definitionId: string };
    }
  | {
      kind: "agent-error";
      title: string;
      agentErrorMeta: AgentErrorMeta;
      workspaceAgentRef: { agentId: string; definitionId: string };
    };

function resolveTabConfig(
  tabDef: WorkspaceTabDef,
  savedConnections: SavedConnection[],
  defaultShell: string,
  agentContext?: AgentContext
): ResolvedTab {
  // Resolve agentRef tabs
  if (tabDef.agentRef) {
    const { agentId, definitionId } = tabDef.agentRef;
    const agent = agentContext?.agents.find((a) => a.id === agentId);
    const agentName = agent?.name ?? agentId;
    const workspaceAgentRef = { agentId, definitionId };

    if (agent?.connected) {
      const defs = agentContext?.definitions[agentId] ?? [];
      const def = defs.find((d) => d.id === definitionId);
      if (def) {
        const config: ConnectionConfig = {
          type: "remote-session",
          config: {
            agentId,
            sessionType: def.sessionType,
            shell: def.config["shell"] as string | undefined,
            serialPort: def.config["port"] as string | undefined,
            persistent: def.persistent,
            title: def.name,
          },
        };
        return {
          kind: "terminal",
          config,
          title: tabDef.title ?? def.name,
          connectionType: "remote-session",
          workspaceAgentRef,
        };
      }
      // Definition not found on connected agent — show error
      return {
        kind: "agent-error",
        title: tabDef.title ?? definitionId,
        workspaceAgentRef,
        agentErrorMeta: {
          agentId,
          agentName,
          definitionId,
          definitionName: tabDef.title ?? definitionId,
          error: `Connection definition "${definitionId}" was not found on agent "${agentName}".`,
          initialCommand: tabDef.initialCommand,
        },
      };
    }

    // Agent not connected or not found
    return {
      kind: "agent-error",
      title: tabDef.title ?? agentName,
      workspaceAgentRef,
      agentErrorMeta: {
        agentId,
        agentName,
        definitionId,
        definitionName: tabDef.title ?? definitionId,
        error: agent
          ? `Agent "${agentName}" is not connected.`
          : `Agent "${agentName}" was not found.`,
        initialCommand: tabDef.initialCommand,
      },
    };
  }

  // Try to resolve by connection ref
  if (tabDef.connectionRef) {
    const saved = savedConnections.find((c) => c.id === tabDef.connectionRef);
    if (saved) {
      return {
        kind: "terminal",
        config: saved.config,
        title: tabDef.title ?? saved.name,
        connectionType: saved.config.type,
      };
    }
  }

  // Fall back to inline config
  if (tabDef.inlineConfig) {
    return {
      kind: "terminal",
      config: tabDef.inlineConfig as ConnectionConfig,
      title: tabDef.title ?? "Terminal",
      connectionType: (tabDef.inlineConfig as ConnectionConfig).type ?? "local",
    };
  }

  // Default: local shell
  return {
    kind: "terminal",
    config: { type: "local", config: { shell: defaultShell } },
    title: tabDef.title ?? "Terminal",
    connectionType: "local",
  };
}

function captureTab(tab: TerminalTab, savedConnections: SavedConnection[]): WorkspaceTabDef {
  // Agent-error tabs and workspace-launched agent terminal tabs capture as agentRef
  if (tab.workspaceAgentRef) {
    return {
      agentRef: tab.workspaceAgentRef,
      title: tab.title,
      initialCommand: tab.initialCommand ?? tab.agentErrorMeta?.initialCommand,
    };
  }

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

/**
 * Capture the current flexlayout model JSON as a workspace layout definition.
 * Walks the model JSON rows/tabsets to build a WorkspaceLayoutNode tree.
 * Matches tabs to saved connection IDs where possible.
 * Agent-error tabs are preserved as agentRef entries so they survive workspace save/reload.
 */
export function captureCurrentLayout(
  modelJson: IJsonModel,
  tabs: TerminalTab[],
  savedConnections: SavedConnection[]
): WorkspaceLayoutNode {
  const tabMap = new Map(tabs.map((t) => [t.id, t]));
  return captureRow(modelJson.layout, tabMap, savedConnections);
}

function captureRow(
  row: IJsonRowNode,
  tabMap: Map<string, TerminalTab>,
  savedConnections: SavedConnection[]
): WorkspaceLayoutNode {
  const children = row.children ?? [];

  // If this row has a single tabset child, return a leaf
  if (children.length === 1 && (children[0] as IJsonTabSetNode).type === "tabset") {
    return captureTabset(children[0] as IJsonTabSetNode, tabMap, savedConnections);
  }

  // Mixed or multiple children: map each child recursively
  const mappedChildren = children.map((child) => {
    if ((child as IJsonTabSetNode).type === "tabset") {
      return captureTabset(child as IJsonTabSetNode, tabMap, savedConnections);
    }
    return captureRow(child as IJsonRowNode, tabMap, savedConnections);
  });

  if (mappedChildren.length === 1) {
    return mappedChildren[0];
  }

  // flexlayout root row = horizontal splits; nested rows = vertical splits
  // We use a simple heuristic: top-level row children side-by-side → horizontal
  // A row that is a child of a row has the opposite direction.
  // Since we don't have depth here, we default to horizontal at the root row level.
  // Nested rows within tabsets are always vertical.
  const direction: "horizontal" | "vertical" = row.type === "row" ? "horizontal" : "vertical";

  return {
    type: "split",
    direction,
    children: mappedChildren,
  };
}

function captureTabset(
  tabset: IJsonTabSetNode,
  tabMap: Map<string, TerminalTab>,
  savedConnections: SavedConnection[]
): WorkspaceLeafNode {
  const tabDefs = (tabset.children ?? [])
    .map((child) => {
      const tabNode = child as IJsonTabNode;
      const tab = tabId(tabNode) ? tabMap.get(tabId(tabNode)!) : undefined;
      if (!tab) return null;
      if (tab.contentType !== "terminal" && tab.contentType !== "agent-error") return null;
      return captureTab(tab, savedConnections);
    })
    .filter((t): t is WorkspaceTabDef => t !== null);

  return { type: "leaf", tabs: tabDefs };
}

function tabId(node: IJsonTabNode): string | undefined {
  return node.id as string | undefined;
}

let groupIdCounter = 0;

function generateWorkspaceGroupId(): string {
  groupIdCounter++;
  return `ws-group-${groupIdCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Build an array of TabGroup objects from workspace tab group definitions.
 * Each group gets a fresh ID, a newly-built IJsonModel, and a flat TerminalTab[].
 * Pass agentContext to resolve agentRef tabs into terminal or agent-error tabs.
 */
export function buildTabGroupsFromWorkspace(
  tabGroupDefs: WorkspaceTabGroupDef[],
  savedConnections: SavedConnection[],
  defaultShell: string,
  agentContext?: AgentContext
): TabGroup[] {
  return tabGroupDefs.map((def) => {
    const groupId = generateWorkspaceGroupId();

    // Collect all leaves and assign tabset IDs upfront
    const leaves = getWorkspaceLeaves(def.layout);
    let tsCounter = 0;
    const leafTabsetIds: string[] = leaves.map(() => {
      tsCounter++;
      return `ws-ts-${Date.now()}-${groupId}-${tsCounter}`;
    });

    // Build flat tabs array: for each leaf, resolve tabs with panelId = leafTabsetIds[i]
    const allTabs: TerminalTab[] = [];
    leaves.forEach((leaf, i) => {
      const tabsetId = leafTabsetIds[i];
      leaf.tabs.forEach((tabDef) => {
        const tabId = generateTabId();
        const resolved = resolveTabConfig(tabDef, savedConnections, defaultShell, agentContext);
        if (resolved.kind === "agent-error") {
          allTabs.push({
            id: tabId,
            sessionId: null,
            title: resolved.title,
            connectionType: "remote-session",
            contentType: "agent-error" as const,
            config: { type: "remote-session", config: {} },
            panelId: tabsetId,
            isActive: false,
            agentErrorMeta: resolved.agentErrorMeta,
            workspaceAgentRef: resolved.workspaceAgentRef,
            initialCommand: resolved.agentErrorMeta.initialCommand,
          });
        } else {
          allTabs.push({
            id: tabId,
            sessionId: null,
            title: resolved.title,
            connectionType: resolved.connectionType,
            contentType: "terminal" as const,
            config: resolved.config,
            panelId: tabsetId,
            isActive: false,
            workspaceAgentRef: resolved.workspaceAgentRef,
            initialCommand: tabDef.initialCommand,
          });
        }
      });
    });

    // Build model JSON from the layout, inserting tabs into their tabsets
    const { modelJson, firstTabsetId } = buildModelJsonFromLayoutWithIds(
      def.layout,
      allTabs,
      leafTabsetIds
    );

    // Register the model
    registerModel(groupId, Model.fromJson(modelJson));

    const firstTabsetActiveTabId = allTabs.find((t) => t.panelId === firstTabsetId)?.id ?? null;

    return {
      id: groupId,
      name: def.name,
      color: def.color,
      modelJson,
      tabs: allTabs,
      activeTabSetId: firstTabsetId || null,
      activeTabId: firstTabsetActiveTabId,
    };
  });
}

/**
 * Build a flexlayout IJsonModel from a WorkspaceLayoutNode tree,
 * using pre-assigned tabset IDs (matching the order of leaves in the tree).
 */
function buildModelJsonFromLayoutWithIds(
  layout: WorkspaceLayoutNode,
  tabs: TerminalTab[],
  leafTabsetIds: string[]
): { modelJson: IJsonModel; firstTabsetId: string } {
  let leafIndex = 0;
  const firstTabsetId = leafTabsetIds[0] ?? `ws-ts-${Date.now()}-fallback`;

  function buildRow(node: WorkspaceLayoutNode): IJsonRowNode | IJsonTabSetNode {
    if (node.type === "leaf") {
      const tsId = leafTabsetIds[leafIndex++] ?? `ws-ts-${Date.now()}-${leafIndex}`;
      const tabChildren: IJsonTabNode[] = tabs
        .filter((t) => t.panelId === tsId)
        .map((t) => ({ id: t.id, name: t.title }));
      return {
        type: "tabset",
        id: tsId,
        children: tabChildren,
      } as IJsonTabSetNode;
    }

    const children = node.children.map(buildRow);

    if (node.direction === "horizontal") {
      return { type: "row", children } as IJsonRowNode;
    } else {
      // Vertical: wrap each child in a row if it's a tabset
      const wrappedChildren = children.map((child) =>
        (child as { type: string }).type === "tabset"
          ? ({ type: "row", children: [child] } as IJsonRowNode)
          : (child as IJsonRowNode)
      );
      return { type: "row", children: wrappedChildren } as IJsonRowNode;
    }
  }

  const root = buildRow(layout);
  const rootRow: IJsonRowNode =
    (root as { type: string }).type === "row"
      ? (root as IJsonRowNode)
      : { type: "row", children: [root] };

  const modelJson: IJsonModel = {
    global: {
      tabEnableRename: false,
      tabEnableRenderOnDemand: false,
      tabSetEnableDeleteWhenEmpty: false,
      tabSetEnableMaximize: false,
      tabSetEnableTabScrollbar: false,
    },
    layout: rootRow,
  };

  return { modelJson, firstTabsetId };
}

/**
 * Capture all live tab groups as WorkspaceTabGroupDef[].
 * All data is read directly from the TabGroup objects (modelJson + flat tabs).
 */
export function captureAllTabGroups(
  tabGroups: TabGroup[],
  savedConnections: SavedConnection[]
): WorkspaceTabGroupDef[] {
  return tabGroups.map((group) => ({
    name: group.name,
    color: group.color,
    layout: captureCurrentLayout(group.modelJson, group.tabs, savedConnections),
  }));
}
