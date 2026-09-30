import { StateCreator } from "zustand";

import { toast } from "@/components/ui";
import {
  loadConnections,
  persistConnection,
  removeConnection,
  moveConnectionToFile as apiMoveConnectionToFile,
  saveConnectionToFile as apiSaveConnectionToFile,
  persistFolder,
  removeFolder,
  reorderConnections as persistConnectionOrder,
  reloadExternalConnections as apiReloadExternalConnections,
} from "@/services/storage";
import { newId } from "@/services/transport/ids";
import { currentConnectionsView, persistWithOverlay } from "@/store/connectionsBridge";
import {
  moveConnection,
  orderConnections,
  removeConnection as removeConnectionFold,
  removeFolder as removeFolderFold,
  replaceConnection,
  setFolderExpanded,
  upsertConnection,
  upsertFolder,
} from "@/store/connectionsOverlay";
import { SavedConnection, ConnectionFolder, ConnectionIdChange } from "@/types/connection";
import { TabContent } from "@/types/terminal";
import { frontendLog } from "@/utils/frontendLog";
import { connectionBookmarkScope } from "@/utils/fileBookmarkScope";
import { remapPersistentSessions, remapTabContentConnectionIds } from "@/utils/connectionIdChanges";
import { useFileBookmarksStore } from "@/store/fileBookmarksStore";
import { readConfigBoolean, readConfigString } from "@/utils/connectionConfigFields";

import type { AppState } from "../appStore";
import { errorMessage } from "@/utils/errorMessage";

/**
 * Connection-tree domain slice — a cut of the appStore god-module split
 * (ARCH-001 / FES-011), following the file-browser (#2880), transfers (#2890)
 * and monitoring (#2902) slices.
 *
 * The saved-connection / folder tree is **region-authoritative** (#2401): it
 * lives only in the shared `connections` projection region, read via
 * `useProjectedConnections()` (components) or `currentConnectionsView()`
 * (store-side). `appStore` holds no connections/folders slice. The lifecycle
 * actions below are thin backend-command wrappers around `persistWithOverlay`
 * (#2831): the persist command is the single writer of the region — it writes
 * disk and folds the disk truth (persisted id, dedup rename, external overlay)
 * into the region in one backend step, success or failure — while a
 * client-local optimistic overlay gives instant feedback until the persist
 * settles. A rejected persist therefore leaves the region exactly equal to disk
 * with no compensating write (FES-005).
 *
 * The referential-integrity sweep after a delete ({@link sweepDeletedConnectionRefs}
 * in the factory) reaches other domains — persistent sessions, open tabs, bookmarks —
 * purely through the composed `AppState` via `get()` / `set()`, so it stays local
 * to this slice without importing those domains directly.
 */
export interface ConnectionTreeSlice {
  reloadExternalConnections: () => Promise<void>;
  /** Reload connections from the backend using the versioned reload guard. */
  reloadConnectionsFromBackend: () => void;
  toggleFolder: (folderId: string) => void;
  addConnection: (connection: SavedConnection) => void;
  bulkAddConnections: (connections: SavedConnection[]) => void;
  updateConnection: (connection: SavedConnection) => void;
  deleteConnection: (connectionId: string) => void;
  bulkDeleteConnections: (connectionIds: string[]) => void;
  addFolder: (folder: ConnectionFolder) => void;
  deleteFolder: (folderId: string) => void;
  duplicateConnection: (connectionId: string) => void;
  moveConnectionToFolder: (connectionId: string, folderId: string | null) => void;
  bulkMoveConnectionsToFolder: (connectionIds: string[], folderId: string | null) => void;
  /**
   * Reorder a saved connection among its siblings by moving the connection at
   * `oldIndex` to `newIndex` in the authoritative region connection list. Backs the
   * connection-tree intra-folder drag-reorder (#2594); the new order is persisted to
   * disk so it survives a reload.
   */
  reorderConnections: (oldIndex: number, newIndex: number) => void;
  moveConnectionToFile: (connectionId: string, targetSource: string | null) => Promise<void>;
  /**
   * Save an edit that also changes the connection's storage file (#3590): one
   * backend command writes the edited connection to `connection.sourceFile` and
   * removes it from `currentSource`, so it ends up there exactly once. Resolves
   * to the connection as persisted (its id may change), or `null` when the save
   * failed — the failure is toasted and the region reverted.
   */
  saveConnectionToFile: (
    connection: SavedConnection,
    currentSource: string | null
  ) => Promise<SavedConnection | null>;
  /**
   * Re-point open tabs at their connections' new ids after a rename or move
   * (#3579) — the frontend side of the backend `connection-ids-changed` event —
   * and re-read the workflow list, whose on-connect triggers the backend
   * re-pointed (#3596). See `src/utils/connectionIdChanges.ts` for which
   * references follow.
   */
  followConnectionIdChanges: (changes: readonly ConnectionIdChange[]) => void;
  /**
   * Point an open connection editor's target folder (`connectionEditorMeta.folderId`)
   * at a folder's new id after the folder was renamed, moved or deleted (#3622).
   * No-op for a tab that is not a connection editor.
   */
  retargetConnectionEditorFolder: (tabId: string, folderId: string | null) => void;
}

