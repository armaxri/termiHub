/**
 * Tauri command wrappers for the network-tool run history (PROD-032) and the
 * HTTP monitor check history (#3462).
 *
 * The backend owns the stores (`network-tool-history.json`,
 * `http-monitor-history.json`) and enforces every bound — per-tool / per-monitor
 * count, age and size — so these are thin wrappers.
 */

import { invoke } from "@tauri-apps/api/core";
import type { HttpCheckResult, NetworkHistoryTool, NetworkToolRun } from "@/types/network";

/** List recorded runs newest-first — for one tool, or every tool when omitted. */
export async function listNetworkToolRuns(tool?: NetworkHistoryTool): Promise<NetworkToolRun[]> {
  return await invoke<NetworkToolRun[]>("list_network_tool_runs", { tool: tool ?? null });
}

/** Record a finished run. Resolves to the record as stored (possibly trimmed). */
export async function recordNetworkToolRun(run: NetworkToolRun): Promise<NetworkToolRun> {
  return await invoke<NetworkToolRun>("record_network_tool_run", { run });
}

/** Delete one recorded run. */
export async function deleteNetworkToolRun(id: string): Promise<void> {
  await invoke("delete_network_tool_run", { id });
}

/** Clear the history for one tool, or for every tool when omitted. */
export async function clearNetworkToolHistory(tool?: NetworkHistoryTool): Promise<void> {
  await invoke("clear_network_tool_history", { tool: tool ?? null });
}

// ── HTTP monitor check history (#3462) ───────────────────────────────────────

/**
 * A monitor's recorded checks, oldest first. With `limit`, only the newest
 * `limit` checks (the chart window); without it, the whole stored series.
 */
export async function listHttpMonitorChecks(
  monitorId: string,
  limit?: number
): Promise<HttpCheckResult[]> {
  return await invoke<HttpCheckResult[]>("list_http_monitor_checks", {
    monitorId,
    limit: limit ?? null,
  });
}

/** Clear one monitor's check history, or every monitor's when omitted. */
export async function clearHttpMonitorHistory(monitorId?: string): Promise<void> {
  await invoke("clear_http_monitor_history", { monitorId: monitorId ?? null });
}
