import { StateCreator } from "zustand";

import type { AppState, AgentPendingUpdate, AgentUpdatePending } from "../appStore";
import type { RemoteAgentDefinition, AgentCapabilities, AgentSettings } from "@/types/connection";
import { persistAgent, removeAgent, reorderAgents as persistAgentOrder } from "@/services/storage";
import {
  cancelAgentUpdateReconnect as apiCancelAgentUpdateReconnect,
  connectAgent as apiConnectAgent,
  disconnectAgent as apiDisconnectAgent,
  shutdownAgent as apiShutdownAgent,
  applyAgentSettings as apiApplyAgentSettings,
  listAgentSessions,
  listAgentConnections,
  saveAgentDefinition,
  updateAgentDefinition as apiUpdateAgentDefinition,
  deleteAgentDefinition,
  createAgentFolder as apiCreateAgentFolder,
  updateAgentFolder as apiUpdateAgentFolder,
  deleteAgentFolder as apiDeleteAgentFolder,
} from "@/services/api";
import {
  buildAgentConnectionCreate,
  buildAgentConnectionMove,
  buildAgentFolderExpanded,
} from "@/services/agentConnectionPayloads";
import type { ConnectionCreateParams } from "@/types/generated/ConnectionCreateParams";
import type { ConnectionUpdateParams } from "@/types/generated/ConnectionUpdateParams";
import type { FolderUpdateParams } from "@/types/generated/FolderUpdateParams";
import type { RemoteAgentConfig } from "@/types/terminal";
import { currentAgentsView, mirrorAgentIntent } from "@/store/agentsBridge";
import {
  clearAgentDisconnectIntent,
  markAgentDisconnectIntent,
} from "@/store/agentDisconnectIntent";
import { useFileBookmarksStore } from "@/store/fileBookmarksStore";
import type { AgentUpdateReconnectEvent } from "@/types/generated/AgentUpdateReconnectEvent";
import { toast, type ToastOptions } from "@/components/ui";
import { fireAndForget, frontendError, frontendLog } from "@/utils/frontendLog";
import { backendErrorMessage } from "@/utils/backendErrorCode";
import { errorMessage } from "@/utils/errorMessage";
import { agentBookmarkScopePrefix } from "@/utils/fileBookmarkScope";

/**
 * Remote-agents domain slice (ARCH-001/FES-011, appStore god-module split via
 * #2881): the agent lifecycle actions (add / update / reorder / delete / toggle,
 * connect / disconnect / shutdown, connection-state + capabilities + settings),
 * the agent-hosted connection-definition and folder CRUD, and the per-client
 * update presentation state (`agentUpdates` / `agentUpdatesDismissed` /
 * `agentUpdatePending`) including the coordinated-update notice
 * (`handleAgentUpdatePending` / `handleAgentUpdateReconnect`, #1602, #4489).
 * The agent list, sessions, definitions and folders themselves stay
 * region-authoritative (#2409) — they live in the shared `agents` projection
 * region (`currentAgentsView()`), and these actions are thin backend-command
 * wrappers that mirror `agent.*` intents.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every action still receives the shared `set`/`get` typed
 * against the full {@link AppState}, so the public store shape and behavior are
 * unchanged. `resolveAgentErrorTabs` stays in the root store: it rewrites the tab
 * trees through the root-local `setAndReseed` layout-region reseed and the
 * `tabContent` by-id map (#2539), so it belongs to the tabs/layout domain.
 */