/**
 * Strip an unsaved / non-persistable password from a connection before persisting:
 * a non-empty password with `savePassword` is left in place so the backend can
 * route it to the credential store; otherwise any password field is cleared so it
 * is never written to the plain config file.
 */
function stripPassword(connection: SavedConnection): SavedConnection {
  const cfg = connection.config.config;
  const password = readConfigString(connection.config, "password");
  const hasNonEmptyPassword = password !== undefined && password.length > 0;
  if (hasNonEmptyPassword && readConfigBoolean(connection.config, "savePassword")) {
    return connection; // Let backend route non-empty password to credential store
  }
  if (cfg.password !== undefined) {
    return {
      ...connection,
      config: {
        ...connection.config,
        config: { ...cfg, password: undefined },
      },
    };
  }
  return connection;
}

export const createConnectionTreeSlice: StateCreator<AppState, [], [], ConnectionTreeSlice> = (
  set,
  get
) => {
  /**
   * Referential-integrity sweep after saved connections are deleted (FES-009).
   *
   * `deleteConnection` / `bulkDeleteConnections` remove the entity from the
   * `connections` region and persist the deletion, but several pieces of state are
   * keyed off the connection id and were left dangling once it was gone: a live
   * persistent/background session (an orphan reconnect target + badge), open tabs
   * still pointing at the removed id, and SSH tunnels that reference it. This
   * sweeps each frontend-owned dependent so a delete leaves no quiet
   * inconsistency behind.
   *
   * **Ordering vs a failed persist.** The persistent-session teardown kills a
   * backend process and is not revertible, so the sweep must run only once the
   * delete is confirmed durable on disk — the callers invoke it from the persist
   * `.then()`, per id, as each id's own persist resolves. A persist that *rejects*
   * (the overlay dropped, the connection still shown from disk) therefore never
   * races an irreversible teardown of a session for a connection that stays.
   *
   * Per dependent:
   * - **persistentSessions** — tear the live session down via the normal
   *   {@link AppState.stopPersistentSession} path (kills the backend process), then
   *   drop the map entry so no orphan remains even if the backend `stopped` event
   *   is never delivered.
   * - **open tabs** — clear the now-dangling `connectionId` /
   *   `persistentConnectionId` from every tab's content (a content-only mutation,
   *   #2562). The tab keeps running from its own captured config snapshot; it just
   *   no longer points at a removed connection (the restore path already tolerates
   *   every referenced connection having been deleted).
   * - **tunnels** — not swept here: the backend cascade (#2850) stops a tunnel
   *   whose SSH connection was deleted and projects it as `missingConnection`
   *   through the `tunnels` region, so every client shows it the same way.
   * - **file-browser bookmarks** — the backend `delete_connection` already pruned
   *   the `connection:<id>` list (#3562); drop it from the UI cache too.
   */
  const sweepDeletedConnectionRefs = (deletedIds: readonly string[]): void => {
    const idSet = new Set(deletedIds);

    // 1. Persistent sessions — tear down live sessions, then drop their entries.
    const staleSessionIds = Object.keys(get().persistentSessions).filter((id) => idSet.has(id));
    for (const connectionId of staleSessionIds) {
      void get().stopPersistentSession(connectionId);
    }
    if (staleSessionIds.length > 0) {
      set((state) => {
        const remaining = { ...state.persistentSessions };
        for (const id of staleSessionIds) delete remaining[id];
        return { persistentSessions: remaining };
      });
    }

    // 2. Open tabs — clear the now-dangling connection references (content-only,
    // #2562), leaving each tab running from its own captured config snapshot.
    set((state) => {
      let changed = false;
      const nextContent: Record<string, TabContent> = { ...state.tabContent };
      for (const [tabId, content] of Object.entries(state.tabContent)) {
        const patch: Partial<TabContent> = {};
        if (content.connectionId != null && idSet.has(content.connectionId)) {
          patch.connectionId = undefined;
        }
        if (content.persistentConnectionId != null && idSet.has(content.persistentConnectionId)) {
          patch.persistentConnectionId = undefined;
        }
        if (Object.keys(patch).length > 0) {
          nextContent[tabId] = { ...content, ...patch };
          changed = true;
        }
      }
      return changed ? { tabContent: nextContent } : {};
    });

    // 3. File-browser bookmarks — mirror the backend prune in the UI cache (#3562).
    const deletedScopes = new Set(deletedIds.map(connectionBookmarkScope));
    useFileBookmarksStore.getState().forgetScopes((scope) => deletedScopes.has(scope));
  };

  return {
    followConnectionIdChanges: (changes) => {
      // Content-only mutation (#2562), like the delete sweep above: the tabs keep
      // running; they just point at the connection's new id.
      // Persistent sessions move with them (#3595): the backend re-keyed its
      // registry before announcing the change, so attach / stop by the new id
      // reach the running session. Both maps move in one update.
      set((state) => {
        const tabContent = remapTabContentConnectionIds(state.tabContent, changes);
        const persistentSessions = remapPersistentSessions(state.persistentSessions, changes);
        return {
          ...(tabContent ? { tabContent } : {}),
          ...(persistentSessions ? { persistentSessions } : {}),
        };
      });
      // The backend re-pointed the saved records before announcing the change
      // (#3596). Workflows have no change event of their own, so re-read them
      // for the on-connect triggers; schedules, tunnels and settings update
      // through their own event / regions.
      if (changes.length > 0) void get().loadWorkflows();
    },

    retargetConnectionEditorFolder: (tabId, folderId) => {
      set((state) => {
        const content = state.tabContent[tabId];
        const meta = content?.connectionEditorMeta;
        if (!meta || meta.folderId === folderId) return {};
        return {
          tabContent: {
            ...state.tabContent,
            [tabId]: { ...content, connectionEditorMeta: { ...meta, folderId } },
          },
        };
      });
    },

    reloadExternalConnections: async () => {
      try {
        // Re-reads the configured external files and folds the refreshed unified
        // view into the authoritative `connections` region server-side (#2394), so
        // every reader updates via the region diff — no frontend slice to splice.
        await apiReloadExternalConnections();
      } catch (err) {
        frontendLog("app_store", `Failed to reload external connections: ${errorMessage(err)}`);
        toast.error(`Failed to reload external connections: ${errorMessage(err)}`, {
          id: "reload-external-connections-error",
        });
      }
    },

    toggleFolder: (folderId) => {
      const existing = currentConnectionsView().folders.find((f) => f.id === folderId);
      if (!existing) return;
      const toggled = { ...existing, isExpanded: !existing.isExpanded };
      // Set-shaped overlay (not a flip), so it stays correct while layered over a
      // base that already carries the persisted value (#2831).
      persistWithOverlay(setFolderExpanded(folderId, toggled.isExpanded), () =>
        persistFolder(toggled)
      ).catch((err) => {
        frontendLog("app_store", `Failed to persist folder toggle: ${errorMessage(err)}`);
        toast.error(`Failed to save folder state: ${errorMessage(err)}`);
      });
    },

    reloadConnectionsFromBackend: () => {
      frontendLog("connection_sync", "focus reload: triggered by external event");
      // Re-reads the unified connection view and re-folds it into the authoritative
      // `connections` region server-side (#2401), so the UI refreshes via the region
      // diff. No frontend slice to set.
      void loadConnections().catch((err) => {
        frontendLog("app_store", `focus reload failed: ${errorMessage(err)}`);
      });
    },

    addConnection: (connection) => {
      // Optimistic overlay, then persist. The persist command recomputes the
      // name-derived id and folds the authoritative view into the region (#2389),
      // echoing the optimistic `conn-<ulid>` id in the region's `savedAs` map, so
      // the preview gives way to the persisted row the moment that fold lands —
      // never shown next to it (#3961). A rejected persist drops the overlay (#2831).
      frontendLog("connection_sync", `addConnection: persisting ${connection.id}`);
      persistWithOverlay(
        upsertConnection(connection),
        () => persistConnection(stripPassword(connection)),
        { previewId: connection.id }
      )
        .then(() => {
          toast.success(`Saved ${connection.name}`);
        })
        .catch((err) => {
          frontendLog("app_store", `Failed to persist new connection: ${errorMessage(err)}`);
          toast.error(`Failed to save ${connection.name}: ${errorMessage(err)}`);
        });
    },

    bulkAddConnections: (newConnections) => {
      if (newConnections.length === 0) return;
      frontendLog(
        "connection_sync",
        `bulkAddConnections: persisting ${newConnections.length} connections`
      );
      // One overlay per item: a partial import failure leaves exactly the rows
      // that reached disk (FES-005, #2831).
      Promise.all(
        newConnections.map((c) =>
          persistWithOverlay(upsertConnection(c), () => persistConnection(stripPassword(c)), {
            previewId: c.id,
          })
        )
      )
        .then(() => {
          toast.success(
            `Imported ${newConnections.length} ${newConnections.length === 1 ? "connection" : "connections"}`
          );
        })
        .catch((err) => {
          frontendLog("app_store", `Failed to persist imported connections: ${errorMessage(err)}`);
          toast.error(`Failed to import connections: ${errorMessage(err)}`);
        });
    },

    updateConnection: (connection) => {
      // Optimistic overlay, then persist. A rename changes the name-derived
      // persisted id; the persist command's fold (#2389) lands it in the region
      // under the new id before the overlay settles, so a connect fired after the
      // save resolves reads the correct id (#875). A rejected persist drops the
      // overlay, leaving the on-disk value (FES-005, #2831).
      frontendLog("connection_sync", `updateConnection: persisting ${connection.id}`);
      persistWithOverlay(replaceConnection(connection), () =>
        persistConnection(stripPassword(connection))
      )
        .then(() => {
          toast.success(`Saved ${connection.name}`);
        })
        .catch((err) => {
          frontendLog("app_store", `Failed to persist connection update: ${errorMessage(err)}`);
          toast.error(`Failed to save ${connection.name}: ${errorMessage(err)}`);
        });
    },

    deleteConnection: (connectionId) => {
      const conn = currentConnectionsView().connections.find((c) => c.id === connectionId);
      frontendLog("connection_sync", `deleteConnection: removing ${connectionId} optimistically`);
      // A rejected on-disk delete drops the overlay: the connection is shown again
      // exactly where disk has it (FES-005, #2831).
      persistWithOverlay(removeConnectionFold(connectionId), () =>
        removeConnection(connectionId, conn?.sourceFile)
      )
        .then(() => {
          frontendLog("connection_sync", `deleteConnection: backend confirmed`);
          // Referential-integrity sweep (FES-009): only now that the delete is
          // durable — so a rejected persist (rolled back per FES-005) never tears
          // down a live session for a connection that is coming back.
          sweepDeletedConnectionRefs([connectionId]);
          toast.success(`Deleted ${conn?.name ?? "connection"}`);
        })
        .catch((err) => {
          frontendLog("app_store", `Failed to persist connection deletion: ${errorMessage(err)}`);
          toast.error(`Failed to delete ${conn?.name ?? "connection"}: ${errorMessage(err)}`);
        });
    },

    bulkDeleteConnections: (connectionIds) => {
      const idSet = new Set(connectionIds);
      const toDelete = currentConnectionsView().connections.filter((c) => idSet.has(c.id));
      frontendLog(
        "connection_sync",
        `bulkDeleteConnections: removing ${connectionIds.join(", ")} optimistically`
      );
      // One overlay per item: a partial failure shows exactly the rows still on
      // disk (FES-005, #2831).
      Promise.all(
        toDelete.map((c) => {
          const persistDone = persistWithOverlay(removeConnectionFold(c.id), () =>
            removeConnection(c.id, c.sourceFile)
          );
          // Sweep per id on its OWN durable success (FES-009): a sibling whose
          // persist rejected is still on disk (FES-005) and must not be swept, so
          // this cannot gate on the whole batch resolving. Kept as a side-effect
          // branch (the unmodified promise is what the batch awaits) so the
          // batch's own rejection timing / error toast is unchanged.
          void persistDone.then(
            () => sweepDeletedConnectionRefs([c.id]),
            () => {}
          );
          return persistDone;
        })
      )
        .then(() => {
          frontendLog("connection_sync", `bulkDeleteConnections: backend confirmed`);
          toast.success(
            `Deleted ${toDelete.length} ${toDelete.length === 1 ? "connection" : "connections"}`
          );
        })
        .catch((err) => {
          frontendLog(
            "app_store",
            `Failed to persist bulk connection deletion: ${errorMessage(err)}`
          );
          toast.error(`Failed to delete connections: ${errorMessage(err)}`);
        });
    },

    addFolder: (folder) => {
      frontendLog("connection_sync", `addFolder: persisting ${folder.id}`);
      persistWithOverlay(upsertFolder(folder), () => persistFolder(folder)).catch((err) => {
        frontendLog("app_store", `Failed to persist new folder: ${errorMessage(err)}`);
        toast.error(`Failed to create folder ${folder.name}: ${errorMessage(err)}`);
      });
    },

    deleteFolder: (folderId) => {
      // The overlay re-homes the folder's children the way the backend does, and
      // the `removeFolder` command folds the authoritative result (recomputed
      // child ids included) into the region (#2389, #2831).
      frontendLog("connection_sync", `deleteFolder: removing ${folderId}`);
      persistWithOverlay(removeFolderFold(folderId), () => removeFolder(folderId)).catch((err) => {
        frontendLog("app_store", `Failed to persist folder deletion: ${errorMessage(err)}`);
        toast.error(`Failed to delete folder: ${errorMessage(err)}`);
      });
    },

    duplicateConnection: (connectionId) => {
      const original = currentConnectionsView().connections.find((c) => c.id === connectionId);
      if (!original) return;
      const duplicate: SavedConnection = {
        ...original,
        id: newId("conn"),
        name: `Copy of ${original.name}`,
      };
      frontendLog("connection_sync", `duplicateConnection: persisting copy of ${connectionId}`);
      // A rejected persist drops the overlay, so a never-persisted duplicate
      // disappears (FES-005, #2831).
      persistWithOverlay(
        upsertConnection(duplicate),
        () => persistConnection(stripPassword(duplicate)),
        { previewId: duplicate.id }
      ).catch((err) => {
        frontendLog("app_store", `Failed to persist duplicated connection: ${errorMessage(err)}`);
        toast.error(`Failed to duplicate ${original.name}: ${errorMessage(err)}`);
      });
    },

    moveConnectionToFile: async (connectionId, targetSource) => {
      const conn = currentConnectionsView().connections.find((c) => c.id === connectionId);
      if (!conn) return;
      const currentSource = conn.sourceFile ?? null;
      if (currentSource === targetSource) return;
      try {
        // The move command relocates the entry between config files and folds the
        // refreshed unified view into the region (#2394); the overlay shows the
        // new file at once, and the promise settles once the region caught up.
        await persistWithOverlay(replaceConnection({ ...conn, sourceFile: targetSource }), () =>
          apiMoveConnectionToFile(connectionId, currentSource, targetSource)
        );
      } catch (err) {
        frontendLog("app_store", `Failed to move connection to file: ${errorMessage(err)}`);
        toast.error(`Failed to move ${conn.name}: ${errorMessage(err)}`);
      }
    },

    saveConnectionToFile: async (connection, currentSource) => {
      frontendLog(
        "connection_sync",
        `saveConnectionToFile: persisting ${connection.id} from ${currentSource ?? "main"}`
      );
      try {
        // The command folds the refreshed view into the region (#2394) before the
        // overlay settles, so the region holds `saved` when this resolves.
        const saved = await persistWithOverlay(replaceConnection(connection), () =>
          apiSaveConnectionToFile(stripPassword(connection), currentSource)
        );
        toast.success(`Saved ${saved.name}`);
        return saved;
      } catch (err) {
        frontendLog("app_store", `Failed to save connection to file: ${errorMessage(err)}`);
        toast.error(`Failed to save ${connection.name}: ${errorMessage(err)}`);
        return null;
      }
    },

    moveConnectionToFolder: (connectionId, folderId) => {
      const existing = currentConnectionsView().connections.find((c) => c.id === connectionId);
      if (!existing) return;
      // Optimistic overlay, then persist; the persist command folds any dedup
      // rename (e.g. moving a connection into a folder with a same-named sibling)
      // into the region (#2389, #2831).
      const moved = { ...existing, folderId };
      frontendLog("connection_sync", `moveConnectionToFolder: persisting ${connectionId}`);
      persistWithOverlay(moveConnection(connectionId, folderId), () =>
        persistConnection(stripPassword(moved))
      ).catch((err) => {
        frontendLog("app_store", `Failed to persist connection move: ${errorMessage(err)}`);
        toast.error(`Failed to move ${moved.name}: ${errorMessage(err)}`);
      });
    },

    bulkMoveConnectionsToFolder: (connectionIds, folderId) => {
      const idSet = new Set(connectionIds);

      // One overlay per item, each settled by its own persist (#2389, #2831).
      const moved = currentConnectionsView()
        .connections.filter((c) => idSet.has(c.id))
        .map((c) => ({ ...c, folderId }));
      frontendLog(
        "connection_sync",
        `bulkMoveConnectionsToFolder: persisting ${moved.length} connections`
      );
      Promise.all(
        moved.map((conn) =>
          persistWithOverlay(moveConnection(conn.id, folderId), () =>
            persistConnection(stripPassword(conn))
          )
        )
      ).catch((err) => {
        frontendLog("app_store", `Failed to persist bulk connection move: ${errorMessage(err)}`);
        toast.error(`Failed to move connections: ${errorMessage(err)}`);
      });
    },

    reorderConnections: (oldIndex, newIndex) => {
      // Compute the new id order from the effective region view, show it at once
      // through the overlay, then persist the new array
      // order to disk so an intra-folder reorder survives a reload (#2594). Twin of
      // `reorderRemoteAgents`.
      const conns = [...currentConnectionsView().connections];
      if (
        oldIndex < 0 ||
        newIndex < 0 ||
        oldIndex >= conns.length ||
        newIndex >= conns.length ||
        oldIndex === newIndex
      ) {
        return;
      }
      const [moved] = conns.splice(oldIndex, 1);
      conns.splice(newIndex, 0, moved);
      const connectionIds = conns.map((c) => c.id);
      // Set-shaped (an explicit id order, not an index move), so it stays correct
      // over a base that already carries the persisted order (#2831).
      persistWithOverlay(orderConnections(connectionIds), () =>
        persistConnectionOrder(connectionIds)
      ).catch((err) => {
        frontendLog("app_store", `Failed to persist connection reorder: ${errorMessage(err)}`);
        toast.error(`Failed to save connection order: ${errorMessage(err)}`);
      });
    },
  };
};
