/**
 * Helpers for deriving SSH jump-host (`ProxyJump`) display strings from a
 * connection config.
 *
 * A connection routes through a jump host when it is an SSH connection whose
 * settings carry a non-empty `proxyJump` chain (ordered outermost → innermost,
 * mirroring `ssh -J edge,bastion`). These helpers are the single source of truth
 * for the sidebar hop badge, the status-bar hop chain, and the connection-path
 * popover, so every surface renders the chain the same way.
 */

import { JumpHostConfig, SavedConnection } from "@/types/connection";
import { ConnectionConfig } from "@/types/terminal";

/**
 * Extract the jump-host chain from a connection config.
 *
 * Returns an empty array for non-SSH connections or SSH connections without a
 * `proxyJump` chain. Tolerates the legacy `jumpHosts` key the Rust model accepts
 * as a serde alias.
 */
export function getJumpHosts(config: ConnectionConfig | undefined | null): JumpHostConfig[] {
  if (!config || config.type !== "ssh") return [];
  const settings = config.config as Record<string, unknown> | undefined;
  const raw = settings?.proxyJump ?? settings?.jumpHosts;
  return Array.isArray(raw) ? (raw as JumpHostConfig[]) : [];
}

/** Whether the connection reaches its target through a jump host. */
export function hasJumpHost(config: ConnectionConfig | undefined | null): boolean {
  return getJumpHosts(config).length > 0;
}

/** Display name for a single hop (its host, falling back to a generic label). */
function hopLabel(hop: JumpHostConfig): string {
  return hop.host?.trim() || "jump host";
}

/**
 * Full-path tooltip for the hop chain, e.g.
 * `Via: edge-gateway → internal-bastion → db-server`. The target name is
 * appended when provided.
 */
export function jumpHostTooltip(hops: JumpHostConfig[], targetName?: string): string {
  if (hops.length === 0) return "";
  const parts = hops.map(hopLabel);
  if (targetName) parts.push(targetName);
  return `Via: ${parts.join(" → ")}`;
}

/**
 * Status-bar label for an active jump-host connection, e.g.
 * `deploy@app-server via bastion.example.com` (multi-hop chains join their
 * gateways with ` → `). Returns an empty string when no jump host is configured.
 */
export function jumpHostStatusLabel(config: ConnectionConfig | undefined | null): string {
  const hops = getJumpHosts(config);
  if (hops.length === 0) return "";
  const settings = config!.config as Record<string, unknown>;
  const username = typeof settings.username === "string" ? settings.username : "";
  const host = typeof settings.host === "string" ? settings.host : "";
  const target = username ? `${username}@${host}` : host;
  const gateways = hops.map(hopLabel).join(" → ");
  return target ? `${target} via ${gateways}` : `via ${gateways}`;
}

/**
 * Build a synthetic SSH connection that opens a terminal directly on the
 * innermost gateway of `connection`'s jump-host chain (for debugging gateway
 * connectivity). The gateway is reached through the same outer hops, so it
 * shares the pooled gateway session with the original connection.
 *
 * Returns `null` when the connection has no jump host.
 */
export function jumpHostGatewayConnection(connection: SavedConnection): SavedConnection | null {
  const hops = getJumpHosts(connection.config);
  if (hops.length === 0) return null;

  const gateway = hops[hops.length - 1];
  const outerHops = hops.slice(0, -1);
  const settings: Record<string, unknown> = {
    host: gateway.host,
    port: gateway.port,
    username: gateway.username,
    authMethod: gateway.authMethod,
  };
  if (gateway.password !== undefined) settings.password = gateway.password;
  if (gateway.keyPath !== undefined) settings.keyPath = gateway.keyPath;
  if (outerHops.length > 0) settings.proxyJump = outerHops;

  return {
    ...connection,
    id: `${connection.id}::jump-host`,
    name: `${gateway.host} (jump host)`,
    config: { type: "ssh", config: settings },
  };
}
