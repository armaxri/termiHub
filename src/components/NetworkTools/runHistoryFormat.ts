/** Display helpers shared by the network-tool run-history views (PROD-032). */

import type { NetworkHistoryTool, NetworkRunStatus, NetworkToolRun } from "@/types/network";
import { resolveUiLocale } from "@/utils/locale";

/** Human label per recorded tool. */
export const TOOL_LABEL: Record<NetworkHistoryTool, string> = {
  ping: "Ping",
  traceroute: "Traceroute",
  "port-scanner": "Port scan",
  "ping-sweep": "Ping sweep",
  "dns-lookup": "DNS lookup",
  "open-ports": "Open ports",
  wol: "Wake-on-LAN",
};

/** Human label per run status. */
export const RUN_STATUS_LABEL: Record<NetworkRunStatus, string> = {
  completed: "Completed",
  canceled: "Canceled",
  error: "Failed",
};

/** Format an RFC 3339 timestamp for display (falls back to the raw string). */
export function formatRunTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(resolveUiLocale(), {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

/** "This computer" or "Agent · <name>" for a recorded run location. */
export function runLocationLabel(
  location: NetworkToolRun["runLocation"],
  agentNames: Record<string, string>
): string {
  if (location.kind !== "agent") return "This computer";
  return `Agent · ${agentNames[location.agentId] ?? location.agentId}`;
}
