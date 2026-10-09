/**
 * Tauri command wrappers for tunnel operations.
 */

import { invoke } from "@tauri-apps/api/core";
import { TunnelConfig } from "@/types/tunnel";

/** Save (add or update) a tunnel configuration. */
export async function saveTunnel(config: TunnelConfig): Promise<void> {
  await invoke("save_tunnel", { config });
}

/** Delete a tunnel configuration by ID. */
export async function deleteTunnel(tunnelId: string): Promise<void> {
  await invoke("delete_tunnel", { tunnelId });
}

/** Start a tunnel by ID. */
export async function startTunnel(tunnelId: string): Promise<void> {
  await invoke("start_tunnel", { tunnelId });
}

/** Stop an active tunnel by ID. */
export async function stopTunnel(tunnelId: string): Promise<void> {
  await invoke("stop_tunnel", { tunnelId });
}
