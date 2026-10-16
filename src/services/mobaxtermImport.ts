/**
 * Helpers for the MobaXterm import flow (#4850).
 *
 * The backend command `preview_mobaxterm_import` returns every saved MobaXterm
 * session as a {@link MobaxtermSession} — importable ones carry a termiHub
 * connection type plus settings, skipped ones a reason. These pure helpers turn
 * the user's selection into the folders and saved connections to persist,
 * recreating MobaXterm's folder tree under a chosen target folder. Kept side
 * effect free so the mapping and collision handling are unit-testable.
 */

import type { ConnectionFolder, MobaxtermSession, SavedConnection } from "@/types/connection";
import { uniqueConnectionName } from "@/services/sshConfigImport";

/** The folders and connections an import creates, parents before children. */
export interface MobaxtermImportPlan {
  folders: ConnectionFolder[];
  connections: SavedConnection[];
}

/** Whether a preview session can be imported (it has a type and settings). */
export function isImportable(session: MobaxtermSession): boolean {
  return Boolean(session.connectionType && session.settings && !session.skipReason);
}

/**
 * The backend's path-based folder id for `name` under `parentId` — mirrors
 * `compute_folder_id` in `src-tauri/src/connection/tree.rs` (`%` and `/` in the
 * name are percent-encoded, levels joined by `/`). Using the same id the store
 * derives on reload keeps connections attached to a freshly created folder.
 */
export function folderPathId(parentId: string | null, name: string): string {
  const encoded = name.replace(/%/g, "%25").replace(/\//g, "%2F");
  return parentId ? `${parentId}/${encoded}` : encoded;
}

/**
 * Build the folders and connections for the selected sessions, placed under
 * `targetFolderId` (`null` = root) with MobaXterm's folder path recreated
 * below it. Existing folders with the same name and parent are reused rather
 * than duplicated. Connection names are made unique within their folder
 * (` (2)`, ` (3)`, … — the same rule as the `~/.ssh/config` import), against
 * both what is already there and earlier sessions of the same import, so
 * MobaXterm's duplicate names never collide.
 */
export function buildMobaxtermImportPlan(
  sessions: MobaxtermSession[],
  targetFolderId: string | null,
  existingFolders: ConnectionFolder[],
  existingConnections: SavedConnection[]
): MobaxtermImportPlan {
  const allFolders = [...existingFolders];
  const newFolders: ConnectionFolder[] = [];
  const takenByFolder = new Map<string | null, Set<string>>();

  const takenIn = (folderId: string | null): Set<string> => {
    let taken = takenByFolder.get(folderId);
    if (!taken) {
      taken = new Set(
        existingConnections.filter((c) => (c.folderId ?? null) === folderId).map((c) => c.name)
      );
      takenByFolder.set(folderId, taken);
    }
    return taken;
  };

  const resolveFolder = (path: string[]): string | null => {
    let parent = targetFolderId;
    for (const level of path) {
      const found = allFolders.find((f) => (f.parentId ?? null) === parent && f.name === level);
      if (found) {
        parent = found.id;
        continue;
      }
      const folder: ConnectionFolder = {
        id: folderPathId(parent, level),
        name: level,
        parentId: parent,
        isExpanded: true,
      };
      allFolders.push(folder);
      newFolders.push(folder);
      parent = folder.id;
    }
    return parent;
  };

  const now = Date.now();
  const connections = sessions.filter(isImportable).map((session, i) => {
    const folderId = resolveFolder(session.folderPath);
    const taken = takenIn(folderId);
    const name = uniqueConnectionName(session.name, taken);
    taken.add(name);
    return {
      id: `conn-${now}-${i}`,
      name,
      config: {
        type: session.connectionType as string,
        config: { ...(session.settings as Record<string, unknown>) },
      },
      folderId,
    };
  });

  return { folders: newFolders, connections };
}

/** `Lab / Switches`, or "" for a session at MobaXterm's root. */
export function folderLabel(path: string[]): string {
  return path.join(" / ");
}