export interface AgentsSlice {
  /** Staged/available agent updates by agent id, from `agent.update_available` (#1352). */
  agentUpdates: Record<string, AgentPendingUpdate>;
  /** Per-agent dismissal of the deferred-update banner (#1352). */
  agentUpdatesDismissed: Record<string, boolean>;
  /** Record (or clear) a staged/available update for an agent. */
  setAgentUpdateAvailable: (agentId: string, update: AgentPendingUpdate) => void;
  /** Hide the deferred-update banner for an agent for this session. */
  dismissAgentUpdate: (agentId: string) => void;
  /**
   * Coordinated updates in progress on an agent, initiated by another host,
   * from `agent.update_pending` (#1602). Keyed by agent id.
   */
  agentUpdatePending: Record<string, AgentUpdatePending>;
  /**
   * Present an incoming `remote-agent-update-pending` (#1602): record the notice
   * and show the "being updated by another host" waiting notice with a Cancel.
   * The backend has already suspended the agent (the disconnect is the ack the
   * updating host waits for) and reconnects it once for every window (#4489);
   * this window only presents that. A duplicate of the recorded notice is
   * ignored.
   */
  handleAgentUpdatePending: (
    agentId: string,
    requestedByVersion: string,
    estimatedRestartSecs: number
  ) => void;
  /**
   * Present how the backend's coordinated-update reconnect ended (#4489):
   * reconnected (claiming the updated version only when the agent reports the
   * requested one), failed or cancelled (both with a manual Reconnect), or
   * superseded by a newer action (the notice goes away).
   */
  handleAgentUpdateReconnect: (event: AgentUpdateReconnectEvent) => void;
  /** Clear a recorded coordinated-update-pending notice for an agent. */
  clearAgentUpdatePending: (agentId: string) => void;
  /**
   * The user stops the backend's coordinated-update reconnect for an agent
   * (#4311, #4489). The hosted tabs stay resumable; every window then offers a
   * manual Reconnect.
   */
  cancelAgentUpdateReconnect: (agentId: string) => Promise<void>;
  addRemoteAgent: (agent: RemoteAgentDefinition) => void;
  updateRemoteAgent: (agent: RemoteAgentDefinition) => void;
  deleteRemoteAgent: (agentId: string) => void;
  reorderRemoteAgents: (oldIndex: number, newIndex: number) => void;
  toggleRemoteAgent: (agentId: string) => void;
  connectRemoteAgent: (agentId: string, password?: string) => Promise<void>;
  /**
   * Disconnect (detach) a remote agent. By default this is a user Disconnect:
   * the hosted tabs end cleanly with a manual Reconnect (#4309). Pass
   * `{ endHostedSessions: false }` for a suspend-style disconnect that is
   * followed by a reconnect (agent update, Force reconnect), so the hosted tabs
   * keep waiting to resume their sessions.
   */
  disconnectRemoteAgent: (
    agentId: string,
    options?: { endHostedSessions?: boolean }
  ) => Promise<void>;
  /**
   * Gracefully shut down a remote agent (stop remote sessions) and disconnect.
   * Resolves to the number of sessions the agent reported as detached/killed.
   */
  shutdownRemoteAgent: (agentId: string) => Promise<number>;
  setAgentConnectionState: (
    agentId: string,
    state: RemoteAgentDefinition["connectionState"],
    error?: string
  ) => void;
  setAgentCapabilities: (agentId: string, capabilities: AgentCapabilities) => void;
  clearAgentSessions: (agentId: string) => void;
  updateAgentSettings: (agentId: string, settings: AgentSettings) => Promise<void>;
  refreshAgentSessions: (agentId: string) => Promise<void>;
  saveAgentDef: (agentId: string, definition: ConnectionCreateParams) => Promise<void>;
  duplicateAgentDef: (agentId: string, definitionId: string) => Promise<void>;
  updateAgentDef: (agentId: string, params: ConnectionUpdateParams) => Promise<void>;
  moveAgentDefToFolder: (agentId: string, defId: string, folderId: string | null) => Promise<void>;
  bulkMoveAgentDefsToFolder: (
    agentId: string,
    defIds: string[],
    folderId: string | null
  ) => Promise<void>;
  deleteAgentDef: (agentId: string, definitionId: string) => Promise<void>;
  createAgentFolder: (agentId: string, name: string, parentId?: string | null) => Promise<void>;
  updateAgentFolder: (agentId: string, params: FolderUpdateParams) => Promise<void>;
  deleteAgentFolder: (agentId: string, folderId: string) => Promise<void>;
  toggleAgentFolder: (agentId: string, folderId: string) => void;
}

/** The toast id for an agent's coordinated-update notice. */
function agentUpdateToastId(agentId: string): string {
  return `agent-update-pending-${agentId}`;
}

/** The agent's display name, for the coordinated-update notices. */
function agentDisplayName(agentId: string): string {
  return currentAgentsView().remoteAgents.find((a) => a.id === agentId)?.name ?? "Agent";
}

