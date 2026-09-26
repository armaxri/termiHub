/**
 * TypeScript types for built-in network diagnostic tools.
 * Mirror the Rust types in `core/src/network/types.rs`.
 */

// ── Port Scanner ─────────────────────────────────────────────────────────────

export type PortState = "open" | "closed" | "filtered";

export interface PortScanResult {
  host: string;
  port: number;
  state: PortState;
  latencyMs?: number;
}

export interface PortScanSummary {
  total: number;
  open: number;
  closed: number;
  filtered: number;
  elapsedMs: number;
}

// ── Ping ─────────────────────────────────────────────────────────────────────

export interface PingResult {
  seq: number;
  latencyMs?: number;
  ttl?: number;
  timedOut: boolean;
  tcpFallback: boolean;
}

export interface PingStats {
  sent: number;
  received: number;
  lossPercent: number;
  minMs: number;
  avgMs: number;
  maxMs: number;
  jitterMs: number;
}

// ── Ping Sweep ─────────────────────────────────────────────────────────────────

/** A host that responded during a subnet / IP-range ping sweep. */
export interface PingSweepResult {
  /** The probed address (an IP string, or the original hostname token). */
  host: string;
  latencyMs?: number;
  /** Best-effort reverse-DNS hostname for the address, if resolvable. */
  hostname?: string;
}

/** Summary emitted when a ping sweep completes. */
export interface PingSweepSummary {
  total: number;
  up: number;
  down: number;
  elapsedMs: number;
}

// ── DNS Lookup ───────────────────────────────────────────────────────────────

export type DnsRecordType =
  | "A"
  | "AAAA"
  | "MX"
  | "CNAME"
  | "NS"
  | "TXT"
  | "SRV"
  | "SOA"
  | "PTR"
  | "ANY";

export interface DnsRecord {
  recordType: DnsRecordType;
  name: string;
  value: string;
  ttl: number;
}

export interface DnsResult {
  records: DnsRecord[];
  queryMs: number;
}

// ── Traceroute ───────────────────────────────────────────────────────────────

export interface TracerouteHop {
  hop: number;
  host?: string;
  ip?: string;
  rttMs: [number | null, number | null, number | null];
}

// ── Open Ports ───────────────────────────────────────────────────────────────

export type PortProtocol = "TCP" | "UDP";

export interface OpenPort {
  protocol: PortProtocol;
  localAddr: string;
  pid?: number;
  process?: string;
}

// ── Wake-on-LAN ──────────────────────────────────────────────────────────────

export interface WolDevice {
  id: string;
  name: string;
  mac: string;
  broadcast: string;
  port: number;
}

// ── HTTP Monitor ─────────────────────────────────────────────────────────────

export interface HttpMonitorConfig {
  id: string;
  url: string;
  intervalMs: number;
  method: string;
  expectedStatus: number;
  timeoutMs: number;
  /**
   * Opt-in escape hatch for monitoring an internal host (SEC-008). When `true`,
   * the monitor may reach RFC 1918 private / IPv6 unique-local addresses;
   * loopback, link-local (incl. `169.254.169.254`), and the unspecified address
   * stay blocked regardless. Defaults to `false` (deny-internal) when omitted.
   */
  allowPrivateNetwork?: boolean;
}

export interface HttpCheckResult {
  monitorId: string;
  statusCode?: number;
  latencyMs?: number;
  ok: boolean;
  error?: string;
  timestampMs: number;
}

export interface HttpMonitorState {
  config: HttpMonitorConfig;
  /** The poll loop is alive (`false` = stopped-but-listed). */
  running: boolean;
  /** The loop is alive but its poll body is suspended (implies `running`). */
  paused: boolean;
  lastResult?: HttpCheckResult;
}

// ── Tool states (frontend-only) ───────────────────────────────────────────────

export type DiagnosticStatus = "idle" | "running" | "completed" | "canceled" | "error";

// ── Run history (PROD-032) ───────────────────────────────────────────────────

/** A network tool whose finished runs are recorded to the run history. */
export type NetworkHistoryTool =
  | "ping"
  | "traceroute"
  | "port-scanner"
  | "ping-sweep"
  | "dns-lookup"
  | "open-ports"
  | "wol";

/** How a recorded run ended. */
export type NetworkRunStatus = "completed" | "canceled" | "error";

/** A plain CSV-cell value stored in a recorded result table. */
export type NetworkRunCell = string | number | boolean | null;

/** A run's results as a table — the same columns as the tool's CSV export. */
export interface NetworkRunResult {
  columns: string[];
  rows: NetworkRunCell[][];
  /** Rows the run produced; more than `rows.length` when trimmed to the size cap. */
  totalRows: number;
}

/**
 * One recorded network-tool run. Mirrors the Rust `NetworkToolRun`
 * (`src-tauri/src/network/tool_history.rs`).
 */
export interface NetworkToolRun {
  id: string;
  tool: NetworkHistoryTool;
  /** The tool's input parameters, enough to re-run it. */
  params: Record<string, string | number | boolean | null>;
  runLocation: { kind: "thisComputer" } | { kind: "agent"; agentId: string };
  /** RFC 3339 start time. */
  startedAt: string;
  /** RFC 3339 end time. */
  endedAt: string;
  status: NetworkRunStatus;
  summary: string;
  error?: string;
  result?: NetworkRunResult;
}
