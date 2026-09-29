import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import { collectLiveTabs, getComposedLayout } from "../layoutHelpers";
import type { PersistentSessionEntry } from "@/types/connection";
import {
  AgentDefinitionInfo,
  startPersistentSession as apiStartPersistentSession,
  stopPersistentSession as apiStopPersistentSession,
  attachPersistentTab as apiAttachPersistentTab,
  adoptPersistentSession as apiAdoptPersistentSession,
} from "@/services/api";
import type { SpawnRequestPayload } from "@/services/events";
import { currentConnectionsView } from "@/store/connectionsBridge";
import { readConfigString } from "@/utils/connectionConfigFields";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { findLeafByTab } from "@/utils/panelTree";

/**
 * Session Picker + persistent connection sessions slice (ARCH-001/FES-011,
 * appStore god-module split via #2881): the interactive Session Picker state
 * (SI-3, #1366) and the persistent-session registry for local and agent-hosted
 * connections, with its start / attach / stop / adopt / restart actions.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every action still receives the shared `set` / `get` typed
 * against the full {@link AppState}, so the public store shape and behavior are
 * unchanged. Opening, closing and re-pointing tabs (`addTab`, `closeTab`,
 * `setTabSessionId`) stay in the tabs/layout domain and are called through
 * `get()`. The detach-on-close sweep of `persistentSessions`, the
 * window-restore rebuild of the map and the `onPersistentSessionStateChanged`
 * subscription stay in the root store, because they run inside layout
 * transitions and store init (subscription order is unchanged).
 */
export interface PersistentSessionsSlice {
  // Session Picker (SI-3, #1366)
  /**
   * Whether the interactive Session Picker is showing. Raised by a `--pick`
   * spawn arriving on `spawn-picker-requested`, which defers the decision to the
   * user instead of opening a session outright.
   */
  spawnPickerVisible: boolean;
  /**
   * The request the visible picker is deciding, or `undefined` when it is
   * closed. Carries the `location` the picker shows in its header, plus the
   * `entry_id` / `new_window` context the confirmed choice inherits.
   */
  spawnPickerRequest: SpawnRequestPayload | undefined;
  /** Show the Session Picker for `request`, replacing any request it was showing. */
  showSpawnPicker: (request: SpawnRequestPayload) => void;
  /** Close the Session Picker and drop the request it was deciding. */
  hideSpawnPicker: () => void;

  // Persistent connection sessions
  /** Live state of all persistent connection sessions, keyed by connectionId. */
  persistentSessions: Record<string, PersistentSessionEntry>;
  /** Start the background process for a persistent connection (does not open a tab). */
  startPersistentSession: (connectionId: string) => Promise<void>;
  /** Attach a new terminal tab to an already-running persistent session. */
  attachPersistentSession: (connectionId: string, panelId?: string) => Promise<void>;
  /** Gracefully stop the background process for a persistent connection. */
  stopPersistentSession: (connectionId: string) => Promise<void>;
  /** Update the store entry for a persistent session (called from event listener). */
  setPersistentSessionEntry: (connectionId: string, patch: Partial<PersistentSessionEntry>) => void;
  /** Transition a persistent session to the error state (called when process dies unexpectedly). */
  setPersistentSessionError: (connectionId: string, errorMessage: string) => void;
  /**
   * Start a persistent background session for an agent-hosted connection definition.
   * Resolves with the backend session ID on success, or `null` if the API call failed
   * (in which case the entry is left in the `error` state).
   */
  startAgentPersistentSession: (
    agentId: string,
    def: AgentDefinitionInfo
  ) => Promise<string | null>;
  /** Attach a new terminal tab to a running agent-hosted persistent session. */
  attachAgentPersistentSession: (
    agentId: string,
    def: AgentDefinitionInfo,
    panelId?: string
  ) => Promise<void>;
  /**
   * Start a persistent agent session if not already running, then attach a tab.
   * Used by the sidebar double-click handler so the session is registered with
   * the persistent-session machinery (sidebar state dot turns green) rather than
   * opening an unmanaged tab through `createTerminal`.
   */
  startAndAttachAgentPersistentSession: (
    agentId: string,
    def: AgentDefinitionInfo,
    panelId?: string
  ) => Promise<void>;
  /**
   * Restart (or reattach to) the persistent session backing `tabId` and write
   * the resulting live session id onto the tab. Used by the terminal reconnect
   * path so a persistent tab whose session was destroyed gets a fresh live
   * session instead of reattaching to a dead one. Resolves with the new session
   * id, or `null` if the tab is not persistent or the restart failed.
   */
  restartPersistentSessionForTab: (tabId: string) => Promise<string | null>;
  /**
   * Adopt a surviving agent session into the desktop's persistent registry and
   * attach a new terminal tab to it with full scrollback replay.
   *
   * Used by the sidebar's Active Sessions double-click handler: when the user
   * reopens a session that the desktop is not yet tracking (e.g. after a tab
   * close, or after a desktop restart that discovered the session via
   * `listAgentSessions`), the agent's session ID is linked to the desktop's
   * `${agentId}:${def.id}` connection ID and a tab is attached.
   */
  adoptAndAttachAgentPersistentSession: (
    agentId: string,
    def: AgentDefinitionInfo,
    agentSessionId: string,
    panelId?: string
  ) => Promise<void>;
}