/** Drop the coordinated-update notice record for an agent from the state. */
function withoutPending(
  pending: Record<string, AgentUpdatePending>,
  agentId: string
): Partial<AppState> {
  if (!(agentId in pending)) return {};
  const next = { ...pending };
  delete next[agentId];
  return { agentUpdatePending: next };
}

type SliceGet = Parameters<StateCreator<AppState, [], [], AgentsSlice>>[1];

/** A manual Reconnect for the coordinated-update failure and stopped notices. */
function manualReconnectAction(
  get: SliceGet,
  agentId: string
): NonNullable<ToastOptions["action"]> {
  return {
    label: "Reconnect",
    onClick: () => {
      get()
        .connectRemoteAgent(agentId)
        .then(() => {
          toast.success(`${agentDisplayName(agentId)} reconnected.`, {
            id: agentUpdateToastId(agentId),
          });
        })
        .catch((err: unknown) => {
          toast.error(`Couldn't reconnect to ${agentDisplayName(agentId)}.`, {
            id: agentUpdateToastId(agentId),
            description: backendErrorMessage(err),
            action: manualReconnectAction(get, agentId),
          });
        });
    },
  };
}

export const createAgentsSlice: StateCreator<AppState, [], [], AgentsSlice> = (set, get) => ({
  agentUpdates: {},
  agentUpdatesDismissed: {},

  setAgentUpdateAvailable: (agentId, update) => {
    set((s) => ({
      agentUpdates: { ...s.agentUpdates, [agentId]: update },
      // A freshly reported update re-arms the banner even if a prior one was
      // dismissed this session.
      agentUpdatesDismissed: { ...s.agentUpdatesDismissed, [agentId]: false },
    }));
  },

  dismissAgentUpdate: (agentId) => {
    set((s) => ({
      agentUpdatesDismissed: { ...s.agentUpdatesDismissed, [agentId]: true },
    }));
  },

  agentUpdatePending: {},

  handleAgentUpdatePending: (agentId, requestedByVersion, estimatedRestartSecs) => {
    // Ignore a duplicate notice for the update already on screen.
    if (get().agentUpdatePending[agentId]?.requestedByVersion === requestedByVersion) return;

    set((s) => ({
      agentUpdatePending: {
        ...s.agentUpdatePending,
        [agentId]: { requestedByVersion, estimatedRestartSecs, since: Date.now() },
      },
    }));

    // A loading toast is the design system's long-running-work affordance (the
    // "reactive" pillar): it shows the suspend/restart is in progress and
    // resolves in place when the backend reports the outcome. Cancel stops the
    // backend's reconnect (#4311, #4489).
    toast.loading(`${agentDisplayName(agentId)} is being updated by another host…`, {
      id: agentUpdateToastId(agentId),
      description: "Sessions are paused briefly and reconnect automatically.",
      action: {
        label: "Cancel",
        onClick: () => void get().cancelAgentUpdateReconnect(agentId),
      },
    });
  },

  handleAgentUpdateReconnect: (event) => {
    const { agentId, requestedByVersion, agentVersion } = event;
    set((s) => withoutPending(s.agentUpdatePending, agentId));
    const agentName = agentDisplayName(agentId);
    const toastId = agentUpdateToastId(agentId);
    switch (event.outcome) {
      case "reconnected":
        // Only claim the updated version when the agent reports it: a deferred
        // update may not have been applied yet.
        if (agentVersion && agentVersion === requestedByVersion) {
          toast.success(`${agentName} reconnected to the updated version.`, {
            id: toastId,
            description: `Agent version ${agentVersion}.`,
          });
        } else {
          toast.success(`${agentName} reconnected.`, {
            id: toastId,
            description: agentVersion
              ? `The agent still reports version ${agentVersion}; the update may not be applied yet.`
              : undefined,
          });
        }
        return;
      case "failed":
        frontendError(
          "app_store",
          `Gave up reconnecting agent ${agentId} after the update: ${event.error ?? "unknown error"}`
        );
        toast.error(`Couldn't reconnect to ${agentName} after the update.`, {
          id: toastId,
          description:
            "The agent did not come back in time. Its sessions are kept and resume when you reconnect.",
          action: manualReconnectAction(get, agentId),
        });
        return;
      case "cancelled":
        toast.info(`Stopped reconnecting to ${agentName}.`, {
          id: toastId,
          description: "Its sessions are kept and resume when you reconnect.",
          action: manualReconnectAction(get, agentId),
        });
        return;
      case "superseded":
        // A newer action (a manual connect, disconnect, shutdown or delete)
        // owns the agent now; the notice simply goes away.
        toast.dismiss(toastId);
        return;
    }
  },

  cancelAgentUpdateReconnect: async (agentId) => {
    // The backend reports the stop to every window (`cancelled`), which is
    // what resolves the notice.
    try {
      await apiCancelAgentUpdateReconnect(agentId);
    } catch (err) {
      frontendError(
        "app_store",
        `Failed to stop the update reconnect for agent ${agentId}: ${errorMessage(err)}`
      );
      toast.error(`Couldn't stop reconnecting to ${agentDisplayName(agentId)}.`, {
        id: agentUpdateToastId(agentId),
        description: errorMessage(err),
      });
    }
  },

  clearAgentUpdatePending: (agentId) => {
    set((s) => withoutPending(s.agentUpdatePending, agentId));
  },

  addRemoteAgent: (agent) => {
    // Optimistic append in the authoritative region (#2409), then persist. The
    // backend folds the persisted agent list back at the source (#2403).
    mirrorAgentIntent("agent.add", {
      id: agent.id,
      name: agent.name,
      config: agent.config,
      agentSettings: agent.agentSettings,
    });
    persistAgent({
      id: agent.id,
      name: agent.name,
      config: agent.config,
      agentSettings: agent.agentSettings,
    }).catch((err) => {
      frontendLog("app_store", `Failed to persist new agent: ${errorMessage(err)}`);
      toast.error(`Failed to save agent ${agent.name}: ${errorMessage(err)}`);
    });
  },

  updateRemoteAgent: (agent) => {
    // Optimistic edit in the region (#2409), then persist.
    mirrorAgentIntent("agent.update", {
      id: agent.id,
      name: agent.name,
      config: agent.config,
      agentSettings: agent.agentSettings,
    });
    persistAgent({
      id: agent.id,
      name: agent.name,
      config: agent.config,
      agentSettings: agent.agentSettings,
    }).catch((err) => {
      frontendLog("app_store", `Failed to persist agent update: ${errorMessage(err)}`);
      toast.error(`Failed to save agent ${agent.name}: ${errorMessage(err)}`);
    });
  },

  reorderRemoteAgents: (oldIndex, newIndex) => {
    // Compute the new id order from the authoritative region view, optimistically
    // reorder it in the region (#2409), then persist the new order.
    const agents = [...currentAgentsView().remoteAgents];
    const [moved] = agents.splice(oldIndex, 1);
    agents.splice(newIndex, 0, moved);
    const agentIds = agents.map((a) => a.id);
    mirrorAgentIntent("agent.reorder", { oldIndex, newIndex });
    persistAgentOrder(agentIds).catch((err) => {
      frontendLog("app_store", `Failed to persist agent reorder: ${errorMessage(err)}`);
      toast.error(`Failed to save agent order: ${errorMessage(err)}`);
    });
  },

  deleteRemoteAgent: (agentId) => {
    // A deleted agent has nothing to reconnect to (#4311): stop the backend's
    // coordinated-update reconnect, which also drops the notice everywhere.
    if (get().agentUpdatePending[agentId]) {
      apiCancelAgentUpdateReconnect(agentId, { superseded: true }).catch((err: unknown) => {
        frontendError(
          "app_store",
          `Failed to stop the update reconnect for deleted agent ${agentId}: ${errorMessage(err)}`
        );
      });
    }
    // Disconnect first if connected
    const agent = currentAgentsView().remoteAgents.find((a) => a.id === agentId);
    if (agent && agent.connectionState !== "disconnected") {
      // Best-effort transport teardown during delete — a failure leaks the
      // connection, so log it to the LogViewer rather than swallowing it
      // (WA-FE-005).
      apiDisconnectAgent(agentId).catch((err) => {
        frontendError(
          "app_store",
          `Failed to disconnect agent ${agentId} during delete: ${errorMessage(err)}`
        );
      });
    }
    // Optimistic remove in the region — drops the agent and all of its sub-state
    // (the store's `remove` clears sessions/definitions/folders too, #2409);
    // the persisted-list fold reconciles server-side (#2403).
    mirrorAgentIntent("agent.remove", { id: agentId });
    removeAgent(agentId)
      .then(() => {
        // The backend pruned the agent's file-browser bookmarks (#3562);
        // drop them from the UI cache too.
        const prefix = agentBookmarkScopePrefix(agentId);
        useFileBookmarksStore.getState().forgetScopes((scope) => scope.startsWith(prefix));
      })
      .catch((err) => {
        frontendLog("app_store", `Failed to persist agent deletion: ${errorMessage(err)}`);
        toast.error(`Failed to delete agent ${agent?.name ?? ""}: ${errorMessage(err)}`);
      });
  },

  toggleRemoteAgent: (agentId) => {
    // Optimistically flip the sidebar expansion in the authoritative region (#2409).
    mirrorAgentIntent("agent.toggleExpanded", { id: agentId });
  },

  connectRemoteAgent: async (agentId, password) => {
    const agent = currentAgentsView().remoteAgents.find((a) => a.id === agentId);
    if (!agent) return;
    // A manual connect supersedes a running coordinated-update reconnect; the
    // backend stops it and tells every window (#4489).

    // Single-writer rule (G4/#1234): `connectionState` is written ONLY by the
    // backend `agent-state-change` event (via `setAgentConnectionState`). This
    // action just kicks off the request and consumes the returned
    // `capabilities` — it writes no `connecting`/`connected`/`disconnected`
    // states. The backend is authoritative for every transition (it emits
    // "connecting" up front and "connected"/"disconnected" on the outcome),
    // so an optimistic write here could clobber a fast drop → "reconnecting"
    // event that arrives before this promise settles.
    // The agent's expansion before this connect: connect force-expands the
    // sidebar entry, so the region only needs a toggle when it was collapsed.
    const wasExpanded = agent.isExpanded;
    try {
      const config: RemoteAgentConfig = { ...agent.config };
      if (password && config.authMethod === "password") {
        config.password = password;
      }
      const result = await apiConnectAgent(agentId, config, agent.agentSettings);

      // Consume capabilities only (no connectionState write): record the
      // capabilities and the force-expand optimistically in the authoritative
      // region (#2409). `connectionState` stays a single-writer field driven by
      // the `agent-state-change` event (`setAgentConnectionState` →
      // `agent.status`), so it is deliberately not written here.
      mirrorAgentIntent("agent.setCapabilities", {
        id: agentId,
        capabilities: result.capabilities,
      });
      if (!wasExpanded) mirrorAgentIntent("agent.toggleExpanded", { id: agentId });

      // The session/definition refresh is owned by the "connected" event
      // (`setAgentConnectionState`), so it runs exactly once per connect and
      // also covers the reconnect path — do not refresh here (de-dup, G4).
    } catch (err) {
      frontendLog("app_store", `Failed to connect agent ${agentId}: ${backendErrorMessage(err)}`);
      // No optimistic "disconnected" write: the backend emits "disconnected"
      // on every connect-failure path, so the event will drive the state.
      throw err;
    }
  },

  disconnectRemoteAgent: async (agentId, options) => {
    // Record the intent before asking the backend: its "disconnected" event can
    // land before this call resolves, and the handler must see a user end, not a
    // drop that arms a reconnect loop which can never succeed (#4309).
    const endHostedSessions = options?.endHostedSessions ?? true;
    // The backend also stops a coordinated-update reconnect on this disconnect
    // and tells every window (#4489).
    if (endHostedSessions) markAgentDisconnectIntent(agentId);
    try {
      // The backend carries the same choice on its "disconnected" event, so every
      // window — not only this one — ends or resumes the hosted tabs (#4447).
      if (endHostedSessions) await apiDisconnectAgent(agentId);
      else await apiDisconnectAgent(agentId, { endHostedSessions: false });
    } catch (err) {
      if (endHostedSessions) clearAgentDisconnectIntent(agentId);
      frontendLog("app_store", `Failed to disconnect agent ${agentId}: ${errorMessage(err)}`);
      toast.error(`Failed to disconnect agent: ${errorMessage(err)}`);
    }
    // Optimistically force the region entry to disconnected and clear its live
    // sessions/folders (the store's `disconnect` does exactly this, #2409).
    mirrorAgentIntent("agent.disconnect", { id: agentId });
  },

  shutdownRemoteAgent: async (agentId) => {
    // Unlike disconnect (detach), shutdown stops the remote sessions and then
    // drops the transport. The backend returns how many sessions were
    // detached/killed so the UI can report the impact.
    // As with disconnect, the hosted tabs end cleanly rather than reconnecting
    // to an agent that was stopped on purpose (#4309).
    markAgentDisconnectIntent(agentId);
    let detached: number;
    try {
      detached = await apiShutdownAgent(agentId);
    } catch (err) {
      clearAgentDisconnectIntent(agentId);
      throw err;
    }
    // As with disconnect, optimistically force the region entry to disconnected
    // and clear its live sessions/folders (#2409).
    mirrorAgentIntent("agent.disconnect", { id: agentId });
    return detached;
  },

  setAgentConnectionState: (agentId, connectionState, error) => {
    // Single writer for `connectionState` (G4/#1234): only the backend
    // `agent-state-change` event reaches this setter. Read the previous state
    // from the authoritative region to guard the once-per-connect refresh below.
    const previous = currentAgentsView().remoteAgents.find(
      (a) => a.id === agentId
    )?.connectionState;

    // Optimistically set the connection state in the region (#2409). This is the
    // single writer for `connectionState` (G4/#1234); the store's `set_status`
    // tracks `lastError` across auto-reconnect exhaustion (G3/#1236) with the same
    // rules the frontend used — record it on `disconnected` (falling back to the
    // stored one), clear it on `connecting`/`connected`, leave it otherwise.
    mirrorAgentIntent("agent.status", { id: agentId, state: connectionState, error });

    // The refresh of sessions/definitions is owned by the transition INTO
    // "connected" — this is the single, de-duped refresh per connect (G4).
    // Guarding on the previous state keeps a redundant/duplicate "connected"
    // event from triggering a second refresh, and it also covers the
    // reconnect path (reconnecting → connected) which never runs
    // `connectRemoteAgent`.
    if (connectionState === "connected" && previous !== "connected") {
      void get().refreshAgentSessions(agentId);
    }
  },

  clearAgentSessions: (agentId) => {
    // Optimistically empty the region's live-session list for the agent (#2409).
    mirrorAgentIntent("agent.clearSessions", { id: agentId });
  },

  setAgentCapabilities: (agentId, capabilities) => {
    // Optimistically record the negotiated capabilities in the region (#2409).
    mirrorAgentIntent("agent.setCapabilities", { id: agentId, capabilities });
  },

  updateAgentSettings: async (agentId, settings) => {
    await apiApplyAgentSettings(agentId, settings);
    // Optimistically apply just the settings in the region (#2409).
    mirrorAgentIntent("agent.applySettings", { id: agentId, agentSettings: settings });
  },

  refreshAgentSessions: async (agentId) => {
    try {
      const [sessions, connectionsData] = await Promise.all([
        listAgentSessions(agentId),
        listAgentConnections(agentId),
      ]);
      // Optimistically replace the agent's live sessions plus its saved
      // definitions and folders in the region in one shot (the once-per-connect
      // refresh set, #2409).
      mirrorAgentIntent("agent.refresh", {
        id: agentId,
        sessions,
        definitions: connectionsData.connections,
        folders: connectionsData.folders,
      });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to refresh agent sessions for ${agentId}: ${errorMessage(err)}`
      );
      toast.error(`Failed to load agent sessions: ${errorMessage(err)}`);
    }
  },

  saveAgentDef: async (agentId, definition) => {
    try {
      const saved = await saveAgentDefinition(agentId, definition);
      // Optimistically upsert the saved definition in the region (#2409).
      mirrorAgentIntent("agent.saveDefinition", { id: agentId, definition: saved });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to save agent definition on ${agentId}: ${errorMessage(err)}`
      );
      toast.error(`Failed to save connection: ${errorMessage(err)}`);
    }
  },

  duplicateAgentDef: async (agentId, definitionId) => {
    const original = currentAgentsView().agentDefinitions[agentId]?.find(
      (d) => d.id === definitionId
    );
    if (!original) return;
    await get().saveAgentDef(
      agentId,
      buildAgentConnectionCreate(
        {
          name: `Copy of ${original.name}`,
          type: original.sessionType,
          config: original.config,
          persistent: original.persistent,
          terminalOptions: original.terminalOptions,
          icon: original.icon,
        },
        original.folderId
      )
    );
  },

  deleteAgentDef: async (agentId, definitionId) => {
    try {
      await deleteAgentDefinition(agentId, definitionId);
      // Optimistically remove the definition from the region (#2409).
      mirrorAgentIntent("agent.deleteDefinition", { id: agentId, definitionId });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to delete agent definition on ${agentId}: ${errorMessage(err)}`
      );
      toast.error(`Failed to delete connection: ${errorMessage(err)}`);
    }
  },

  updateAgentDef: async (agentId, params) => {
    try {
      const updated = await apiUpdateAgentDefinition(agentId, params);
      // Optimistically replace the definition by id in the region (#2409).
      mirrorAgentIntent("agent.updateDefinition", { id: agentId, definition: updated });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to update agent definition on ${agentId}: ${errorMessage(err)}`
      );
      toast.error(`Failed to update connection: ${errorMessage(err)}`);
    }
  },

  moveAgentDefToFolder: async (agentId, defId, folderId) => {
    await get().updateAgentDef(agentId, buildAgentConnectionMove(defId, folderId));
  },

  bulkMoveAgentDefsToFolder: async (agentId, defIds, folderId) => {
    await Promise.all(defIds.map((defId) => get().moveAgentDefToFolder(agentId, defId, folderId)));
  },

  createAgentFolder: async (agentId, name, parentId) => {
    try {
      const folder = await apiCreateAgentFolder(agentId, name, parentId);
      // Optimistically append the folder to the region (#2409).
      mirrorAgentIntent("agent.createFolder", { id: agentId, folder });
      toast.success(`Created folder ${folder.name}`);
    } catch (err) {
      frontendLog("app_store", `Failed to create agent folder on ${agentId}: ${errorMessage(err)}`);
      toast.error(`Failed to create folder: ${errorMessage(err)}`);
    }
  },

  updateAgentFolder: async (agentId, params) => {
    // A rename carries a new `name`; other prop updates (e.g. expansion state)
    // stay silent so we do not toast on bookkeeping writes.
    const isRename = typeof params.name === "string";
    try {
      const updated = await apiUpdateAgentFolder(agentId, params);
      // Optimistically replace the folder by id in the region (#2409).
      mirrorAgentIntent("agent.updateFolder", { id: agentId, folder: updated });
      if (isRename) toast.success(`Renamed folder to ${updated.name}`);
    } catch (err) {
      frontendLog("app_store", `Failed to update agent folder on ${agentId}: ${errorMessage(err)}`);
      if (isRename) {
        toast.error(`Failed to rename folder: ${errorMessage(err)}`);
      }
    }
  },

  deleteAgentFolder: async (agentId, folderId) => {
    try {
      await apiDeleteAgentFolder(agentId, folderId);
      // Optimistically remove the folder and reparent its child definitions to
      // the root (the store's `delete_folder` does both, #2409).
      mirrorAgentIntent("agent.deleteFolder", { id: agentId, folderId });
    } catch (err) {
      frontendLog("app_store", `Failed to delete agent folder on ${agentId}: ${errorMessage(err)}`);
      toast.error(`Failed to delete folder: ${errorMessage(err)}`);
    }
  },

  toggleAgentFolder: (agentId, folderId) => {
    const existing = (currentAgentsView().agentFolders[agentId] ?? []).find(
      (f) => f.id === folderId
    );
    if (!existing) return;
    const folder = { ...existing, isExpanded: !existing.isExpanded };
    // Optimistically replace the folder (with its flipped expansion) in the
    // region (#2409), then fire-and-forget persist the expansion state.
    mirrorAgentIntent("agent.updateFolder", { id: agentId, folder });
    fireAndForget(
      apiUpdateAgentFolder(agentId, buildAgentFolderExpanded(folderId, folder.isExpanded)),
      `persist agent folder ${folderId} expansion`
    );
  },
});
