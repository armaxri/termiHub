import { StateCreator } from "zustand";

import { toast } from "@/components/ui";
import {
  loadConnections,
  persistConnection,
  removeConnection,
  moveConnectionToFile as apiMoveConnectionToFile,
  persistFolder,
  removeFolder,
  reorderConnections as persistConnectionOrder,
  reloadExternalConnections as apiReloadExternalConnections,
} from "@/services/storage";
import { newId } from "@/services/transport/ids";
import {
  currentConnectionsView,
  mirrorConnectionIntent,
  persistConnectionMutation,
} from "@/store/connectionsBridge";
import { SavedConnection, ConnectionFolder } from "@/types/connection";
import { TabContent } from "@/types/terminal";
import { frontendLog } from "@/utils/frontendLog";
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
 * actions below are thin backend-command wrappers — each dispatches the
 * optimistic `connection.*` intent and calls the persist command; the command's
 * server-side fold (`fold_connections_from_manager`, #2389 / #2394) reconciles
 * the authoritative truth (persisted id, dedup rename, external overlay) back
 * into the region, so there is no frontend reload / id-reconcile pass. A rejected
 * persist reverts the region so a never-persisted / unsaved row does not linger
 * until reload (FES-005).
 *
 * The referential-integrity sweep after a delete ({@link sweepDeletedConnectionRefs}
 * in the factory) reaches other domains — persistent sessions, open tabs, tunnels —
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
   * sweeps each dependent so a delete leaves no quiet inconsistency behind.
   *
   * **Ordering vs the FES-005 rollback.** The persistent-session teardown kills a
   * backend process and is not revertible, so the sweep must run only once the
   * delete is confirmed durable on disk — the callers invoke it from the persist
   * `.then()`, per id, as each id's own persist resolves. A persist that *rejects*
   * (region rolled back, the connection re-added) therefore never races an
   * irreversible teardown of a session for a connection that is coming back.
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
   * - **tunnels** — the tunnels region is backend-authoritative (this slice holds
   *   only a projected cache), so the frontend cannot repoint or remove a tunnel
   *   here; it surfaces the dangling reference (the tunnel already renders as
   *   "Unknown") so the inconsistency is not silent. The authoritative cascade is
   *   backend-owned (tracked as a follow-up).
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

    // 3. Tunnels — surface any that now reference a deleted SSH connection. The
    // tunnels region is backend-authoritative, so we cannot repoint/remove here;
    // the tunnel stays (rendered "Unknown") and the user is told, rather than the
    // reference silently rotting. The authoritative cascade is a backend follow-up.
    const orphanedTunnels = get().tunnels.filter((t) => idSet.has(t.sshConnectionId));
    if (orphanedTunnels.length > 0) {
      const noun = orphanedTunnels.length === 1 ? "tunnel" : "tunnels";
      toast.info(`${orphanedTunnels.length} ${noun} now reference a deleted SSH connection`, {
        description: orphanedTunnels.map((t) => t.name).join(", "),
      });
    }
  };

  return {
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
      // Optimistic flip in the region, then persist (the persist command folds the
      // authoritative view back, #2389).
      mirrorConnectionIntent("connection.toggleFolder", { folderId });
      persistFolder(toggled).catch((err) => {
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
      // Optimistic add in the region, then persist. The persist command recomputes
      // the name-derived id and folds the authoritative view back server-side
      // (#2389), so the optimistic `conn-<ts>` row is reconciled to the persisted id
      // without a frontend id-reconcile / reload pass. A rejected persist reverts the
      // region so a never-persisted row does not linger until reload (FES-005).
      frontendLog("connection_sync", `addConnection: persisting ${connection.id}`);
      persistConnectionMutation(
        { kind: "connection.add", payload: { connection } },
        () => persistConnection(stripPassword(connection)),
        { kind: "connection.remove", payload: { connectionId: connection.id } }
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
      // Per-item atomicity (FES-005): each add reverts its own region entry if its
      // persist rejects, so a partial import failure leaves only the successfully
      // persisted rows in the region rather than every optimistic row.
      Promise.all(
        newConnections.map((c) =>
          persistConnectionMutation(
            { kind: "connection.add", payload: { connection: c } },
            () => persistConnection(stripPassword(c)),
            { kind: "connection.remove", payload: { connectionId: c.id } }
          )
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
      // Optimistic edit in the region, then persist. A rename changes the
      // name-derived persisted id; the persist command's server-side fold (#2389)
      // reconciles it back into the region under the new id, so a connect fired
      // after the save resolves reads the correct id (#875) without a frontend pass.
      // On a rejected persist, revert the region to the prior value so an unsaved
      // edit does not linger until reload (FES-005).
      const prior = currentConnectionsView().connections.find((c) => c.id === connection.id);
      frontendLog("connection_sync", `updateConnection: persisting ${connection.id}`);
      persistConnectionMutation(
        { kind: "connection.update", payload: { connection } },
        () => persistConnection(stripPassword(connection)),
        prior
          ? { kind: "connection.update", payload: { connection: prior } }
          : { kind: "connection.remove", payload: { connectionId: connection.id } }
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
      // Revert (re-add the captured connection) if the on-disk delete rejects, so a
      // still-on-disk connection does not resurrect on the next reseed (FES-005).
      // Without a captured entry there is nothing to restore — fall back to the plain
      // optimistic remove.
      const forward = { kind: "connection.remove" as const, payload: { connectionId } };
      const persist = () => removeConnection(connectionId, conn?.sourceFile);
      const deletePromise = conn
        ? persistConnectionMutation(forward, persist, {
            kind: "connection.add",
            payload: { connection: conn },
          })
        : (mirrorConnectionIntent(forward.kind, forward.payload), persist());
      deletePromise
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
      // Per-item atomicity (FES-005): each delete re-adds its own captured entry if
      // its persist rejects, so a partial failure resurrects only the rows still on
      // disk rather than leaving every optimistic removal diverged until reload.
      Promise.all(
        toDelete.map((c) => {
          const persistDone = persistConnectionMutation(
            { kind: "connection.remove", payload: { connectionId: c.id } },
            () => removeConnection(c.id, c.sourceFile),
            { kind: "connection.add", payload: { connection: c } }
          );
          // Sweep per id on its OWN durable success (FES-009): a sibling whose
          // persist rejected is rolled back (FES-005) and must not be swept, so
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
      mirrorConnectionIntent("connection.addFolder", { folder });
      frontendLog("connection_sync", `addFolder: persisting ${folder.id}`);
      persistFolder(folder).catch((err) => {
        frontendLog("app_store", `Failed to persist new folder: ${errorMessage(err)}`);
        toast.error(`Failed to create folder ${folder.name}: ${errorMessage(err)}`);
      });
    },

    deleteFolder: (folderId) => {
      // The `connection.removeFolder` intent re-homes the folder's child
      // connections to root and reparents its child folders in the region
      // (optimistic), and the `removeFolder` command folds the authoritative
      // result back server-side (#2389) — so no frontend reparenting is needed.
      mirrorConnectionIntent("connection.removeFolder", { folderId });
      frontendLog("connection_sync", `deleteFolder: removing ${folderId}`);
      removeFolder(folderId).catch((err) => {
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
      // Revert (remove the optimistic copy) if the persist rejects, so a
      // never-persisted duplicate does not linger until reload (FES-005).
      persistConnectionMutation(
        { kind: "connection.add", payload: { connection: duplicate } },
        () => persistConnection(stripPassword(duplicate)),
        { kind: "connection.remove", payload: { connectionId: duplicate.id } }
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
        // refreshed unified view into the region server-side (#2394); mirror the
        // update so the region reflects it immediately even before that diff lands.
        const updated = await apiMoveConnectionToFile(connectionId, currentSource, targetSource);
        mirrorConnectionIntent("connection.update", { connection: updated });
      } catch (err) {
        frontendLog("app_store", `Failed to move connection to file: ${errorMessage(err)}`);
        toast.error(`Failed to move ${conn.name}: ${errorMessage(err)}`);
      }
    },

    moveConnectionToFolder: (connectionId, folderId) => {
      const existing = currentConnectionsView().connections.find((c) => c.id === connectionId);
      if (!existing) return;
      // Optimistic move in the region for instant visual feedback.
      mirrorConnectionIntent("connection.move", { connectionId, folderId });

      // Persist to backend; the persist command folds any dedup rename (e.g. moving
      // a connection into a folder with a same-named sibling) back into the region
      // server-side (#2389).
      const moved = { ...existing, folderId };
      frontendLog("connection_sync", `moveConnectionToFolder: persisting ${connectionId}`);
      persistConnection(stripPassword(moved)).catch((err) => {
        frontendLog("app_store", `Failed to persist connection move: ${errorMessage(err)}`);
        toast.error(`Failed to move ${moved.name}: ${errorMessage(err)}`);
      });
    },

    bulkMoveConnectionsToFolder: (connectionIds, folderId) => {
      const idSet = new Set(connectionIds);

      // Optimistic move in the region for instant visual feedback.
      for (const connectionId of connectionIds) {
        mirrorConnectionIntent("connection.move", { connectionId, folderId });
      }

      // Persist all connections in parallel; each persist folds the authoritative
      // view back into the region server-side (#2389).
      const moved = currentConnectionsView()
        .connections.filter((c) => idSet.has(c.id))
        .map((c) => ({ ...c, folderId }));
      frontendLog(
        "connection_sync",
        `bulkMoveConnectionsToFolder: persisting ${moved.length} connections`
      );
      Promise.all(moved.map((conn) => persistConnection(stripPassword(conn)))).catch((err) => {
        frontendLog("app_store", `Failed to persist bulk connection move: ${errorMessage(err)}`);
        toast.error(`Failed to move connections: ${errorMessage(err)}`);
      });
    },

    reorderConnections: (oldIndex, newIndex) => {
      // Compute the new id order from the authoritative region view, optimistically
      // reorder it in the region for instant feedback, then persist the new array
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
      mirrorConnectionIntent("connection.reorder", { oldIndex, newIndex });
      persistConnectionOrder(connectionIds).catch((err) => {
        frontendLog("app_store", `Failed to persist connection reorder: ${errorMessage(err)}`);
        toast.error(`Failed to save connection order: ${errorMessage(err)}`);
      });
    },
  };
};
