/**
 * A port field while it is being edited. Empty (`""`) represents a cleared
 * input — the shared `number | ""` blank-value convention (#1444) — which the
 * tunnel editor flags as required/invalid and blocks Save on, rather than
 * coercing to `0`. A persisted config always holds a real port number.
 */
export type PortValue = number | "";

/** Configuration for local port forwarding (ssh -L). */
export interface LocalForwardConfig {
  localHost: string;
  localPort: PortValue;
  remoteHost: string;
  remotePort: PortValue;
}

/** Configuration for remote port forwarding (ssh -R). */
export interface RemoteForwardConfig {
  remoteHost: string;
  remotePort: PortValue;
  localHost: string;
  localPort: PortValue;
}

/** Configuration for dynamic (SOCKS5) forwarding (ssh -D). */
export interface DynamicForwardConfig {
  localHost: string;
  localPort: PortValue;
}

/** Tagged union of tunnel types matching the Rust TunnelType enum. */
export type TunnelType =
  | { type: "local"; config: LocalForwardConfig }
  | { type: "remote"; config: RemoteForwardConfig }
  | { type: "dynamic"; config: DynamicForwardConfig };

/**
 * Where a capability (here: a tunnel's SSH client) runs — the S1 run-location
 * (#2148). Mirrors the Rust `RunLocation` enum's tagged serde shape
 * (`{ kind: "thisComputer" }` | `{ kind: "agent", agentId }`).
 */
export type RunLocation = { kind: "thisComputer" } | { kind: "agent"; agentId: string };

/** The desktop-host run-location — the default for a tunnel. */
export const THIS_COMPUTER: RunLocation = { kind: "thisComputer" };

/** A saved tunnel configuration. */
export interface TunnelConfig {
  id: string;
  name: string;
  sshConnectionId: string;
  tunnelType: TunnelType;
  /**
   * Which machine hosts (runs the SSH client for) this tunnel (S3, #2155).
   * Optional for backward compatibility: a config persisted before this field
   * existed, or a hand-built fixture, is treated as {@link THIS_COMPUTER}. The
   * Rust side defaults the field on load, so the projection always sends it.
   */
  host?: RunLocation;
  autoStart: boolean;
  reconnectOnDisconnect: boolean;
}

/** Current status of a tunnel. */
export type TunnelStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

/** Live traffic statistics for an active tunnel. */
export interface TunnelStats {
  bytesSent: number;
  bytesReceived: number;
  activeConnections: number;
  totalConnections: number;
}

/**
 * Who can reach an agent-hosted tunnel's listen socket, as the agent classified
 * its bind at runtime (mirrors the Rust `ReachableFrom` enum). `agentOnly` = a
 * loopback bind reachable only from processes on the agent; `agentLan` = a
 * widened bind reachable from the agent's network; `sshServer` = an `-R` remote
 * forward whose listen socket lives on the SSH server.
 */
export type ReachableFrom = "agentOnly" | "agentLan" | "sshServer";

/** Combined runtime state for a tunnel. */
export interface TunnelState {
  tunnelId: string;
  status: TunnelStatus;
  error?: string;
  stats: TunnelStats;
  /**
   * For an agent-hosted tunnel: the id of the agent forwarding it, confirmed by
   * the agent's report (S3, #2199). Absent for desktop-hosted tunnels. The UI
   * resolves it to a human agent name for the vantage badge.
   */
  boundOn?: string;
  /**
   * For an agent-hosted tunnel: the `host:port` the listen socket actually bound
   * (on the agent for -L/-D, on the SSH server for -R), reported by the agent.
   * Absent for desktop-hosted tunnels (#2199).
   */
  boundAddress?: string;
  /**
   * For an agent-hosted tunnel: who can reach the listen socket, from the
   * agent's runtime classification (#2199). Absent for desktop-hosted tunnels.
   */
  reachableFrom?: ReachableFrom;
}
