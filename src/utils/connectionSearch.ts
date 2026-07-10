import { SavedConnection, ConnectionFolder } from "@/types/connection";

/**
 * Result of filtering a connection tree by a search query.
 *
 * When a query is active, only connections whose name or host matches are kept,
 * along with every ancestor folder needed to reveal them. Folders in
 * {@link ConnectionTreeFilter.visibleFolderIds} are always shown expanded (the
 * "auto-expand matches" behaviour), regardless of their stored `isExpanded`.
 */
export interface ConnectionTreeFilter {
  /** Normalized (trimmed, lower-cased) query the filter was built from. */
  query: string;
  /** Connections that match the query and should be rendered. */
  matchingConnectionIds: Set<string>;
  /** Folders that contain a match (transitively) and should be rendered + expanded. */
  visibleFolderIds: Set<string>;
  /** First matching connection in visual (tree) order — the "top hit". */
  topHitId: string | null;
}

/** Extract the connection's host, if its config declares one. */
function connectionHost(connection: SavedConnection): string {
  const cfg = connection.config.config as unknown as Record<string, unknown>;
  return typeof cfg.host === "string" ? cfg.host : "";
}

/**
 * Whether a connection matches the (already normalized) query by name or host.
 * An empty query matches everything.
 */
export function connectionMatchesQuery(
  connection: SavedConnection,
  normalizedQuery: string
): boolean {
  if (!normalizedQuery) return true;
  if (connection.name.toLowerCase().includes(normalizedQuery)) return true;
  if (connectionHost(connection).toLowerCase().includes(normalizedQuery)) return true;
  return false;
}

/**
 * Build a {@link ConnectionTreeFilter} for the given query, or `null` when the
 * query is empty (meaning: no filtering, render the full tree with stored
 * expansion state).
 *
 * Visual order mirrors the tree render order (child folders before sibling
 * connections at each level; root folders before root connections), so the
 * `topHitId` is the first match a user sees top-to-bottom.
 */
export function filterConnectionTree(
  query: string,
  folders: ConnectionFolder[],
  connections: SavedConnection[]
): ConnectionTreeFilter | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return null;

  const matchingConnectionIds = new Set<string>();
  for (const c of connections) {
    if (connectionMatchesQuery(c, normalizedQuery)) matchingConnectionIds.add(c.id);
  }

  const childFolders = (parentId: string | null) => folders.filter((f) => f.parentId === parentId);
  const folderConnections = (folderId: string | null) =>
    connections.filter((c) => c.folderId === folderId);

  // Post-order pass: a folder is visible when any of its descendant connections match.
  const visibleFolderIds = new Set<string>();
  function markVisible(folder: ConnectionFolder): boolean {
    let hasMatch = folderConnections(folder.id).some((c) => matchingConnectionIds.has(c.id));
    for (const child of childFolders(folder.id)) {
      if (markVisible(child)) hasMatch = true;
    }
    if (hasMatch) visibleFolderIds.add(folder.id);
    return hasMatch;
  }
  childFolders(null).forEach(markVisible);

  // Pre-order pass over the visible tree to find the first match (top hit).
  let topHitId: string | null = null;
  function findTopHit(folder: ConnectionFolder): void {
    if (topHitId !== null || !visibleFolderIds.has(folder.id)) return;
    for (const child of childFolders(folder.id)) findTopHit(child);
    if (topHitId !== null) return;
    for (const c of folderConnections(folder.id)) {
      if (matchingConnectionIds.has(c.id)) {
        topHitId = c.id;
        return;
      }
    }
  }
  childFolders(null).forEach(findTopHit);
  if (topHitId === null) {
    for (const c of folderConnections(null)) {
      if (matchingConnectionIds.has(c.id)) {
        topHitId = c.id;
        break;
      }
    }
  }

  return { query: normalizedQuery, matchingConnectionIds, visibleFolderIds, topHitId };
}
