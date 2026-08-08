import { AgentDefinitionInfo, AgentFolderInfo } from "@/services/api";

/**
 * Result of filtering a remote-agent connection tree by a search query.
 *
 * Mirrors {@link import("./connectionSearch").ConnectionTreeFilter} for the
 * agent domain: when a query is active, only definitions whose name matches are
 * kept, along with every ancestor folder needed to reveal them. Folders in
 * {@link AgentTreeFilter.visibleFolderIds} are always shown expanded (the
 * "auto-expand matches" behaviour), regardless of their stored `isExpanded`.
 */
export interface AgentTreeFilter {
  /** Normalized (trimmed, lower-cased) query the filter was built from. */
  query: string;
  /** Saved definitions that match the query and should be rendered. */
  matchingDefinitionIds: Set<string>;
  /** Folders that contain a match (transitively) and should be rendered + expanded. */
  visibleFolderIds: Set<string>;
}

/** Normalize a folder/definition parent reference (`undefined` → `null`). */
function parentOf(value: string | null | undefined): string | null {
  return value ?? null;
}

/**
 * Whether a remote agent matches the (already normalized) query by its own
 * name/label (e.g. `dev0` matching "Dev Agent (dev0)"). Case-insensitive
 * substring; an empty query matches everything. Used to surface an agent in the
 * Remote Agents search even when none of its saved connections match (#2485).
 */
export function agentNameMatchesQuery(agentName: string, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return agentName.toLowerCase().includes(normalizedQuery);
}

/**
 * Whether an agent definition matches the (already normalized) query by name.
 * An empty query matches everything.
 */
export function agentDefinitionMatchesQuery(
  definition: AgentDefinitionInfo,
  normalizedQuery: string
): boolean {
  if (!normalizedQuery) return true;
  return definition.name.toLowerCase().includes(normalizedQuery);
}

/**
 * Build an {@link AgentTreeFilter} for the given query, or `null` when the query
 * is empty (meaning: no filtering, render the full tree with stored expansion
 * state).
 */
export function filterAgentTree(
  query: string,
  folders: AgentFolderInfo[],
  definitions: AgentDefinitionInfo[]
): AgentTreeFilter | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return null;

  const matchingDefinitionIds = new Set<string>();
  for (const d of definitions) {
    if (agentDefinitionMatchesQuery(d, normalizedQuery)) matchingDefinitionIds.add(d.id);
  }

  const childFolders = (parentId: string | null) =>
    folders.filter((f) => parentOf(f.parentId) === parentId);
  const folderDefinitions = (folderId: string | null) =>
    definitions.filter((d) => parentOf(d.folderId) === folderId);

  // Post-order pass: a folder is visible when any descendant definition matches.
  const visibleFolderIds = new Set<string>();
  function markVisible(folder: AgentFolderInfo): boolean {
    let hasMatch = folderDefinitions(folder.id).some((d) => matchingDefinitionIds.has(d.id));
    for (const child of childFolders(folder.id)) {
      if (markVisible(child)) hasMatch = true;
    }
    if (hasMatch) visibleFolderIds.add(folder.id);
    return hasMatch;
  }
  childFolders(null).forEach(markVisible);

  return { query: normalizedQuery, matchingDefinitionIds, visibleFolderIds };
}
