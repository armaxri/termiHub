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
  /**
   * Why an agent is not offered, shown next to (and as the tooltip of) the
   * "Run on" selector when {@link agentAllowed} is `false`. Required for every
   * desktop-only tool so the disabled control never reads as a silent no-op.
   */
  agentUnavailableReason?: string;
}

/** Reason shown on the HTTP monitor tab's per-tool "Run on" selector. */
export const HTTP_MONITOR_AGENT_REASON =
  'Each HTTP monitor chooses its own run location — use the monitor\'s "Run on" field below.';

/**
 * Maps each frontend {@link NetworkTool} to its run-location behaviour (#2191).
 *
 * Every diagnostic tool can run on an agent (PROD-033): ping, traceroute, port
 * scan, DNS, Wake-on-LAN and open ports proxy to the agent's `network.*`
 * methods, and ping sweep runs through the agent's generic `tool.run`. The HTTP
 * monitor is the one exception on this per-tool selector: a monitor is hosted
 * on an agent **per monitor** (its own "Run on" field, via `service.*`), so the
 * tab-level selector stays on This computer and says why.
 */
export const NETWORK_TOOL_LOCATION: Record<NetworkTool, NetworkToolLocationInfo> = {
  ping: { backendKey: "ping", agentAllowed: true },
  traceroute: { backendKey: "traceroute", agentAllowed: true },
  "port-scanner": { backendKey: "port_scan", agentAllowed: true },
  "dns-lookup": { backendKey: "dns", agentAllowed: true },
  wol: { backendKey: "wol", agentAllowed: true },
  "http-monitor": {
    backendKey: "http_monitor",
    agentAllowed: false,
    agentUnavailableReason: HTTP_MONITOR_AGENT_REASON,
  },
  "ping-sweep": { backendKey: "ping_sweep", agentAllowed: true },
  "open-ports": { backendKey: "open_ports", agentAllowed: true },
};
