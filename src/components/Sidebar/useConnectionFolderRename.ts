import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";
import { folderRenameError } from "@/utils/folderRename";
import type { InlineFolderCancelReason } from "./InlineFolderInput";

/** How long a finished rename keeps putting focus back on its row, in ms. */
const RENAME_FOCUS_WINDOW_MS = 2000;

/** Inline folder rename in the Connections tree (#5233), threaded to every folder row. */
export interface ConnectionFolderRenameActions {
  /** The folder whose row currently shows the rename input, or `null`. */
  renamingId: string | null;
  /** Start renaming a folder (the menu's Rename item, or F2 on its row). */
  start: (folderId: string) => void;
  /** Reject an empty name or one a sibling folder or connection already uses. */
  validate: (folder: ConnectionFolder, name: string) => string | null;
  /** Save the new name and put focus back on the folder's row. */
  commit: (folder: ConnectionFolder, name: string) => void;
  /** Leave the input; focus returns to the row unless it left by blur. */
  cancel: (folder: ConnectionFolder, reason: InlineFolderCancelReason) => void;
}

interface Options {
  folders: ConnectionFolder[];
  /** Every saved connection — a folder may not take a sibling connection's name. */
  connections: SavedConnection[];
  updateFolder: (folder: ConnectionFolder) => void;
  /** Flattened-list index of a row by id (`-1` when not visible). */
  getNodeIndex: (id: string) => number;
  /** Make a row the roving-tabindex row and focus it. */
  focusRow: (index: number) => void;
}

/** The row focus should land on once the rename input is gone. */
interface FocusIntent {
  oldId: string;
  parentId: string | null;
  name: string;
}

/**
 * State and actions for renaming a connection folder in place (#5233).
 *
 * A desktop folder's id is its path (`Parent/Name`), so the backend re-ids a
 * renamed folder — and everything under it, credentials and open references
 * included (`ConnectionManager::save_folder`). The row therefore unmounts and
 * re-mounts under the new id once the store catches up. To keep keyboard focus
 * on it, the folder is followed by its parent and new name, and whenever a
 * folder change leaves focus on `<body>` it goes back to that row. The watch
 * runs on renders only (no polling) and ends once the re-keyed row has focus,
 * focus moves elsewhere, or after {@link RENAME_FOCUS_WINDOW_MS}.
 */
export function useConnectionFolderRename({
  folders,
  connections,
  updateFolder,
  getNodeIndex,
  focusRow,
}: Options): ConnectionFolderRenameActions {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Mirrors `renamingId` synchronously, so a blur racing a commit is ignored.
  const renamingRef = useRef<string | null>(null);
  const [focusIntent, setFocusIntent] = useState<FocusIntent | null>(null);

  const finish = useCallback((intent: FocusIntent | null) => {
    renamingRef.current = null;
    setRenamingId(null);
    setFocusIntent(intent);
  }, []);

  const start = useCallback((folderId: string) => {
    renamingRef.current = folderId;
    setFocusIntent(null);
    setRenamingId(folderId);
  }, []);

  const validate = useCallback(
    (folder: ConnectionFolder, name: string) =>
      folderRenameError(name, [
        ...folders
          .filter((f) => f.parentId === folder.parentId && f.id !== folder.id)
          .map((f) => f.name),
        ...connections.filter((c) => c.folderId === folder.parentId).map((c) => c.name),
      ]),
    [folders, connections]
  );

  const commit = useCallback(
    (folder: ConnectionFolder, name: string) => {
      if (renamingRef.current !== folder.id) return;
      finish({ oldId: folder.id, parentId: folder.parentId, name });
      if (name !== folder.name) updateFolder({ ...folder, name });
    },
    [finish, updateFolder]
  );

  const cancel = useCallback(
    (folder: ConnectionFolder, reason: InlineFolderCancelReason) => {
      if (renamingRef.current !== folder.id) return;
      finish(
        reason === "blur"
          ? null
          : { oldId: folder.id, parentId: folder.parentId, name: folder.name }
      );
    },
    [finish]
  );

  // End the focus watch after a short window, so a stale intent never grabs
  // focus from a later, unrelated change.
  useEffect(() => {
    if (!focusIntent) return;
    const timer = setTimeout(() => setFocusIntent(null), RENAME_FOCUS_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [focusIntent]);

  useEffect(() => {
    if (!focusIntent || renamingId) return;
    const target =
      folders.find((f) => f.parentId === focusIntent.parentId && f.name === focusIntent.name) ??
      folders.find((f) => f.id === focusIntent.oldId);
    if (!target) return;
    const active = document.activeElement;
    const activeTestId = active?.getAttribute("data-testid");
    const onTarget = activeTestId === `folder-toggle-${target.id}`;
    // While the store briefly shows both rows (the region already has the new
    // id, the optimistic overlay still the old one), focus is on the old row:
    // move it to the re-keyed one rather than dropping the watch (#5232).
    const onOldRow = activeTestId === `folder-toggle-${focusIntent.oldId}`;
    if (!active || active === document.body || (onOldRow && !onTarget)) {
      const index = getNodeIndex(target.id);
      if (index >= 0) focusRow(index);
    } else if (!onTarget) {
      setFocusIntent(null);
    } else if (target.id !== focusIntent.oldId) {
      setFocusIntent(null);
    }
  }, [focusIntent, renamingId, folders, getNodeIndex, focusRow]);

  return useMemo(
    () => ({ renamingId, start, validate, commit, cancel }),
    [renamingId, start, validate, commit, cancel]
  );
}
