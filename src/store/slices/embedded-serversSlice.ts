import { StateCreator } from "zustand";

import {
  listEmbeddedServers,
  saveEmbeddedServer as apiSaveEmbeddedServer,
  deleteEmbeddedServer as apiDeleteEmbeddedServer,
  startEmbeddedServer as apiStartEmbeddedServer,
  stopEmbeddedServer as apiStopEmbeddedServer,
  getEmbeddedServerStates,
  createAndStartServer as apiCreateAndStartServer,
} from "@/services/embeddedServerApi";
import {
  DEFAULT_PORTS,
  EmbeddedServerConfig,
  ServerState as EmbeddedServerState,
  ServerType,
} from "@/types/embeddedServer";
import { frontendLog } from "@/utils/frontendLog";

import type { AppState } from "../appStore";

/**
 * Embedded HTTP/FTP/TFTP server domain slice (#2113): the embedded-server config
 * list, live server states, and the CRUD/lifecycle actions that drive them.
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every action still receives the shared `set`/`get` typed
 * against the full {@link AppState}, so the public store shape and behavior are
 * unchanged. Mirrors the SSH tunnel slice (#2077).
 */
export interface EmbeddedServersSlice {
  embeddedServers: EmbeddedServerConfig[];
  embeddedServerStates: Record<string, EmbeddedServerState>;
  loadEmbeddedServers: () => Promise<void>;
  /** Refresh only the live runtime states (stats/uptime) without reloading the config list. */
  refreshEmbeddedServerStates: () => Promise<void>;
  saveEmbeddedServer: (config: EmbeddedServerConfig) => Promise<void>;
  deleteEmbeddedServer: (serverId: string) => Promise<void>;
  startEmbeddedServer: (serverId: string) => Promise<void>;
  stopEmbeddedServer: (serverId: string) => Promise<void>;
  updateEmbeddedServerState: (state: EmbeddedServerState) => void;
  quickShareServer: (path: string, protocol: ServerType) => Promise<string>;
}

export const createEmbeddedServersSlice: StateCreator<AppState, [], [], EmbeddedServersSlice> = (
  set,
  get
) => ({
  embeddedServers: [],
  embeddedServerStates: {},

  loadEmbeddedServers: async () => {
    try {
      const servers = await listEmbeddedServers();
      const stateList = await getEmbeddedServerStates();
      const embeddedServerStates: Record<string, EmbeddedServerState> = {};
      for (const s of stateList) {
        embeddedServerStates[s.serverId] = s;
      }
      set({ embeddedServers: servers, embeddedServerStates });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to load embedded servers: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },

  refreshEmbeddedServerStates: async () => {
    try {
      const stateList = await getEmbeddedServerStates();
      const embeddedServerStates: Record<string, EmbeddedServerState> = {};
      for (const s of stateList) {
        embeddedServerStates[s.serverId] = s;
      }
      set({ embeddedServerStates });
    } catch (err) {
      frontendLog("embedded_server", `Failed to refresh embedded server states: ${err}`);
    }
  },

  saveEmbeddedServer: async (config) => {
    try {
      await apiSaveEmbeddedServer(config);
      set((state) => {
        const exists = state.embeddedServers.some((s) => s.id === config.id);
        const embeddedServers = exists
          ? state.embeddedServers.map((s) => (s.id === config.id ? config : s))
          : [...state.embeddedServers, config];
        return { embeddedServers };
      });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to save embedded server: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }
  },

  deleteEmbeddedServer: async (serverId) => {
    try {
      await apiDeleteEmbeddedServer(serverId);
      set((state) => ({
        embeddedServers: state.embeddedServers.filter((s) => s.id !== serverId),
        embeddedServerStates: Object.fromEntries(
          Object.entries(state.embeddedServerStates).filter(([k]) => k !== serverId)
        ),
      }));
    } catch (err) {
      // Propagate the failure so the caller (EmbeddedServerSidebar) can show
      // an error toast — #1427. The server is only removed from the store on
      // success above, so state stays correct on failure. Mirrors
      // saveEmbeddedServer / deleteTunnel.
      frontendLog("embedded_server", `Failed to delete embedded server ${serverId}: ${err}`);
      throw err;
    }
  },

  startEmbeddedServer: async (serverId) => {
    try {
      await apiStartEmbeddedServer(serverId);
    } catch (err) {
      frontendLog("embedded_server", `Failed to start embedded server ${serverId}: ${err}`);
      throw err;
    }
  },

  stopEmbeddedServer: async (serverId) => {
    try {
      await apiStopEmbeddedServer(serverId);
    } catch (err) {
      frontendLog("embedded_server", `Failed to stop embedded server ${serverId}: ${err}`);
      throw err;
    }
  },

  updateEmbeddedServerState: (state) => {
    set((s) => ({
      embeddedServerStates: { ...s.embeddedServerStates, [state.serverId]: state },
    }));
  },

  quickShareServer: async (path, protocol) => {
    const config: EmbeddedServerConfig = {
      id: "",
      name: `Quick Share (${protocol.toUpperCase()})`,
      serverType: protocol,
      rootDirectory: path,
      bindHost: "127.0.0.1",
      port: DEFAULT_PORTS[protocol],
      autoStart: false,
      readOnly: false,
      directoryListing: protocol === "http" ? true : undefined,
    };
    const serverId = await apiCreateAndStartServer(config);
    // Refresh server list so the new entry shows up in the sidebar.
    await get().loadEmbeddedServers();
    return serverId;
  },
});
