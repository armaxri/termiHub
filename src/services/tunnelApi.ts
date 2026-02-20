/**
 * Tauri command wrappers for tunnel operations.
 */

import { invoke } from "@tauri-apps/api/core";
import { TunnelConfig, TunnelState } from "@/types/tunnel";

/** Get all saved tunnel configurations. */
export async function getTunnels(): Promise<TunnelConfig[]> {
  return await invoke<TunnelConfig[]>("get_tunnels");
}

/** Save (add or update) a tunnel configuration. */
export async function saveTunnel(config: TunnelConfig): Promise<void> {
  await invoke("save_tunnel", { config });
}

/** Delete a tunnel configuration by ID. */
export async function deleteTunnel(tunnelId: string): Promise<void> {
  await invoke("delete_tunnel", { tunnelId });
}

/** Get the current status of all tunnels. */
export async function getTunnelStatuses(): Promise<TunnelState[]> {
  return await invoke<TunnelState[]>("get_tunnel_statuses");
}

/** Start a tunnel by ID. */
export async function startTunnel(tunnelId: string): Promise<void> {
  await invoke("start_tunnel", { tunnelId });
}

/** Stop an active tunnel by ID. */
export async function stopTunnel(tunnelId: string): Promise<void> {
  await invoke("stop_tunnel", { tunnelId });
}
