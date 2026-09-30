/**
 * Optimistic folds for the connections tree (#2831).
 *
 * The persist command is the **single writer** of the shared `connections`
 * region: it writes `connections.json` and folds the disk truth into the region
 * in one backend step. For instant feedback the connections bridge layers a
 * client-local optimistic overlay on top of that region while the persist is in
 * flight (`persistWithOverlay` in `connectionsBridge`); these are the pure
 * transforms that overlay applies.
 *
 * Every fold:
 * - **never mutates its input** — the authoritative view is shared with every
 *   reader, and a previously-emitted view must stay intact;
 * - is **idempotent / set-shaped** (upsert, set a field, set an order) rather
 *   than relative (append, flip), because while the persist settles the fold may
 *   briefly be layered over a base that already carries the persisted change.
 *   A set-shaped fold then re-states what the base already says instead of
 *   applying the change twice (a `toggle` would flip it back).
 */

import type { ConnectionFolder, SavedConnection } from "@/types/connection";

/**
 * The projected connections view model: the flat folder tree plus the flat
 * saved-connection list, nesting expressed by parent pointers and ordering by
 * array position — the shape the Rust `ConnectionsStore::snapshot` serialises.
 */
export interface ConnectionsView {
  folders: ConnectionFolder[];
  connections: SavedConnection[];
}

/** A pure optimistic transform of the connections view. */
export type ConnectionsFold = (view: ConnectionsView) => ConnectionsView;

/** Add the connection, or replace the entry with the same id. */
export function upsertConnection(connection: SavedConnection): ConnectionsFold {
  return (view) => {
    const exists = view.connections.some((c) => c.id === connection.id);
    return {
      folders: view.folders,
      connections: exists
        ? view.connections.map((c) => (c.id === connection.id ? connection : c))
        : [...view.connections, connection],
    };
  };
}

/** Replace the entry with the same id; a no-op when there is none. */
export function replaceConnection(connection: SavedConnection): ConnectionsFold {
  return (view) => ({
    folders: view.folders,
    connections: view.connections.map((c) => (c.id === connection.id ? connection : c)),
  });
}

/** Drop the connection with this id. */
export function removeConnection(connectionId: string): ConnectionsFold {
  return (view) => ({
    folders: view.folders,
    connections: view.connections.filter((c) => c.id !== connectionId),
  });
}

/** Set a connection's folder (`null` = root). */
export function moveConnection(connectionId: string, folderId: string | null): ConnectionsFold {
  return (view) => ({
    folders: view.folders,
    connections: view.connections.map((c) => (c.id === connectionId ? { ...c, folderId } : c)),
  });
}

/**
 * Put the connections in the given id order — the listed ids first, in that
 * order, then every unlisted connection in its current order (the backend
 * `reorder_connections` rule).
 */
export function orderConnections(connectionIds: readonly string[]): ConnectionsFold {
  return (view) => {
    const byId = new Map(view.connections.map((c) => [c.id, c]));
    const listed = new Set(connectionIds);
    const ordered: SavedConnection[] = [];
    for (const id of connectionIds) {
      const connection = byId.get(id);
      if (connection) ordered.push(connection);
    }
    for (const connection of view.connections) {
      if (!listed.has(connection.id)) ordered.push(connection);
    }
    return { folders: view.folders, connections: ordered };
  };
}

/** Add the folder, or replace the entry with the same id. */
export function upsertFolder(folder: ConnectionFolder): ConnectionsFold {
  return (view) => {
    const exists = view.folders.some((f) => f.id === folder.id);
    return {
      folders: exists
        ? view.folders.map((f) => (f.id === folder.id ? folder : f))
        : [...view.folders, folder],
      connections: view.connections,
    };
  };
}

/**
 * Remove a folder, re-homing its children the way the backend does: child
 * folders move to the removed folder's parent, child connections to root.
 */
export function removeFolder(folderId: string): ConnectionsFold {
  return (view) => {
    const removed = view.folders.find((f) => f.id === folderId);
    if (!removed) return view;
    const parentId = removed.parentId ?? null;
    return {
      folders: view.folders
        .filter((f) => f.id !== folderId)
        .map((f) => (f.parentId === folderId ? { ...f, parentId } : f)),
      connections: view.connections.map((c) =>
        c.folderId === folderId ? { ...c, folderId: null } : c
      ),
    };
  };
}

/** Set a folder's persisted `isExpanded`. */
export function setFolderExpanded(folderId: string, isExpanded: boolean): ConnectionsFold {
  return (view) => ({
    folders: view.folders.map((f) => (f.id === folderId ? { ...f, isExpanded } : f)),
    connections: view.connections,
  });
}
