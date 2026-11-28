/**
 * Move a dragged tab across tab groups (tab-groups concept, #6201).
 *
 * After a dwell on a chip switched the view, the tab is still in the group the
 * drag started in, which is now inactive (its tree is the saved
 * `tabGroups[i].rootPanel`). A drop then puts it into a panel of the visible
 * group (the live `rootPanel`): stacked on a centre drop, or in a new panel
 * split off on an edge drop. A drop on another group's chip puts it into that
 * group's first panel.
 */
import type { DropEdge, PanelNode, TabGroup, TerminalTab } from "@/types/terminal";
import { removeTabFromLeaf } from "./layoutHelpers";
import {
  createLeafPanel,
  edgeToSplit,
  findLeaf,
  getAllLeaves,
  removeLeaf,
  simplifyTree,
  splitLeaf,
  updateLeaf,
} from "@/utils/panelTree";

/** The layout fields a cross-group move reads and writes. */
export interface CrossGroupLayout {
  rootPanel: PanelNode;
  tabGroups: TabGroup[];
  activeTabGroupId: string;
}

/** What to move, and where. */
export interface CrossGroupMove {
  tabId: string;
  /** The group the drag started in; must not be the active group. */
  fromGroupId: string;
  fromPanelId: string;
  /** The group the tab goes to: the active one, or any other but the source. */
  toGroupId: string;
  /** The target panel; `null` for the target group's first panel. */
  toPanelId: string | null;
  /** Where on the target panel: `center` stacks, an edge splits. */
  edge: DropEdge;
}

/** The changed layout fields, or `null` when the move does not apply. */
export interface CrossGroupResult {
  rootPanel: PanelNode;
  tabGroups: TabGroup[];
  activePanelId?: string | null;
}

/** Drop `tabId` from `tree`'s panel, pruning that panel when it empties (not the last one). */
function takeTab(
  tree: PanelNode,
  panelId: string,
  tabId: string
): { tree: PanelNode; tab: TerminalTab } | null {
  const leaf = findLeaf(tree, panelId);
  const tab = leaf?.tabs.find((t) => t.id === tabId);
  if (!leaf || !tab) return null;
  let next = updateLeaf(tree, panelId, (l) => removeTabFromLeaf(l, tabId));
  const emptied = findLeaf(next, panelId);
  if (emptied && emptied.tabs.length === 0 && getAllLeaves(next).length > 1) {
    const removed = removeLeaf(next, panelId);
    next = removed ? simplifyTree(removed) : next;
  }
  return { tree: next, tab };
}

/** Put `tab` into `tree` at `panelId`/`edge`; returns the tree and the panel it landed in. */
function putTab(
  tree: PanelNode,
  panelId: string,
  edge: DropEdge,
  tab: TerminalTab
): { tree: PanelNode; panelId: string } {
  const split = edgeToSplit(edge);
  if (!split) {
    const moved: TerminalTab = { ...tab, panelId, isActive: true };
    const next = updateLeaf(tree, panelId, (leaf) => ({
      ...leaf,
      tabs: [...leaf.tabs.map((t) => ({ ...t, isActive: false })), moved],
      activeTabId: moved.id,
    }));
    return { tree: next, panelId };
  }
  const leaf = createLeafPanel();
  const moved: TerminalTab = { ...tab, panelId: leaf.id, isActive: true };
  leaf.tabs = [moved];
  leaf.activeTabId = moved.id;
  const next = simplifyTree(splitLeaf(tree, panelId, leaf, split.direction, split.position));
  return { tree: next, panelId: leaf.id };
}

/** Move a tab out of its (inactive) source group into another group. */
export function moveTabAcrossGroups(
  layout: CrossGroupLayout,
  move: CrossGroupMove
): CrossGroupResult | null {
  const { activeTabGroupId, tabGroups } = layout;
  if (move.fromGroupId === activeTabGroupId || move.fromGroupId === move.toGroupId) return null;
  const source = tabGroups.find((g) => g.id === move.fromGroupId);
  const target = tabGroups.find((g) => g.id === move.toGroupId);
  if (!source || !target) return null;

  const toActive = move.toGroupId === activeTabGroupId;
  const targetTree = toActive ? layout.rootPanel : target.rootPanel;
  const targetPanelId = move.toPanelId ?? getAllLeaves(targetTree)[0]?.id;
  if (!targetPanelId || !findLeaf(targetTree, targetPanelId)) return null;

  const taken = takeTab(source.rootPanel, move.fromPanelId, move.tabId);
  if (!taken) return null;
  // Another group's first panel takes the tab stacked, never split.
  const placed = putTab(targetTree, targetPanelId, toActive ? move.edge : "center", taken.tab);

  const sourceActivePanel =
    source.activePanelId && findLeaf(taken.tree, source.activePanelId)
      ? source.activePanelId
      : (getAllLeaves(taken.tree)[0]?.id ?? null);
  const nextGroups = tabGroups.map((g) => {
    if (g.id === source.id)
      return { ...g, rootPanel: taken.tree, activePanelId: sourceActivePanel };
    if (!toActive && g.id === target.id) return { ...g, rootPanel: placed.tree };
    return g;
  });
  return toActive
    ? { rootPanel: placed.tree, tabGroups: nextGroups, activePanelId: placed.panelId }
    : { rootPanel: layout.rootPanel, tabGroups: nextGroups };
}
