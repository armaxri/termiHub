/**
 * Contract tests for the network-tool run-location table (#2191, PROD-033):
 * which tools may run on an agent, the backend key each routes under (these
 * mirror `agent_tools::tool` in `src-tauri/src/network/agent_tools.rs`), and
 * that every desktop-only tool explains why.
 */
import { describe, it, expect } from "vitest";
import type { NetworkTool } from "@/types/terminal";
import { NETWORK_TOOL_LOCATION } from "./networkToolLocation";

describe("NETWORK_TOOL_LOCATION", () => {
  it("routes every diagnostic tool the agent supports under its backend key", () => {
    const expected: Partial<Record<NetworkTool, string>> = {
      ping: "ping",
      traceroute: "traceroute",
      "port-scanner": "port_scan",
      "dns-lookup": "dns",
      wol: "wol",
      "ping-sweep": "ping_sweep",
      "open-ports": "open_ports",
    };
    for (const [tool, backendKey] of Object.entries(expected)) {
      const info = NETWORK_TOOL_LOCATION[tool as NetworkTool];
      expect(info.agentAllowed, tool).toBe(true);
      expect(info.backendKey, tool).toBe(backendKey);
      expect(info.agentUnavailableReason, tool).toBeUndefined();
    }
  });

  it("keeps only the HTTP monitor desktop-only on the per-tool selector", () => {
    const desktopOnly = Object.entries(NETWORK_TOOL_LOCATION)
      .filter(([, info]) => !info.agentAllowed)
      .map(([tool]) => tool);
    expect(desktopOnly).toEqual(["http-monitor"]);
  });

  it("gives every desktop-only tool a reason", () => {
    for (const [tool, info] of Object.entries(NETWORK_TOOL_LOCATION)) {
      if (!info.agentAllowed) {
        expect(info.agentUnavailableReason, tool).toBeTruthy();
      }
    }
  });
});
