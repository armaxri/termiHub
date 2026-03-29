/** Protocol type for an embedded server. */
export type ServerType = "http" | "ftp" | "tftp";

/** Current lifecycle status of an embedded server. */
export type ServerStatus = "stopped" | "starting" | "running" | "stopping" | "error";

/** FTP authentication configuration. */
export type FtpAuth =
  | { type: "anonymous" }
  | { type: "credentials"; username: string; password: string };

/** Persistent configuration for a single embedded server. */
export interface EmbeddedServerConfig {
  id: string;
  name: string;
  serverType: ServerType;
  rootDirectory: string;
  bindHost: string;
  port: number;
  autoStart: boolean;
  readOnly: boolean;
  directoryListing?: boolean;
  ftpAuth?: FtpAuth;
}

/** Live traffic statistics for a running server. */
export interface ServerStats {
  activeConnections: number;
  totalConnections: number;
  bytesSent: number;
  bytesReceived: number;
}

/** Runtime state snapshot for a server (returned by IPC). */
export interface ServerState {
  serverId: string;
  status: ServerStatus;
  error?: string;
  stats: ServerStats;
  startedAt?: string;
}

/** Default ports per protocol. */
export const DEFAULT_PORTS: Record<ServerType, number> = {
  http: 8080,
  ftp: 2121,
  tftp: 6969,
};

/** Protocol display labels. */
export const PROTOCOL_LABELS: Record<ServerType, string> = {
  http: "HTTP",
  ftp: "FTP",
  tftp: "TFTP",
};

/** A local network interface returned by the backend for the bind-address dropdown. */
export interface NetworkInterface {
  /** Human-readable name, e.g. "en0", "eth0", "Loopback", "All Interfaces". */
  name: string;
  /** IPv4 address string, e.g. "127.0.0.1", "192.168.1.5", "0.0.0.0". */
  addr: string;
}
