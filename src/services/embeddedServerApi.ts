/**
 * Tauri command wrappers for embedded server operations.
 */

import { invoke } from "@tauri-apps/api/core";
import { EmbeddedServerConfig, ServerState } from "@/types/embeddedServer";

/** Return all saved embedded server configurations. */
export async function listEmbeddedServers(): Promise<EmbeddedServerConfig[]> {
  return await invoke<EmbeddedServerConfig[]>("list_embedded_servers");
}

/** Add or update an embedded server configuration. */
export async function saveEmbeddedServer(config: EmbeddedServerConfig): Promise<void> {
  await invoke("save_embedded_server", { config });
}

/** Delete an embedded server configuration by ID. */
export async function deleteEmbeddedServer(serverId: string): Promise<void> {
  await invoke("delete_embedded_server", { serverId });
}

/** Get the current runtime state of all configured servers. */
export async function getEmbeddedServerStates(): Promise<ServerState[]> {
  return await invoke<ServerState[]>("get_embedded_server_states");
}

/** Start a server by ID. */
export async function startEmbeddedServer(serverId: string): Promise<void> {
  await invoke("start_embedded_server", { serverId });
}

/** Stop a running server by ID. */
export async function stopEmbeddedServer(serverId: string): Promise<void> {
  await invoke("stop_embedded_server", { serverId });
}

/**
 * Create a new server configuration and immediately start it.
 * The backend tries up to 10 sequential ports if the requested port is busy.
 * Returns the ID of the newly created (and started) server.
 */
export async function createAndStartServer(config: EmbeddedServerConfig): Promise<string> {
  return await invoke<string>("create_and_start_server", { config });
}
