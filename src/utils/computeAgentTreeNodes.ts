import { AgentDefinitionInfo, AgentFolderInfo, AgentSessionInfo } from "@/services/api";
import { AgentTreeFilter } from "./agentTreeSearch";

/**
 * A single rendered row of a remote agent's tree, flattened into visual order.
 * Drives roving-tabindex keyboard navigation: the array index is the row's
 * position, `depth` its indent level, and `parentId` the row to jump to on
 * ArrowLeft.
 *
 * Sibling of {@link import("./computeVisibleTreeNodes").VisibleTreeNode} for the
 * agent domain, which additionally carries live sessions as leaf rows.
 */
export interface AgentVisibleNode {
  /** Session `sessionId`, folder `id`, or definition `id`. */
  id: string;
  kind: "session" | "folder" | "definition";
  depth: number;
  /** Folders: effective expansion state. Sessions/definitions: always `false`. */
  isExpanded: boolean;
  /** Folders: whether any child folder/definition is currently rendered. */
  hasChildren: boolean;
  /** Folder's `parentId` or definition's `folderId` (`null` at the root; sessions are always root leaves). */
  parentId: string | null;
  /** Present for session rows only. */
  session?: AgentSessionInfo;
  /** Present for definition rows only. */
  definition?: AgentDefinitionInfo;
}

/** Normalize a folder/definition parent reference (`undefined` → `null`). */
function parentOf(value: string | null | undefined): string | null {
  return value ?? null;
}

/**
 * Flatten a remote agent's tree into the exact list of interactive rows that
 * are rendered, in top-to-bottom visual order: live sessions first, then the
 * saved-connection folder tree, then root-level definitions.
 *
 * When `filter` is provided (an active search), only matching definitions and
 * their ancestor folders are included, and those folders are treated as
 * expanded regardless of stored state. Sessions are live connections rather
 * than saved entries, so they are not affected by the filter. When `filter` is
 * `null`, the full tree is walked honoring each folder's `isExpanded`.
 *
 * @param baseDepth - Indent level of the root rows (the agent header sits above
 *   the tree, so root rows start at depth 1).
 */
export function computeAgentTreeNodes(
  sessions: AgentSessionInfo[],
  folders: AgentFolderInfo[],
  definitions: AgentDefinitionInfo[],
  filter: AgentTreeFilter | null,
  baseDepth = 1
): AgentVisibleNode[] {
  const nodes: AgentVisibleNode[] = [];

  // Live sessions render first as root leaves; the search filter only narrows
  // saved definitions/folders, so sessions are always included.
  for (const session of sessions) {
    nodes.push({
      id: session.sessionId,
      kind: "session",
      depth: baseDepth,
      isExpanded: false,
      hasChildren: false,
      parentId: null,
      session,
    });
  }

  const isFolderRendered = (folder: AgentFolderInfo) =>
    filter ? filter.visibleFolderIds.has(folder.id) : true;
  const isFolderExpanded = (folder: AgentFolderInfo) => (filter ? true : folder.isExpanded);
  const isDefRendered = (def: AgentDefinitionInfo) =>
    filter ? filter.matchingDefinitionIds.has(def.id) : true;

  const childFolders = (parentId: string | null) =>
    folders.filter((f) => parentOf(f.parentId) === parentId && isFolderRendered(f));
  const folderDefinitions = (folderId: string | null) =>
    definitions.filter((d) => parentOf(d.folderId) === folderId && isDefRendered(d));

  function pushFolder(folder: AgentFolderInfo, depth: number): void {
    const kids = childFolders(folder.id);
    const defs = folderDefinitions(folder.id);
    const expanded = isFolderExpanded(folder);
    nodes.push({
      id: folder.id,
      kind: "folder",
      depth,
      isExpanded: expanded,
      hasChildren: kids.length + defs.length > 0,
      parentId: parentOf(folder.parentId),
    });
    if (!expanded) return;
    kids.forEach((k) => pushFolder(k, depth + 1));
    defs.forEach((d) =>
      nodes.push({
        id: d.id,
        kind: "definition",
        depth: depth + 1,
        isExpanded: false,
        hasChildren: false,
        parentId: folder.id,
        definition: d,
      })
    );
  }

  childFolders(null).forEach((f) => pushFolder(f, baseDepth));
  folderDefinitions(null).forEach((d) =>
    nodes.push({
      id: d.id,
      kind: "definition",
      depth: baseDepth,
      isExpanded: false,
      hasChildren: false,
      parentId: null,
      definition: d,
    })
  );

  return nodes;
}
