/**
 * Tauri command wrappers for built-in network diagnostic tools.
 *
 * Long-running operations (port scan, ping, traceroute) return a task ID.
 * Results arrive via Tauri events — use `listenNetworkEvent` helpers to
 * subscribe.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

import type {
  DnsRecordType,
  DnsResult,
  HttpCheckResult,
  HttpMonitorState,
  OpenPort,
  PortScanResult,
  PortScanSummary,
  WolDevice,
  PingResult,
  PingStats,
  TracerouteHop,
} from "@/types/network";

// ── Port Scanner ─────────────────────────────────────────────────────────────

/**
 * Start a port scan. Returns a task ID. Results stream via events:
 * - `network-scan-result` — individual port result
 * - `network-scan-complete` — scan finished
 * - `network-scan-error` — scan failed
 */
export async function networkPortScan(
  host: string,
  ports: string,
  timeoutMs?: number,
  concurrency?: number
): Promise<string> {
  return await invoke<string>("network_port_scan", {
    host,
    ports,
    timeoutMs: timeoutMs ?? null,
    concurrency: concurrency ?? null,
  });
}

/** Cancel an in-progress port scan by task ID. */
export async function networkPortScanCancel(taskId: string): Promise<void> {
  await invoke("network_port_scan_cancel", { taskId });
}

// ── Ping ─────────────────────────────────────────────────────────────────────

/**
 * Start a ping session. Returns a task ID. Results stream via events:
 * - `network-ping-result` — individual ping result
 * - `network-ping-complete` — session ended (with stats)
 * - `network-ping-error` — fatal error
 */
export async function networkPingStart(
  host: string,
  intervalMs?: number,
  count?: number
): Promise<string> {
  return await invoke<string>("network_ping_start", {
    host,
    intervalMs: intervalMs ?? null,
    count: count ?? null,
  });
}

/** Stop a running ping session. */
export async function networkPingStop(taskId: string): Promise<void> {
  await invoke("network_ping_stop", { taskId });
}

// ── DNS Lookup ───────────────────────────────────────────────────────────────

/** Perform a DNS lookup and return the records. */
export async function networkDnsLookup(
  hostname: string,
  recordType: DnsRecordType,
  server?: string
): Promise<DnsResult> {
  return await invoke<DnsResult>("network_dns_lookup", {
    hostname,
    recordType,
    server: server ?? null,
  });
}

// ── Open Ports ───────────────────────────────────────────────────────────────

/** List local listening ports. */
export async function networkOpenPorts(): Promise<OpenPort[]> {
  return await invoke<OpenPort[]>("network_open_ports");
}

// ── Traceroute ───────────────────────────────────────────────────────────────

/**
 * Start a traceroute. Returns a task ID. Results stream via events:
 * - `network-traceroute-hop` — single hop result
 * - `network-traceroute-complete` — trace finished
 * - `network-traceroute-error` — trace failed
 */
export async function networkTraceroute(host: string, maxHops?: number): Promise<string> {
  return await invoke<string>("network_traceroute", {
    host,
    maxHops: maxHops ?? null,
  });
}

/** Cancel a running traceroute. */
export async function networkTracerouteCancel(taskId: string): Promise<void> {
  await invoke("network_traceroute_cancel", { taskId });
}

// ── Wake-on-LAN ──────────────────────────────────────────────────────────────

/** Send a Wake-on-LAN magic packet. */
export async function networkWolSend(mac: string, broadcast: string, port: number): Promise<void> {
  await invoke("network_wol_send", { mac, broadcast, port });
}

/** List saved WoL devices. */
export async function networkWolDevicesList(): Promise<WolDevice[]> {
  return await invoke<WolDevice[]>("network_wol_devices_list");
}

/** Save (add or update) a WoL device. */
export async function networkWolDeviceSave(device: WolDevice): Promise<void> {
  await invoke("network_wol_device_save", { device });
}

/** Delete a saved WoL device. */
export async function networkWolDeviceDelete(deviceId: string): Promise<void> {
  await invoke("network_wol_device_delete", { deviceId });
}

// ── HTTP Monitor ─────────────────────────────────────────────────────────────

/** Start a new HTTP monitor. Returns the monitor ID. */
export async function networkHttpMonitorStart(
  url: string,
  intervalMs?: number,
  method?: string,
  expectedStatus?: number,
  timeoutMs?: number
): Promise<string> {
  return await invoke<string>("network_http_monitor_start", {
    url,
    intervalMs: intervalMs ?? null,
    method: method ?? null,
    expectedStatus: expectedStatus ?? null,
    timeoutMs: timeoutMs ?? null,
  });
}

/** Stop a running HTTP monitor. */
export async function networkHttpMonitorStop(monitorId: string): Promise<void> {
  await invoke("network_http_monitor_stop", { monitorId });
}

/** List all HTTP monitors and their current state. */
export async function networkHttpMonitorList(): Promise<HttpMonitorState[]> {
  return await invoke<HttpMonitorState[]>("network_http_monitor_list");
}

// ── Event listeners ───────────────────────────────────────────────────────────

/** Listen for port scan result events. */
export function onScanResult(
  cb: (payload: { taskId: string } & PortScanResult) => void
): Promise<UnlistenFn> {
  return listen<{ taskId: string } & PortScanResult>("network-scan-result", (e) => cb(e.payload));
}

/** Listen for port scan complete events. */
export function onScanComplete(
  cb: (payload: { taskId: string; summary: PortScanSummary }) => void
): Promise<UnlistenFn> {
  return listen<{ taskId: string; summary: PortScanSummary }>("network-scan-complete", (e) =>
    cb(e.payload)
  );
}

/** Listen for ping result events. */
export function onPingResult(
  cb: (payload: { taskId: string; result: PingResult }) => void
): Promise<UnlistenFn> {
  return listen<{ taskId: string; result: PingResult }>("network-ping-result", (e) =>
    cb(e.payload)
  );
}

/** Listen for ping session complete events. */
export function onPingComplete(
  cb: (payload: { taskId: string; stats: PingStats; canceled: boolean }) => void
): Promise<UnlistenFn> {
  return listen<{ taskId: string; stats: PingStats; canceled: boolean }>(
    "network-ping-complete",
    (e) => cb(e.payload)
  );
}

/** Listen for traceroute hop events. */
export function onTracerouteHop(
  cb: (payload: { taskId: string; hop: TracerouteHop }) => void
): Promise<UnlistenFn> {
  return listen<{ taskId: string; hop: TracerouteHop }>("network-traceroute-hop", (e) =>
    cb(e.payload)
  );
}

/** Listen for traceroute complete events. */
export function onTracerouteComplete(
  cb: (payload: { taskId: string }) => void
): Promise<UnlistenFn> {
  return listen<{ taskId: string }>("network-traceroute-complete", (e) => cb(e.payload));
}

/** Listen for HTTP monitor check events. */
export function onHttpMonitorCheck(cb: (payload: HttpCheckResult) => void): Promise<UnlistenFn> {
  return listen<HttpCheckResult>("network-http-monitor-check", (e) => cb(e.payload));
}
