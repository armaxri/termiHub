import type { NetworkTool } from "@/types/terminal";

/** Run-location metadata for a network tool. */
export interface NetworkToolLocationInfo {
  /**
   * The backend tool key passed to `set_network_tool_run_location`, or `null`
   * for a tool with no agent-routable backend (it always runs on this
   * computer). The keys mirror `agent_tools::tool` in the Rust backend.
   */
  backendKey: string | null;
  /**
   * Whether an agent may run this tool. `false` for a desktop-only tool (Open
   * Design Decision #4) — the "Run on" selector then offers only "This
   * computer".
   */
  agentAllowed: boolean;
}

/**
 * Maps each frontend {@link NetworkTool} to its run-location behaviour (#2191).
 *
 * The five tools the agent exposes over `network.*` — ping, traceroute, port
 * scan, DNS, Wake-on-LAN — are agent-routable. The HTTP monitor is
 * desktop-only (the agent has no HTTP-monitor method). Ping sweep and
 * open-ports have no agent backend today, so they run on this computer only.
 */
export const NETWORK_TOOL_LOCATION: Record<NetworkTool, NetworkToolLocationInfo> = {
  ping: { backendKey: "ping", agentAllowed: true },
  traceroute: { backendKey: "traceroute", agentAllowed: true },
  "port-scanner": { backendKey: "port_scan", agentAllowed: true },
  "dns-lookup": { backendKey: "dns", agentAllowed: true },
  wol: { backendKey: "wol", agentAllowed: true },
  "http-monitor": { backendKey: "http_monitor", agentAllowed: false },
  "ping-sweep": { backendKey: null, agentAllowed: false },
  "open-ports": { backendKey: null, agentAllowed: false },
};
