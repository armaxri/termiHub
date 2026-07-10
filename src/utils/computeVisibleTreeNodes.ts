import { SavedConnection, ConnectionFolder } from "@/types/connection";
import { ConnectionTreeFilter } from "./connectionSearch";

/**
 * A single rendered row of the connection tree, flattened into visual order.
 * Drives roving-tabindex keyboard navigation: the array index is the row's
 * position, `depth` its indent level, and `parentId` the row to jump to on
 * ArrowLeft.
 */
export interface VisibleTreeNode {
  id: string;
  kind: "folder" | "connection";
  depth: number;
  /** Folders: effective expansion state. Connections: always `false`. */
  isExpanded: boolean;
  /** Folders: whether any child folder/connection is currently rendered. */
  hasChildren: boolean;
  /** Folder's `parentId`, or a connection's `folderId` (`null` at the root). */
  parentId: string | null;
  /** Present for connection rows only. */
  connection?: SavedConnection;
}

/**
 * Flatten the connection tree into the exact list of rows that are rendered,
 * in top-to-bottom visual order.
 *
 * When `filter` is provided (an active search), only matching connections and
 * their ancestor folders are included, and those folders are treated as
 * expanded regardless of stored state. When `filter` is `null`, the full tree
 * is walked honoring each folder's `isExpanded`.
 */
export function computeVisibleTreeNodes(
  folders: ConnectionFolder[],
  connections: SavedConnection[],
  filter: ConnectionTreeFilter | null
): VisibleTreeNode[] {
  const nodes: VisibleTreeNode[] = [];

  const isFolderRendered = (folder: ConnectionFolder) =>
    filter ? filter.visibleFolderIds.has(folder.id) : true;
  const isFolderExpanded = (folder: ConnectionFolder) => (filter ? true : folder.isExpanded);
  const isConnRendered = (conn: SavedConnection) =>
    filter ? filter.matchingConnectionIds.has(conn.id) : true;

  const childFolders = (parentId: string | null) =>
    folders.filter((f) => f.parentId === parentId && isFolderRendered(f));
  const folderConnections = (folderId: string | null) =>
    connections.filter((c) => c.folderId === folderId && isConnRendered(c));

  function pushFolder(folder: ConnectionFolder, depth: number): void {
    const kids = childFolders(folder.id);
    const conns = folderConnections(folder.id);
    const expanded = isFolderExpanded(folder);
    nodes.push({
      id: folder.id,
      kind: "folder",
      depth,
      isExpanded: expanded,
      hasChildren: kids.length + conns.length > 0,
      parentId: folder.parentId,
    });
    if (!expanded) return;
    kids.forEach((k) => pushFolder(k, depth + 1));
    conns.forEach((c) =>
      nodes.push({
        id: c.id,
        kind: "connection",
        depth: depth + 1,
        isExpanded: false,
        hasChildren: false,
        parentId: folder.id,
        connection: c,
      })
    );
  }

  childFolders(null).forEach((f) => pushFolder(f, 0));
  folderConnections(null).forEach((c) =>
    nodes.push({
      id: c.id,
      kind: "connection",
      depth: 0,
      isExpanded: false,
      hasChildren: false,
      parentId: null,
      connection: c,
    })
  );

  return nodes;
}
