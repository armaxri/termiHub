/**
 * Tunnel **chaining** helpers — "Chain a hop to this computer" (#2597).
 *
 * An agent-hosted `-L`/`-D` forward bound to loopback opens its listen port on
 * the *agent's* `127.0.0.1`, so the desktop's `localhost:PORT` reaches nothing.
 * Chaining creates a **companion** desktop-hosted `-L` forward whose SSH server
 * is the agent's own host and whose target is the parent's loopback listen port,
 * restoring plain `localhost:PORT` on the desktop with zero new LAN exposure.
 *
 * These pure functions (no store, no React) derive the companion config, walk
 * the parent↔companion link, and fold the two live statuses into the single
 * "Linked · …" status the UI renders — so the components stay thin and the logic
 * unit-tests directly, mirroring the style of {@link import("./tunnelHost")}.
 * The combined status is derived in the frontend per the concept's Open Design
 * Decision #3 (no region schema change).
 */

import type { PortValue, TunnelConfig, TunnelStatus } from "@/types/tunnel";
import { THIS_COMPUTER } from "@/types/tunnel";

/** The loopback listen endpoint (`host:port`) a parent forward exposes on its host. */
interface ListenEndpoint {
  host: string;
  port: PortValue;
}

/**
 * The listen endpoint a parent forward binds on its host — the socket the
 * companion must reach. For `-L`/`-D` this is the local bind (`localHost` /
 * `localPort`); a `-R` remote forward is never chained (its listen socket lives
 * on the SSH server, not the agent), so it falls back to the same fields for
 * totality but is not offered chaining by the UI.
 */
function parentListenEndpoint(parent: TunnelConfig): ListenEndpoint {
  const t = parent.tunnelType;
  switch (t.type) {
    case "local":
    case "dynamic":
      return { host: t.config.localHost, port: t.config.localPort };
    case "remote":
      return { host: t.config.localHost, port: t.config.localPort };
  }
}

/**
 * The deterministic id of the companion derived for `parentId`. Deterministic so
 * chaining is idempotent per parent — deriving twice yields the same id, never a
 * duplicate companion.
 */
export function companionIdFor(parentId: string): string {
  return `${parentId}-hop`;
}

/**
 * Derive the companion {@link TunnelConfig} for an agent-hosted loopback parent.
 *
 * The companion is a **desktop-hosted** (`ThisComputer`) local (`-L`) forward,
 * regardless of the parent's mode, whose SSH server is the agent's own SSH
 * connection (`agentSshConnectionId`, derived by the caller — the agent is
 * already SSH-reachable) and whose target is the parent's loopback listen
 * `host:port`. Its local bind reuses the parent's port to preserve the
 * `localhost:PORT` promise. The `companionOf` link binds it to its parent.
 *
 * @param parent - the agent-hosted loopback forward being chained.
 * @param agentSshConnectionId - the saved SSH connection that reaches the agent.
 */
export function deriveCompanion(parent: TunnelConfig, agentSshConnectionId: string): TunnelConfig {
  const listen = parentListenEndpoint(parent);
  return {
    id: companionIdFor(parent.id),
    name: `${parent.name} (hop on this computer)`,
    sshConnectionId: agentSshConnectionId,
    tunnelType: {
      type: "local",
      config: {
        // The companion listens on the desktop loopback at the parent's port, so
        // `localhost:PORT` works locally...
        localHost: "127.0.0.1",
        localPort: listen.port,
        // ...and forwards, over the agent's SSH connection, to the parent's
        // loopback listen socket on the agent.
        remoteHost: listen.host,
        remotePort: listen.port,
      },
    },
    host: THIS_COMPUTER,
    autoStart: false,
    // The pair's ordered lifecycle drives the companion from the parent; it also
    // inherits the parent's own reconnect preference for its desktop→agent hop.
    reconnectOnDisconnect: parent.reconnectOnDisconnect,
    companionOf: parent.id,
  };
}

/** Whether a config is a chained companion (the desktop hop), not a parent. */
export function isCompanion(config: TunnelConfig): boolean {
  return config.companionOf != null;
}

/** The companion linked to `parentId`, if a chained desktop hop exists for it. */
export function findCompanion(tunnels: TunnelConfig[], parentId: string): TunnelConfig | undefined {
  return tunnels.find((t) => t.companionOf === parentId);
}

/** The parent a companion is linked to, if `config` is a companion and it exists. */
export function findParent(
  tunnels: TunnelConfig[],
  config: TunnelConfig
): TunnelConfig | undefined {
  return config.companionOf ? tunnels.find((t) => t.id === config.companionOf) : undefined;
}

/**
 * The combined status of a chained pair — the single value the UI shows so the
 * user reasons about "does `localhost:PORT` work?" rather than juggling two rows.
 *
 * - `none` — the parent has no companion (render the plain single-tunnel status).
 * - `connected` — parent + companion both connected; `localhost:PORT` works.
 * - `connecting` — parent connected, companion still coming up (almost there).
 * - `degraded` — parent connected but companion down; the agent port works,
 *   `localhost` does not (offer Retry / a different local port).
 * - `down` — the parent itself is not connected; the companion is held down.
 */
export type PairStatus = "none" | "connected" | "connecting" | "degraded" | "down";

/**
 * Fold the parent and companion {@link TunnelStatus} into a {@link PairStatus}.
 * `hasCompanion` is `false` when the parent is unchained, yielding `none`.
 */
export function combinedPairStatus(
  parentStatus: TunnelStatus,
  companionStatus: TunnelStatus,
  hasCompanion: boolean
): PairStatus {
  if (!hasCompanion) return "none";
  // The parent must be connected for the companion to carry traffic; otherwise
  // the whole pair is down (the companion is held down behind its parent).
  if (parentStatus !== "connected") return "down";
  switch (companionStatus) {
    case "connected":
      return "connected";
    case "connecting":
    case "reconnecting":
      return "connecting";
    default:
      // disconnected / error while the parent is up → localhost is broken.
      return "degraded";
  }
}
