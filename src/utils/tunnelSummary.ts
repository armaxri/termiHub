/**
 * Shared, pure tunnel presentation helpers used by every surface that lists
 * tunnels — the Tunnels sidebar and the connection editor's "Port Forwarding"
 * section (PROD-023) — so both describe and guard a tunnel identically.
 */
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import { isServiceActive, tunnelServiceState } from "@/utils/serviceState";
import { findCompanion } from "@/utils/tunnelChain";

/** The port-mapping display string for a tunnel (e.g. `127.0.0.1:8080 → db:5432`). */
export function tunnelPortMapping(tunnel: TunnelConfig): string {
  switch (tunnel.tunnelType.type) {
    case "local":
      return `${tunnel.tunnelType.config.localHost}:${tunnel.tunnelType.config.localPort} → ${tunnel.tunnelType.config.remoteHost}:${tunnel.tunnelType.config.remotePort}`;
    case "remote":
      return `${tunnel.tunnelType.config.remoteHost}:${tunnel.tunnelType.config.remotePort} → ${tunnel.tunnelType.config.localHost}:${tunnel.tunnelType.config.localPort}`;
    case "dynamic":
      return `${tunnel.tunnelType.config.localHost}:${tunnel.tunnelType.config.localPort}`;
  }
}

/**
 * The confirmation message to show before deleting `tunnelId`, or `null` when
 * the delete is safe to run directly (an idle, unchained tunnel).
 *
 * - a chained companion: deleting it breaks localhost while the agent port keeps
 *   running (#2597);
 * - a chained parent: the delete cascades to its companion — name both;
 * - an active tunnel: the delete silently tears down a live connection.
 */
export function tunnelDeleteConfirmMessage(
  tunnels: TunnelConfig[],
  tunnelStates: Record<string, TunnelState>,
  tunnelId: string
): string | null {
  const target = tunnels.find((t) => t.id === tunnelId);
  const name = target?.name ?? "this tunnel";
  const status = tunnelStates[tunnelId]?.status;
  const state = tunnelServiceState(status);
  const isActive = isServiceActive(state);
  const companion = target ? findCompanion(tunnels, tunnelId) : undefined;

  if (target?.companionOf) {
    return `Deleting "${name}" removes the hop on this computer. localhost will stop reaching the port (it still works on the agent). Continue?`;
  }
  if (companion) {
    return `Deleting "${name}" also removes its linked hop "${companion.name}" on this computer. Continue?`;
  }
  if (state === "notReachable") {
    return `"${name}" may still run on its agent, which is offline. Deleting it stops it there as soon as the agent is connected again. Continue?`;
  }
  if (isActive) {
    return `"${name}" is currently active. Deleting it will stop the tunnel. Continue?`;
  }
  return null;
}
