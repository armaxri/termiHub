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

import { JumpHostConfig } from "@/types/connection";
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
 * Compact label for the connection tree next to the hop badge:
 * `via bastion` for a single hop, `N hops` for a multi-hop chain.
 */
export function jumpHostShortLabel(hops: JumpHostConfig[]): string {
  if (hops.length === 0) return "";
  if (hops.length === 1) return `via ${hopLabel(hops[0])}`;
  return `${hops.length} hops`;
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
