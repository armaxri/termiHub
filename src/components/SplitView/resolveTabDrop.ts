/**
 * Pure routing for a finished tab drag (TFE2-004, #4329).
 *
 * `SplitView.handleDragEnd` used to inline all of this, which left it
 * untestable. It now reads the dnd-kit event into a {@link TabDropInput},
 * asks {@link resolveTabDrop} what the drop means, and dispatches the result
 * to the store.
 */
import type { DropEdge, PanelNode } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";

/** What an element under the drop point is, for drops outside every droppable. */
export interface PointerHit {
  /** Id of the tab-group chip the element belongs to, if any. */
  tabGroupId: string | null;
  /** Whether the element belongs to the "new tab group" button. */
  newGroupButton: boolean;
}

/** Everything the drop routing needs, already read out of the dnd-kit event. */
export interface TabDropInput {
  /** The dragged tab. */
  tabId: string;
  /** The panel the tab was dragged from; `undefined` when the drag carried none. */
  fromPanelId: string | undefined;
  /** The droppable the tab was released over, or `null` for none. */
  overId: string | null;
  /** The panel of the sortable tab under the drop, when it is one. */
  overPanelId: string | undefined;
  /** The active group's panel tree. */
  rootPanel: PanelNode;
  /** What lies under the drop point (top-most first), used when `overId` is `null`. */
  pointerHits: PointerHit[];
}

/** The store operation a tab drop resolves to. */
export type TabDropAction =
  | { kind: "none" }
  | { kind: "moveToGroup"; groupId: string }
  | { kind: "newGroup" }
  | { kind: "split"; targetPanelId: string; edge: DropEdge }
  | { kind: "move"; toPanelId: string; index: number }
  | { kind: "reorder"; panelId: string; oldIndex: number; newIndex: number };

/** Describe the elements under a drop point (from `document.elementsFromPoint`). */
export function describePointerHits(elements: Element[]): PointerHit[] {
  return elements.map((el) => ({
    tabGroupId: el.closest("[data-tab-group-id]")?.getAttribute("data-tab-group-id") ?? null,
    newGroupButton: el.closest("[data-new-group-btn]") !== null,
  }));
}

/** Decide what a tab drop does. */
export function resolveTabDrop(input: TabDropInput): TabDropAction {
  const { tabId, fromPanelId, overId, overPanelId, rootPanel, pointerHits } = input;
  if (!fromPanelId) return { kind: "none" };

  // Not over any registered droppable: look for the targets outside the
  // DndContext (group chips, the new-group button). A chip wins over the
  // adjacent new-group button anywhere in the stack, so a drop grazing their
  // boundary lands on the intended group rather than creating a new one.
  if (overId === null) {
    const chip = pointerHits.find((hit) => hit.tabGroupId !== null);
    if (chip?.tabGroupId) return { kind: "moveToGroup", groupId: chip.tabGroupId };
    if (pointerHits.some((hit) => hit.newGroupButton)) return { kind: "newGroup" };
    return { kind: "none" };
  }

  // Edge drop `edge-{panelId}-{edge}`: panel ids may contain dashes, so the edge
  // is the last segment and the panel id everything between.
  if (overId.startsWith("edge-")) {
    const parts = overId.split("-");
    const edge = parts[parts.length - 1] as DropEdge;
    return { kind: "split", targetPanelId: parts.slice(1, -1).join("-"), edge };
  }

  // Center drop: move the tab into that panel (a no-op onto its own panel).
  if (overId.startsWith("center-")) {
    const targetPanelId = overId.slice("center-".length);
    if (targetPanelId === fromPanelId) return { kind: "none" };
    return { kind: "split", targetPanelId, edge: "center" };
  }

  const leaves = getAllLeaves(rootPanel);

  // Dropped on a tab in another panel: insert at that tab's index (or append).
  if (overPanelId && overPanelId !== fromPanelId) {
    const destLeaf = leaves.find((l) => l.id === overPanelId);
    if (!destLeaf) return { kind: "none" };
    const overIndex = destLeaf.tabs.findIndex((t) => t.id === overId);
    return { kind: "move", toPanelId: overPanelId, index: overIndex >= 0 ? overIndex : -1 };
  }

  // Same-panel reorder.
  if (tabId === overId) return { kind: "none" };
  const sourceLeaf = leaves.find((l) => l.id === fromPanelId);
  if (!sourceLeaf) return { kind: "none" };
  const oldIndex = sourceLeaf.tabs.findIndex((t) => t.id === tabId);
  const newIndex = sourceLeaf.tabs.findIndex((t) => t.id === overId);
  if (oldIndex === -1 || newIndex === -1) return { kind: "none" };
  return { kind: "reorder", panelId: fromPanelId, oldIndex, newIndex };
}
