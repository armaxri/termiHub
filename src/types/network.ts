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
