/**
 * Session store for per-item run-location selections (#2191).
 *
 * The desktop backend records each item's run-location preference in memory
 * (`set_network_tool_run_location` / `set_embedded_server_run_location`) and
 * exposes no getter — an item with no recorded preference runs on This
 * computer, the default. This store mirrors the chosen value UI-side so the
 * selector reflects the current vantage across tab open/close and re-renders
 * within a session. It is deliberately not persisted to disk: like the backend
 * map, it resets to the This-computer default on relaunch.
 */

import { create } from "zustand";
import type { RunLocation } from "@/types/tunnel";

interface RunLocationState {
  /** Per-network-tool run-location, keyed by the frontend `NetworkTool` id. */
  networkToolLocations: Record<string, RunLocation>;
  /** Per-embedded-server run-location, keyed by server id. */
  serverLocations: Record<string, RunLocation>;
  /** Per-HTTP-monitor run-location, keyed by monitor id (#2592). */
  monitorLocations: Record<string, RunLocation>;
  /** Per-system-monitor run-location, keyed by the monitor key = owning
   * terminal session id (#2593). */
  systemMonitorLocations: Record<string, RunLocation>;
  /** Record a network tool's chosen run-location. */
  setNetworkToolLocation: (tool: string, location: RunLocation) => void;
  /** Record an embedded server's chosen run-location. */
  setServerLocation: (serverId: string, location: RunLocation) => void;
  /** Record an HTTP monitor's chosen run-location. */
  setMonitorLocation: (monitorId: string, location: RunLocation) => void;
  /** Record a system monitor's chosen run-location. */
  setSystemMonitorLocation: (monitorKey: string, location: RunLocation) => void;
}

export const useRunLocationStore = create<RunLocationState>((set) => ({
  networkToolLocations: {},
  serverLocations: {},
  monitorLocations: {},
  systemMonitorLocations: {},
  setNetworkToolLocation: (tool, location) =>
    set((s) => ({ networkToolLocations: { ...s.networkToolLocations, [tool]: location } })),
  setServerLocation: (serverId, location) =>
    set((s) => ({ serverLocations: { ...s.serverLocations, [serverId]: location } })),
  setMonitorLocation: (monitorId, location) =>
    set((s) => ({ monitorLocations: { ...s.monitorLocations, [monitorId]: location } })),
  setSystemMonitorLocation: (monitorKey, location) =>
    set((s) => ({
      systemMonitorLocations: { ...s.systemMonitorLocations, [monitorKey]: location },
    })),
}));
