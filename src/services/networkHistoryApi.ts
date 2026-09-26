/**
 * Tauri command wrappers for the network-tool run history (PROD-032).
 *
 * The backend owns the store (`network-tool-history.json`) and enforces every
 * bound — per-tool count, age and per-run size — so these are thin wrappers.
 */

import { invoke } from "@tauri-apps/api/core";
import type { NetworkHistoryTool, NetworkToolRun } from "@/types/network";

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
