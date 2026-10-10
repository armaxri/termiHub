/**
 * Pure helpers for the keyboard / context-menu alternatives to dragging in the
 * sidebar: saved connections in the Connections tree (#4528) and remote agents
 * plus their saved connections in the Remote Agents tree (#4641). WCAG 2.1.1 /
 * 2.5.7.
 *
 * They compute the same store-action arguments the drag path produces
 * (`reorderConnections` / `reorderRemoteAgents(oldIndex, newIndex)`,
 * `moveConnectionToFolder` / `moveAgentDefToFolder`), so the menu, the shortcut
 * and dragging all end up in the same place.
 */
import type { SavedConnection } from "@/types/connection";
import { isMac } from "@/utils/platform";

/** The folder shape shared by local connection folders and agent folders. */
export interface MoveTargetFolder {
  id: string;
  name: string;
  parentId: string | null;
}

/** One entry in the "Move to Folder" submenu. */
export interface FolderMoveTarget {
  /** The folder id passed to `moveConnectionToFolder` / `moveAgentDefToFolder`. */
  id: string;
  /** The folder's full path, e.g. `Work / Dev`, so nested folders are unambiguous. */
  label: string;
}

/**
 * List every folder in tree order (depth first, keeping the store's sibling
 * order), each labelled with its full path. Folders whose parent is missing
 * are unreachable in the tree and are left out.
 */
export function folderMoveTargets(folders: readonly MoveTargetFolder[]): FolderMoveTarget[] {
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
  return neighbourReorderIndices(connectionId, delta, siblings, allConnections);
}

/**
 * The `reorderRemoteAgents` arguments that move `agentId` one place up (`-1`) or
 * down (`1`) in the Remote Agents list, or `null` when it is already first /
 * last there (or unknown).
 *
 * @param visibleAgents The agents the sidebar shows (a search filter may hide
 *   some), so the move swaps with the neighbour the user can see.
 * @param allAgents The full list the store reorders; the returned indices are
 *   into this list, exactly like the drag path's.
 */
export function agentReorderIndices(
  agentId: string,
  delta: -1 | 1,
  visibleAgents: readonly { id: string }[],
  allAgents: readonly { id: string }[]
): { oldIndex: number; newIndex: number } | null {
  return neighbourReorderIndices(agentId, delta, visibleAgents, allAgents);
}

/** Shared core: swap `id` with its neighbour in `siblings`, as indices into `all`. */
function neighbourReorderIndices(
  id: string,
  delta: -1 | 1,
  siblings: readonly { id: string }[],
  all: readonly { id: string }[]
): { oldIndex: number; newIndex: number } | null {
  const position = siblings.findIndex((item) => item.id === id);
  if (position === -1) return null;
  const neighbour = siblings[position + delta];
  if (!neighbour) return null;
  const oldIndex = all.findIndex((item) => item.id === id);
  const newIndex = all.findIndex((item) => item.id === neighbour.id);
  if (oldIndex === -1 || newIndex === -1) return null;
  return { oldIndex, newIndex };
}

/**
 * Whether a keydown is the "move this row" shortcut: Ctrl/Cmd+Shift+ArrowUp or
 * ArrowDown (no Alt). Returns the direction, or `null` for any other key.
 */
export function moveShortcutDelta(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): -1 | 1 | null {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return null;
  if (event.key === "ArrowUp") return -1;
  if (event.key === "ArrowDown") return 1;
  return null;
}

/** Shortcut hint shown next to Move Up / Move Down (Cmd on macOS, Ctrl elsewhere). */
export function moveShortcutHint(direction: "Up" | "Down"): string {
  const arrow = direction === "Up" ? "\u2191" : "\u2193";
  return isMac() ? `\u2318\u21e7${arrow}` : `Ctrl+Shift+${arrow}`;
}
