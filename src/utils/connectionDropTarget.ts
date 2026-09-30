/**
 * Pure resolver for dropping a saved connection in the Connections sidebar
 * tree (#3689). Extracted from `ConnectionList`'s `handleDragEnd` so the
 * root / folder / reorder decision can be unit-tested without dnd-kit.
 */
import type { SavedConnection } from "@/types/connection";

/** The drop target as dnd-kit reports it (`over.id` + `over.data.current`). */
export interface ConnectionDropOver {
  id: string;
  type?: string;
  /** The target connection when `type === "connection"`. */
  connection?: SavedConnection;
}

export interface ConnectionDropContext {
  /** The connection being dragged. */
  dragged: SavedConnection;
  over: ConnectionDropOver;
  /** The current multi-selection in the tree. */
  selectedIds: ReadonlySet<string>;
  /** Connections used to skip items already in the target folder. */
  connections: readonly SavedConnection[];
  /**
   * The full, unfiltered connection list the backend reorders — reorder
   * indices are into this list, not the experimental-gated render list.
   */
  allConnections: readonly SavedConnection[];
}

/**
 * - `ignore`: not a connection drop target; leave the selection alone.
 * - `clear`: nothing to do beyond clearing the selection.
 * - `reorder`: sibling reorder within the same folder, then clear.
 * - `move`: move `connectionIds` (already filtered to those not yet in the
 *   target folder; may be empty) into `targetFolderId`, then clear.
 */
export type ConnectionDropAction =
  | { kind: "ignore" }
  | { kind: "clear" }
  | { kind: "reorder"; oldIndex: number; newIndex: number }
  | { kind: "move"; connectionIds: string[]; targetFolderId: string | null };

/** Decide what dropping `dragged` onto `over` should do. */
export function resolveConnectionDrop(ctx: ConnectionDropContext): ConnectionDropAction {
  const { dragged, over, selectedIds, connections, allConnections } = ctx;
  const isMultiDrag = selectedIds.has(dragged.id) && selectedIds.size > 1;

  let targetFolderId: string | null | undefined;

  if (over.id === "root") {
    targetFolderId = null;
  } else if (over.type === "folder") {
    targetFolderId = over.id;
  } else if (over.type === "connection" && over.connection) {
    // Dropped onto another connection (#2594). Within the same folder this is a
    // sibling reorder; across folders it falls back to a move into the target's
    // folder (so dropping onto a connection behaves like dropping onto its
    // folder). A multi-select drag always uses the move path so the whole
    // selection lands together — reorder is single-item.
    const targetConn = over.connection;
    if (targetConn.id === dragged.id) return { kind: "clear" };
    if (!isMultiDrag && dragged.folderId === targetConn.folderId) {
      const oldIndex = allConnections.findIndex((c) => c.id === dragged.id);
      const newIndex = allConnections.findIndex((c) => c.id === targetConn.id);
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        return { kind: "reorder", oldIndex, newIndex };
      }
      return { kind: "clear" };
    }
    targetFolderId = targetConn.folderId;
  }

  if (targetFolderId === undefined) return { kind: "ignore" };

  // Move all selected connections, or just the dragged one if it's a single-item drag
  const idsToMove = isMultiDrag ? [...selectedIds] : [dragged.id];

  // Skip connections already in the target folder
  const connectionIds = idsToMove.filter((id) => {
    const conn = connections.find((c) => c.id === id);
    return conn?.folderId !== targetFolderId;
  });

  return { kind: "move", connectionIds, targetFolderId };
}
