/**
 * Shared, pure tunnel presentation helpers used by every surface that lists
 * tunnels — the Tunnels sidebar and the connection editor's "Port Forwarding"
 * section (PROD-023) — so both describe and guard a tunnel identically.
 */
import { t, tf } from "@/i18n/catalog";
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
 * What to say before deleting `tunnelId`, or `null` when the delete is safe to
 * run directly (an idle, unchained tunnel).
 *
 * - a chained companion: deleting it breaks localhost while the agent port keeps
 *   running (#2597);
 * - a chained parent: the delete cascades to its companion;
 * - an active tunnel: the delete silently tears down a live connection.
 */
export function tunnelDeleteConfirmMessage(
  tunnels: TunnelConfig[],
  tunnelStates: Record<string, TunnelState>,
  tunnelId: string
): string | null {
  const target = tunnels.find((tunnel) => tunnel.id === tunnelId);
  const state = tunnelServiceState(tunnelStates[tunnelId]?.status);
  const companion = target ? findCompanion(tunnels, tunnelId) : undefined;
  const says: string[] = [];
  if (state === "notReachable") says.push(t("service.delete.notReachable"));
  else if (isServiceActive(state)) says.push(t("service.delete.running"));
  if (target?.companionOf) says.push(t("service.delete.hop"));
  else if (companion) says.push(tf("service.delete.parent", { name: companion.name }));
  return says.length > 0 ? [...says, t("service.delete.undo")].join(" ") : null;
}
