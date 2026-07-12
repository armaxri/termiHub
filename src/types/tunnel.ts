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

/** A saved tunnel configuration. */
export interface TunnelConfig {
  id: string;
  name: string;
  sshConnectionId: string;
  tunnelType: TunnelType;
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

/** Combined runtime state for a tunnel. */
export interface TunnelState {
  tunnelId: string;
  status: TunnelStatus;
  error?: string;
  stats: TunnelStats;
}
