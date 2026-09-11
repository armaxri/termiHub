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

import { ConnectionFolder, JumpHostConfig, SavedConnection } from "@/types/connection";
import { ConnectionConfig } from "@/types/terminal";
import type { SettingsField, SettingsSchema } from "@/types/schema";

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

/**
 * Find connections that reference any of `targetIds` as a saved-connection jump
 * host (a `proxyJump` hop with `connectionId` in `targetIds`). Connections in the
 * target set are excluded — when deleting them together, their references to each
 * other are moot. Used to warn before deleting a connection used as a jump host
 * elsewhere (#941).
 */
export function findJumpHostDependents(
  connections: SavedConnection[],
  targetIds: string[]
): SavedConnection[] {
  const targets = new Set(targetIds);
  return connections.filter(
    (c) =>
      !targets.has(c.id) &&
      getJumpHosts(c.config).some((hop) => hop.connectionId && targets.has(hop.connectionId))
  );
}

/** A saved SSH connection offered as a jump-host hop in the editor dropdown. */
export interface SavedConnectionOption {
  /** The connection's id, stored as the hop's `connectionId`. */
  id: string;
  /** `Folder / Sub / Name` path, disambiguating equally-named connections. */
  label: string;
}

/** Build the `Folder / Sub / Name` path label for a connection. */
export function connectionPathLabel(
  connection: SavedConnection,
  folders: ConnectionFolder[]
): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [connection.name];
  let folderId = connection.folderId;
  // Walk parents to the root, guarding against malformed cycles.
  const seen = new Set<string>();
  while (folderId && !seen.has(folderId)) {
    seen.add(folderId);
    const folder = byId.get(folderId);
    if (!folder) break;
    parts.unshift(folder.name);
    folderId = folder.parentId;
  }
  return parts.join(" / ");
}

/**
 * SSH-type saved connections offered as jump-host hops, each labelled with its
 * folder path. `excludeId` drops the connection being edited so it cannot
 * reference itself.
 */
export function sshJumpHostOptions(
  connections: SavedConnection[],
  folders: ConnectionFolder[],
  excludeId?: string
): SavedConnectionOption[] {
  return connections
    .filter((c) => c.config.type === "ssh" && c.id !== excludeId)
    .map((c) => ({ id: c.id, label: connectionPathLabel(c, folders) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The SSH-schema field keys that make up an inline jump-host hop, in display
 * order. An inline hop *is* an SSH-style host, so it reuses the very fields the
 * SSH connection schema already declares — including the `authMethod` options
 * and the `keyPath`/`password` conditional visibility — rather than a bespoke,
 * drift-prone copy (UISF-014).
 */
const INLINE_HOP_FIELD_KEYS = [
  "host",
  "port",
  "username",
  "authMethod",
  "keyPath",
  "password",
] as const;

/**
 * Per-hop connect/handshake timeout (#951). This is jump-host-specific — the SSH
 * schema's own `connectTimeoutSecs` governs the *target*, not a hop — so it is
 * declared here as a schema field and rendered through the same schema-driven
 * `DynamicField` as every other hop field. Its `key` matches `JumpHostConfig`.
 */
export const JUMP_HOST_CONNECT_TIMEOUT_FIELD: SettingsField = {
  key: "connectTimeoutSecs",
  label: "Connect Timeout (s)",
  fieldType: { type: "number", min: 1, max: 300 },
  required: false,
  placeholder: "Default (45 s)",
};

/**
 * Build the ordered field list for an inline jump-host hop from the SSH
 * connection schema, so the hop editor renders the exact same host / port /
 * username / auth-method / key / password fields (labels, options, and
 * conditional visibility) as the primary SSH connection form — driven from one
 * schema, never hand-rolled. The per-hop connect-timeout field is appended.
 *
 * When no SSH schema is available yet (the connection-type registry is still
 * loading) only the connect-timeout field is returned; the schema-sourced
 * fields appear as soon as the registry resolves.
 */
export function jumpHostInlineFields(sshSchema: SettingsSchema | undefined): SettingsField[] {
  const byKey = new Map<string, SettingsField>();
  for (const group of sshSchema?.groups ?? []) {
    for (const field of group.fields) byKey.set(field.key, field);
  }
  const sourced = INLINE_HOP_FIELD_KEYS.map((key) => byKey.get(key)).filter(
    (field): field is SettingsField => field !== undefined
  );
  return [...sourced, JUMP_HOST_CONNECT_TIMEOUT_FIELD];
}
