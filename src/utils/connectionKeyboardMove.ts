/**
 * Pure helpers for the keyboard / context-menu alternatives to dragging a saved
 * connection in the Connections sidebar tree (#4528, WCAG 2.1.1 / 2.5.7).
 *
 * They compute the same store-action arguments the drag path produces
 * (`reorderConnections(oldIndex, newIndex)` / `moveConnectionToFolder`), so the
 * menu, the shortcut and dragging all end up in the same place.
 */
import type { ConnectionFolder, SavedConnection } from "@/types/connection";

/** One entry in the "Move to Folder" submenu. */
export interface FolderMoveTarget {
  /** The folder id passed to `moveConnectionToFolder`. */
  id: string;
  /** The folder's full path, e.g. `Work / Dev`, so nested folders are unambiguous. */
  label: string;
}

/**
 * List every folder in tree order (depth first, keeping the store's sibling
 * order), each labelled with its full path. Folders whose parent is missing
 * are unreachable in the tree and are left out.
 */
export function folderMoveTargets(folders: readonly ConnectionFolder[]): FolderMoveTarget[] {
  const result: FolderMoveTarget[] = [];
  const visit = (parentId: string | null, prefix: string, seen: Set<string>) => {
    for (const folder of folders) {
      if (folder.parentId !== parentId || seen.has(folder.id)) continue;
      const label = prefix ? `${prefix} / ${folder.name}` : folder.name;
      result.push({ id: folder.id, label });
      seen.add(folder.id);
      visit(folder.id, label, seen);
    }
  };
  visit(null, "", new Set());
  return result;
}

/**
 * The `reorderConnections` arguments that move `connectionId` one place up
 * (`-1`) or down (`1`) among the connections in its own folder, or `null` when
 * it is already first / last there (or unknown).
 *
 * @param siblingsSource The connections the tree shows (sibling order is taken
 *   from here, so hidden experimental connections are skipped).
 * @param allConnections The full list the store reorders; the returned indices
 *   are into this list, exactly like the drag path's.
 */
export function connectionReorderIndices(
  connectionId: string,
  delta: -1 | 1,
  siblingsSource: readonly SavedConnection[],
  allConnections: readonly SavedConnection[]
): { oldIndex: number; newIndex: number } | null {
  const connection = siblingsSource.find((c) => c.id === connectionId);
  if (!connection) return null;
  const siblings = siblingsSource.filter((c) => c.folderId === connection.folderId);
  const position = siblings.findIndex((c) => c.id === connectionId);
  const neighbour = siblings[position + delta];
  if (!neighbour) return null;
  const oldIndex = allConnections.findIndex((c) => c.id === connectionId);
  const newIndex = allConnections.findIndex((c) => c.id === neighbour.id);
  if (oldIndex === -1 || newIndex === -1) return null;
  return { oldIndex, newIndex };
}
