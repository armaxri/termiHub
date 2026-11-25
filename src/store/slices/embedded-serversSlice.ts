import { StateCreator } from "zustand";

import {
  saveEmbeddedServer as apiSaveEmbeddedServer,
  deleteEmbeddedServer as apiDeleteEmbeddedServer,
  restoreEmbeddedServer as apiRestoreEmbeddedServer,
  startEmbeddedServer as apiStartEmbeddedServer,
  stopEmbeddedServer as apiStopEmbeddedServer,
  createAndStartServer as apiCreateAndStartServer,
} from "@/services/embeddedServerApi";
import {
  DEFAULT_PORTS,
  EmbeddedServerConfig,
  ServerState as EmbeddedServerState,
  ServerType,
} from "@/types/embeddedServer";
import { createTransport, ProjectionClient } from "@/services/transport";
import { THIS_COMPUTER } from "@/types/tunnel";
import { toast } from "@/components/ui";
import { showUndoToast } from "@/utils/undoableDelete";
import { frontendLog } from "@/utils/frontendLog";

import type { AppState } from "../appStore";
import { errorMessage } from "@/utils/errorMessage";

/** The projection region id of the file servers (twin of the Rust const). */
const SERVICES_REGION = "services";

/**
 * The projected `services` view, the twin of the Rust `services_view_from`
 * (`src-tauri/src/embedded_servers/projection.rs`).
 */
interface ServicesView {
  servers: EmbeddedServerConfig[];
  states: Record<string, EmbeddedServerState>;
}

let _client: ProjectionClient | null = null;

/**
 * Embedded HTTP/FTP/TFTP server domain slice (#2113), a cache of the shared
 * `services` region (#6028, F-6): `loadEmbeddedServers` subscribes, and the list,
 * the states and the traffic of every window come from there. The actions only
 * ask the backend; what they changed arrives as a diff, in every window.
 */
export interface EmbeddedServersSlice {
  embeddedServers: EmbeddedServerConfig[];
  embeddedServerStates: Record<string, EmbeddedServerState>;
  loadEmbeddedServers: () => Promise<void>;
  saveEmbeddedServer: (config: EmbeddedServerConfig) => Promise<void>;
  /** Delete a server; the toast offers to undo it. */
  deleteEmbeddedServer: (serverId: string) => Promise<void>;
  startEmbeddedServer: (serverId: string) => Promise<void>;
  stopEmbeddedServer: (serverId: string) => Promise<void>;
  /** Stop a running server and start it again. */
  restartEmbeddedServer: (serverId: string) => Promise<void>;
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
      // Re-subscribing (a re-init, a restored backup) drops the old client first.
      _client?.stop();
      const client = new ProjectionClient(createTransport(), SERVICES_REGION);
      client.onChange((state) => {
        const view = (state.view ?? {}) as Partial<ServicesView>;
        set({ embeddedServers: view.servers ?? [], embeddedServerStates: view.states ?? {} });
      });
      await client.start();
      _client = client;
    } catch (err) {
      frontendLog("app_store", `Failed to subscribe to services projection: ${errorMessage(err)}`);
    }
  },

  saveEmbeddedServer: async (config) => {
    try {
      await apiSaveEmbeddedServer(config);
    } catch (err) {
      frontendLog("app_store", `Failed to save embedded server: ${errorMessage(err)}`);
      throw err;
    }
  },

  deleteEmbeddedServer: async (serverId) => {
    const name = get().embeddedServers.find((s) => s.id === serverId)?.name ?? "file server";
    try {
      await apiDeleteEmbeddedServer(serverId);
    } catch (err) {
      // Propagate the failure so the caller can show an error toast (#1427).
      frontendLog(
        "embedded_server",
        `Failed to delete embedded server ${serverId}: ${errorMessage(err)}`
      );
      throw err;
    }
    showUndoToast(`Deleted ${name}`, {
      testId: "server-delete-undo-toast",
      onUndo: () =>
        void apiRestoreEmbeddedServer(serverId).catch((err: unknown) =>
          toast.error(`Failed to restore ${name}`, { description: errorMessage(err) })
        ),
    });
  },

  startEmbeddedServer: async (serverId) => {
    try {
      await apiStartEmbeddedServer(serverId);
    } catch (err) {
      frontendLog(
        "embedded_server",
        `Failed to start embedded server ${serverId}: ${errorMessage(err)}`
      );
      throw err;
    }
  },

  stopEmbeddedServer: async (serverId) => {
    try {
      await apiStopEmbeddedServer(serverId);
    } catch (err) {
      frontendLog(
        "embedded_server",
        `Failed to stop embedded server ${serverId}: ${errorMessage(err)}`
      );
      throw err;
    }
  },

  restartEmbeddedServer: async (serverId) => {
    await get().stopEmbeddedServer(serverId);
    await get().startEmbeddedServer(serverId);
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
      host: THIS_COMPUTER,
    };
    return await apiCreateAndStartServer(config);
  },
});
