import type { ConnectionFolder, SavedConnection } from "@/types/connection";

/** Pluralise a count: `1 connection`, `2 connections`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The confirmation message for deleting a connection folder (#5158). Deleting
 * a folder keeps its contents: its direct connections and subfolders move up
 * to the folder's parent, so the message says where they go.
 */
export function folderDeleteMessage(
  folders: ConnectionFolder[],
  connections: SavedConnection[],
  folderId: string
): string {
  const folder = folders.find((f) => f.id === folderId);
  const name = folder?.name ?? "this folder";
  const subfolders = folders.filter((f) => f.parentId === folderId).length;
  const children = connections.filter((c) => c.folderId === folderId).length;
  const base = `Delete folder “${name}”?`;
  if (subfolders === 0 && children === 0) return base;

  const parts = [
    children > 0 ? count(children, "connection") : null,
    subfolders > 0 ? count(subfolders, "subfolder") : null,
  ].filter((p): p is string => p !== null);
  const parent = folder?.parentId ? folders.find((f) => f.id === folder.parentId) : undefined;
  const target = parent ? `“${parent.name}”` : "the top level";
  return `${base} Its ${parts.join(" and ")} will move to ${target}.`;
}
