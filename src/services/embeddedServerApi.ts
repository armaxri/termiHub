/**
 * Tauri command wrappers for embedded server operations.
 */

import { invoke } from "@tauri-apps/api/core";
import { EmbeddedServerConfig, NetworkInterface, ServerActivity } from "@/types/embeddedServer";

/** Add or update an embedded server configuration. */
export async function saveEmbeddedServer(config: EmbeddedServerConfig): Promise<void> {
  await invoke("save_embedded_server", { config });
}

/** Delete an embedded server configuration by ID. */
export async function deleteEmbeddedServer(serverId: string): Promise<void> {
  await invoke("delete_embedded_server", { serverId });
}

/**
 * Read a server's access log and detailed stats (PROD-034/036). Only entries
 * with a sequence number above `sinceSeq` are returned, so callers can poll
 * incrementally. Resolves `null` when the server has no desktop-hosted log
 * (never started on this computer, or hosted on an agent).
 */
export async function getEmbeddedServerActivity(
  serverId: string,
  sinceSeq?: number
): Promise<ServerActivity | null> {
  return await invoke<ServerActivity | null>("get_embedded_server_activity", {
    serverId,
    sinceSeq: sinceSeq ?? null,
  });
}

/** Clear a server's access log and its request/error/top counters. */
export async function clearEmbeddedServerActivity(serverId: string): Promise<void> {
  await invoke("clear_embedded_server_activity", { serverId });
}

/** Start a server by ID. */
export async function startEmbeddedServer(serverId: string): Promise<void> {
  await invoke("start_embedded_server", { serverId });
}

/** Stop a running server by ID. */
export async function stopEmbeddedServer(serverId: string): Promise<void> {
  await invoke("stop_embedded_server", { serverId });
}

/** Ask the agents about the servers they run, now. */
export async function checkEmbeddedServers(): Promise<void> {
  await invoke("check_embedded_servers");
}

/**
 * Create a new server configuration and immediately start it.
 * The backend tries up to 10 sequential ports if the requested port is busy.
 * Returns the ID of the newly created (and started) server.
 */
export async function createAndStartServer(config: EmbeddedServerConfig): Promise<string> {
  return await invoke<string>("create_and_start_server", { config });
}

/**
 * Return all local IPv4 interfaces available as bind addresses.
 * Always includes loopback (127.0.0.1) first and all-interfaces (0.0.0.0) last.
 */
export async function listNetworkInterfaces(): Promise<NetworkInterface[]> {
  return await invoke<NetworkInterface[]>("list_network_interfaces");
}
