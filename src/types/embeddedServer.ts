/** Protocol type for an embedded server. */
export type ServerType = "http" | "ftp" | "tftp";

/** Current lifecycle status of an embedded server. */
export type ServerStatus = "stopped" | "starting" | "running" | "stopping" | "error";

/**
 * FTP authentication configuration.
 *
 * `password` is write-only (#3514): the backend keeps it in the credential
 * store and always returns `""` here. Saving `""` keeps the stored password.
 */
export type FtpAuth =
  | { type: "anonymous" }
  | { type: "credentials"; username: string; password: string };

/**
 * Optional HTTP Basic authentication credentials for an embedded HTTP server
 * (PROD-0035). When set, the server challenges every request until matching
 * credentials are supplied; when absent, the directory is served
 * unauthenticated.
 *
 * `password` is write-only (#3514), exactly like {@link FtpAuth}'s.
 */
export interface HttpBasicAuth {
  username: string;
  password: string;
}

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
  /**
   * Optional HTTP Basic authentication (HTTP only, PROD-0035). Absent → the
   * directory is served unauthenticated, exactly as before this field existed.
   */
  httpAuth?: HttpBasicAuth;
  /**
   * Maximum size, in bytes, of a single file transfer. Currently enforced by
   * the (unauthenticated) TFTP server to bound per-transfer resource use.
   * Omitted falls back to the server's built-in default.
   */
  maxTransferBytes?: number;
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

/**
 * One recorded request / command / transfer in a server's access log
 * (PROD-034). Never carries a password, `Authorization` header or HTTP query
 * string.
 */
export interface AccessLogEntry {
  /** Monotonic sequence number (the incremental-read cursor). */
  seq: number;
  /** RFC 3339 completion time. */
  timestamp: string;
  /** Client IP address. */
  client?: string;
  /** Authenticated / attempted username (FTP login, HTTP Basic). */
  user?: string;
  /** HTTP method, FTP command (`LOGIN`, `RETR`, …) or TFTP `RRQ`/`WRQ`. */
  method: string;
  path?: string;
  /** HTTP status code, or `ok` / `denied` / `error` / `aborted` / `timeout` / `busy`. */
  status: string;
  success: boolean;
  /** Payload bytes transferred. */
  bytes: number;
  durationMs?: number;
  /** Short failure detail. */
  detail?: string;
}

/** A `key → hits` pair in a "top paths" / "top clients" list. */
export interface TopEntry {
  key: string;
  count: number;
}

/** A transfer currently in flight. */
export interface TransferInfo {
  id: number;
  method: string;
  client?: string;
  path?: string;
  bytes: number;
  startedAt: string;
}

/** Detailed per-server statistics (PROD-036). */
export interface DetailedServerStats extends ServerStats {
  /** Requests recorded since the log was last cleared. */
  totalRequests: number;
  /** Failed requests recorded since the log was last cleared. */
  errors: number;
  topPaths: TopEntry[];
  topClients: TopEntry[];
  currentTransfers: TransferInfo[];
}

/** Incremental access-log read returned by `get_embedded_server_activity`. */
export interface ServerActivity {
  /** Entries newer than the requested cursor, oldest first. */
  entries: AccessLogEntry[];
  /** Highest sequence number assigned so far — the next cursor. */
  latestSeq: number;
  /** Bumped on every clear; a changed epoch means "discard buffered entries". */
  epoch: number;
  /** Entries evicted from the bounded log since the last clear. */
  dropped: number;
  /** Maximum number of entries the log retains. */
  capacity: number;
  stats: DetailedServerStats;
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