export const createPersistentSessionsSlice: StateCreator<
  AppState,
  [],
  [],
  PersistentSessionsSlice
> = (set, get) => ({
  // Session Picker (SI-3, #1366)
  spawnPickerVisible: false,
  spawnPickerRequest: undefined,
  showSpawnPicker: (request) => set({ spawnPickerVisible: true, spawnPickerRequest: request }),
  hideSpawnPicker: () => set({ spawnPickerVisible: false, spawnPickerRequest: undefined }),

  // Persistent connection sessions
  persistentSessions: {},

  startPersistentSession: async (connectionId) => {
    const conn = currentConnectionsView().connections.find((c) => c.id === connectionId);
    if (!conn) return;
    set((state) => ({
      persistentSessions: {
        ...state.persistentSessions,
        [connectionId]: {
          connectionId,
          sessionId: null,
          state: "starting",
          attachedTabIds: [],
        },
      },
    }));
    try {
      await apiStartPersistentSession(connectionId, conn.config.type, conn.config.config);
    } catch (err) {
      set((state) => ({
        persistentSessions: {
          ...state.persistentSessions,
          [connectionId]: {
            ...state.persistentSessions[connectionId],
            state: "error",
            errorMessage: errorMessage(err),
          },
        },
      }));
    }
  },

  attachPersistentSession: async (connectionId, panelId) => {
    const entry = get().persistentSessions[connectionId];
    const conn = currentConnectionsView().connections.find((c) => c.id === connectionId);
    if (!conn || !entry?.sessionId) return;
    const tabId = get().addTab(conn.name, conn.config.type, conn.config, {
      panelId,
      contentType: "terminal",
      terminalOptions: conn.terminalOptions,
      sessionId: entry.sessionId,
      persistentConnectionId: connectionId,
    });
    try {
      await apiAttachPersistentTab(connectionId, tabId);
      set((state) => {
        const existing = state.persistentSessions[connectionId];
        if (!existing) return state;
        return {
          persistentSessions: {
            ...state.persistentSessions,
            [connectionId]: {
              ...existing,
              attachedTabIds: [...existing.attachedTabIds, tabId],
            },
          },
        };
      });
    } catch (err) {
      frontendLog(
        "app_store",
        `attach_persistent_tab failed for ${connectionId}: ${errorMessage(err)}`
      );
    }
  },

  stopPersistentSession: async (connectionId) => {
    set((state) => {
      const existing = state.persistentSessions[connectionId];
      if (!existing) return state;
      return {
        persistentSessions: {
          ...state.persistentSessions,
          [connectionId]: { ...existing, state: "stopping" },
        },
      };
    });
    try {
      await apiStopPersistentSession(connectionId);
    } catch (err) {
      frontendLog(
        "app_store",
        `stop_persistent_session failed for ${connectionId}: ${errorMessage(err)}`
      );
    }
  },

  setPersistentSessionEntry: (connectionId, patch) =>
    set((state) => {
      const existing = state.persistentSessions[connectionId];
      if (!existing) return state;
      return {
        persistentSessions: {
          ...state.persistentSessions,
          [connectionId]: { ...existing, ...patch },
        },
      };
    }),

  setPersistentSessionError: (connectionId, errorMessage) =>
    set((state) => {
      const existing = state.persistentSessions[connectionId];
      if (!existing) return state;
      return {
        persistentSessions: {
          ...state.persistentSessions,
          [connectionId]: { ...existing, state: "error", errorMessage },
        },
      };
    }),

  startAgentPersistentSession: async (agentId, def) => {
    const connectionId = `${agentId}:${def.id}`;
    set((state) => ({
      persistentSessions: {
        ...state.persistentSessions,
        [connectionId]: {
          connectionId,
          sessionId: null,
          state: "starting",
          attachedTabIds: [],
        },
      },
    }));
    try {
      const sessionId = await apiStartPersistentSession(
        connectionId,
        def.sessionType,
        { ...def.config, title: def.name, definitionId: def.id },
        agentId
      );
      // Record the session ID immediately so callers can attach without
      // racing the persistent-session-state-changed event. The state
      // transition to "running" remains driven by that event.
      set((state) => {
        const existing = state.persistentSessions[connectionId];
        if (!existing) return state;
        return {
          persistentSessions: {
            ...state.persistentSessions,
            [connectionId]: { ...existing, sessionId },
          },
        };
      });
      return sessionId;
    } catch (err) {
      set((state) => ({
        persistentSessions: {
          ...state.persistentSessions,
          [connectionId]: {
            ...state.persistentSessions[connectionId],
            state: "error",
            errorMessage: errorMessage(err),
          },
        },
      }));
      return null;
    }
  },

  attachAgentPersistentSession: async (agentId, def, panelId) => {
    const connectionId = `${agentId}:${def.id}`;
    const entry = get().persistentSessions[connectionId];
    if (!entry?.sessionId) return;
    const tabId = get().addTab(
      def.name,
      "remote-session",
      {
        type: "remote-session",
        config: {
          agentId,
          sessionType: def.sessionType,
          ...def.config,
          persistent: true,
          title: def.name,
        },
      },
      {
        panelId,
        contentType: "terminal",
        terminalOptions: def.terminalOptions,
        sessionId: entry.sessionId,
        persistentConnectionId: connectionId,
      }
    );
    // Resolve the actual panel the tab landed in so we can close it on failure.
    const actualPanelId = findLeafByTab(getComposedLayout(get()).rootPanel, tabId)?.id;
    try {
      await apiAttachPersistentTab(connectionId, tabId);
      set((state) => {
        const existing = state.persistentSessions[connectionId];
        if (!existing) return state;
        return {
          persistentSessions: {
            ...state.persistentSessions,
            [connectionId]: {
              ...existing,
              attachedTabIds: [...existing.attachedTabIds, tabId],
            },
          },
        };
      });
    } catch (err) {
      frontendLog(
        "app_store",
        `attach_persistent_tab failed for ${connectionId}: ${errorMessage(err)}`
      );
      // Session is gone — remove the tab so the user does not see a blank terminal.
      if (actualPanelId) {
        get().closeTab(tabId, actualPanelId);
      }
    }
  },

  adoptAndAttachAgentPersistentSession: async (agentId, def, agentSessionId, panelId) => {
    const connectionId = `${agentId}:${def.id}`;
    const existing = get().persistentSessions[connectionId];

    // If we already track this connection and it points at the same agent
    // session, fall through to the normal attach path — no adoption needed.
    if (existing?.sessionId === agentSessionId) {
      await get().attachAgentPersistentSession(agentId, def, panelId);
      return;
    }

    // If we track a *different* session ID for this connection (e.g. a stale
    // entry from before the agent restart), warn and skip — the user can stop
    // the old persistent record explicitly if they want to overwrite it.
    if (existing?.sessionId && existing.sessionId !== agentSessionId) {
      frontendLog(
        "app_store",
        `adopt skipped for ${connectionId}: already mapped to ${existing.sessionId}`
      );
      return;
    }

    try {
      await apiAdoptPersistentSession(connectionId, agentId, agentSessionId);
    } catch (err) {
      frontendLog(
        "app_store",
        `adopt_persistent_session failed for ${connectionId}: ${errorMessage(err)}`
      );
      return;
    }

    // Seed the desktop's persistentSessions map so attachAgentPersistentSession
    // finds the entry. The backend will emit a persistent-state event that may
    // re-set this asynchronously; mirroring it here avoids a race in the
    // attach call that follows.
    set((state) => ({
      persistentSessions: {
        ...state.persistentSessions,
        [connectionId]: {
          connectionId,
          sessionId: agentSessionId,
          state: "running",
          attachedTabIds: [],
        },
      },
    }));

    await get().attachAgentPersistentSession(agentId, def, panelId);
  },

  startAndAttachAgentPersistentSession: async (agentId, def, panelId) => {
    const connectionId = `${agentId}:${def.id}`;
    const existing = get().persistentSessions[connectionId];
    if (existing?.sessionId && (existing.state === "running" || existing.state === "attached")) {
      await get().attachAgentPersistentSession(agentId, def, panelId);
      return;
    }
    const sessionId = await get().startAgentPersistentSession(agentId, def);
    if (!sessionId) return;
    await get().attachAgentPersistentSession(agentId, def, panelId);
  },

  restartPersistentSessionForTab: async (tabId) => {
    const state = get();
    const tab = collectLiveTabs(state).find((t) => t.id === tabId);
    const connectionId = tab?.persistentConnectionId;
    if (!tab || !connectionId) return null;

    const cfg = tab.config.config;
    const agentId = readConfigString(tab.config, "agentId");
    if (!agentId || !connectionId.startsWith(`${agentId}:`)) return null;
    const defId = connectionId.slice(agentId.length + 1);

    // Register this tab as attached to the (re)started persistent session and
    // track it in the store entry so attach counts and detach-on-close stay
    // correct. Failures are logged but non-fatal — the session is still usable.
    const attachTab = async () => {
      try {
        await apiAttachPersistentTab(connectionId, tabId);
        set((s) => {
          const entry = s.persistentSessions[connectionId];
          if (!entry || entry.attachedTabIds.includes(tabId)) return s;
          return {
            persistentSessions: {
              ...s.persistentSessions,
              [connectionId]: {
                ...entry,
                attachedTabIds: [...entry.attachedTabIds, tabId],
              },
            },
          };
        });
      } catch (err) {
        frontendLog(
          "app_store",
          `restart_persistent attach failed for ${connectionId}: ${errorMessage(err)}`
        );
      }
    };

    // Reuse a session that is already live (e.g. the agent transport simply
    // dropped and recovered) rather than spawning a duplicate.
    const existing = state.persistentSessions[connectionId];
    if (existing?.sessionId && (existing.state === "running" || existing.state === "attached")) {
      get().setTabSessionId(tabId, existing.sessionId);
      await attachTab();
      return existing.sessionId;
    }

    // The session is gone — clear the dead id so the terminal never reattaches
    // to a corpse, then start a fresh persistent session. Reconstruct the
    // connection definition from the tab config (agent definitions may not be
    // loaded, e.g. after an agent disconnect); agentId/persistent are dropped
    // from the forwarded settings.
    get().setTabSessionId(tabId, null);
    const {
      agentId: _agentId,
      sessionType: _sessionType,
      title: _title,
      persistent: _persistent,
      ...connConfig
    } = cfg;
    const def: AgentDefinitionInfo = {
      id: defId,
      name: readConfigString(tab.config, "title") ?? tab.title,
      sessionType: readConfigString(tab.config, "sessionType") ?? "shell",
      config: connConfig,
      persistent: true,
      folderId: null,
    };

    const sessionId = await get().startAgentPersistentSession(agentId, def);
    if (!sessionId) return null;
    await attachTab();
    get().setTabSessionId(tabId, sessionId);
    return sessionId;
  },
});
