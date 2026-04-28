interface FlattenableFolder {
  id: string;
  parentId: string | null | undefined;
  isExpanded: boolean;
}

interface FlattenableItem {
  id: string;
  folderId: string | null | undefined;
}

/**
 * Returns item IDs in visual tree order (depth-first, folders before sibling items),
 * considering only expanded folders. Used for Shift+Click range selection.
 */
export function computeFlatVisibleIds<F extends FlattenableFolder, I extends FlattenableItem>(
  rootFolders: F[],
  rootItems: I[],
  allFolders: F[],
  allItems: I[]
): string[] {
  const ids: string[] = [];

  function traverseFolder(folder: F) {
    if (!folder.isExpanded) return;
    allFolders.filter((f) => f.parentId === folder.id).forEach(traverseFolder);
    allItems.filter((item) => item.folderId === folder.id).forEach((item) => ids.push(item.id));
  }

  rootFolders.forEach(traverseFolder);
  rootItems.forEach((item) => ids.push(item.id));

  return ids;
}
