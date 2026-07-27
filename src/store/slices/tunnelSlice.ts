import { StateCreator } from "zustand";

import { toast } from "@/components/ui";
import {
  getTunnels,
  saveTunnel as apiSaveTunnel,
  deleteTunnel as apiDeleteTunnel,
  startTunnel as apiStartTunnel,
  stopTunnel as apiStopTunnel,
  getTunnelStatuses,
} from "@/services/tunnelApi";
import { TunnelConfig, TunnelState } from "@/types/tunnel";
import { frontendLog } from "@/utils/frontendLog";

import type { AppState } from "../appStore";

// In-flight guards for tunnel start/stop (GAP 4, #1141). A rapid double-click on
// Start/Stop for a tunnel that is already `connecting` must not fire a second
// backend call — that produces spurious "already active/connecting" error toasts
// and can flip the visible state. We track the id of each tunnel whose start/stop
// call has not yet resolved and no-op any re-entrant call for the same id.
const _tunnelStartInFlight = new Set<string>();
const _tunnelStopInFlight = new Set<string>();

/**
 * SSH tunnel domain slice (#2077): the tunnel config list, live tunnel states,
 * and the CRUD/lifecycle actions that drive them. Extracted verbatim from the
 * monolithic root store as a behavior-preserving Zustand slice — every action
 * still receives the shared `set`/`get` typed against the full {@link AppState},
 * so the public store shape and behavior are unchanged.
 *
 * Note: `openTunnelEditorTab` is intentionally NOT part of this slice — it is a
 * tab/panel action (it creates a tab via the root store's `createTab` factory)
 * and moves with the panel/tab slice when that domain is extracted.
 */
export interface TunnelSlice {
  tunnels: TunnelConfig[];
  tunnelStates: Record<string, TunnelState>;
  loadTunnels: () => Promise<void>;
  saveTunnel: (config: TunnelConfig) => Promise<void>;
  deleteTunnel: (tunnelId: string) => Promise<void>;
  startTunnel: (tunnelId: string) => Promise<void>;
  stopTunnel: (tunnelId: string) => Promise<void>;
  /** Force-reconnect a connected tunnel (stop + start), for a stale-but-green tunnel (#1243). */
  reconnectTunnel: (tunnelId: string) => Promise<void>;
  updateTunnelState: (state: TunnelState) => void;
}

export const createTunnelSlice: StateCreator<AppState, [], [], TunnelSlice> = (set, get) => ({
  tunnels: [],
  tunnelStates: {},

  loadTunnels: async () => {
    try {
      const tunnels = await getTunnels();
      const statuses = await getTunnelStatuses();
      const tunnelStates: Record<string, TunnelState> = {};
      for (const s of statuses) {
        tunnelStates[s.tunnelId] = s;
      }
      set({ tunnels, tunnelStates });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to load tunnels: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },

  saveTunnel: async (config) => {
    try {
      await apiSaveTunnel(config);
      set((state) => {
        const exists = state.tunnels.some((t) => t.id === config.id);
        const tunnels = exists
          ? state.tunnels.map((t) => (t.id === config.id ? config : t))
          : [...state.tunnels, config];
        return { tunnels };
      });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to save tunnel: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }
  },

  deleteTunnel: async (tunnelId) => {
    const name = get().tunnels.find((t) => t.id === tunnelId)?.name ?? "tunnel";
    const toastId = toast.loading(`Deleting ${name}…`);
    try {
      await apiDeleteTunnel(tunnelId);
      set((state) => ({
        tunnels: state.tunnels.filter((t) => t.id !== tunnelId),
        tunnelStates: Object.fromEntries(
          Object.entries(state.tunnelStates).filter(([k]) => k !== tunnelId)
        ),
      }));
      toast.success(`Deleted ${name}`, { id: toastId });
    } catch (err) {
      toast.error(`Failed to delete ${name}: ${err instanceof Error ? err.message : String(err)}`, {
        id: toastId,
      });
      throw err;
    }
  },

  startTunnel: async (tunnelId) => {
    // GAP 4 (#1141): ignore a re-entrant start while a prior start for the
    // same tunnel is still in flight, so a rapid double-click can't fire a
    // second backend call (spurious "already connecting/active" toast).
    if (_tunnelStartInFlight.has(tunnelId)) return;
    _tunnelStartInFlight.add(tunnelId);
    const name = get().tunnels.find((t) => t.id === tunnelId)?.name ?? "tunnel";
    const toastId = toast.loading(`Starting ${name}…`);
    try {
      await apiStartTunnel(tunnelId);
      toast.success(`Started ${name}`, { id: toastId });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to start tunnel: ${err instanceof Error ? err.message : String(err)}`
      );
      toast.error(`Failed to start ${name}: ${err instanceof Error ? err.message : String(err)}`, {
        id: toastId,
      });
      throw err;
    } finally {
      _tunnelStartInFlight.delete(tunnelId);
    }
  },

  stopTunnel: async (tunnelId) => {
    // GAP 4 (#1141): ignore a re-entrant stop while a prior stop for the same
    // tunnel is still in flight (see startTunnel).
    if (_tunnelStopInFlight.has(tunnelId)) return;
    _tunnelStopInFlight.add(tunnelId);
    const name = get().tunnels.find((t) => t.id === tunnelId)?.name ?? "tunnel";
    const toastId = toast.loading(`Stopping ${name}…`);
    try {
      await apiStopTunnel(tunnelId);
      toast.success(`Stopped ${name}`, { id: toastId });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to stop tunnel: ${err instanceof Error ? err.message : String(err)}`
      );
      toast.error(`Failed to stop ${name}: ${err instanceof Error ? err.message : String(err)}`, {
        id: toastId,
      });
      throw err;
    } finally {
      _tunnelStopInFlight.delete(tunnelId);
    }
  },

  reconnectTunnel: async (tunnelId) => {
    // Force-reconnect a connected tunnel: tear it down and start it again,
    // even if the backend supervisor's liveness has not fired yet — covers a
    // stale-but-green tunnel (#1243). Guarded by the same in-flight sets as
    // start/stop so a rapid double-click cannot overlap the sequence.
    if (_tunnelStartInFlight.has(tunnelId) || _tunnelStopInFlight.has(tunnelId)) return;
    _tunnelStopInFlight.add(tunnelId);
    _tunnelStartInFlight.add(tunnelId);
    const name = get().tunnels.find((t) => t.id === tunnelId)?.name ?? "tunnel";
    const toastId = toast.loading(`Reconnecting ${name}…`);
    try {
      await apiStopTunnel(tunnelId);
      await apiStartTunnel(tunnelId);
      toast.success(`Reconnected ${name}`, { id: toastId });
    } catch (err) {
      frontendLog(
        "app_store",
        `Failed to reconnect tunnel: ${err instanceof Error ? err.message : String(err)}`
      );
      toast.error(
        `Failed to reconnect ${name}: ${err instanceof Error ? err.message : String(err)}`,
        { id: toastId }
      );
      throw err;
    } finally {
      _tunnelStopInFlight.delete(tunnelId);
      _tunnelStartInFlight.delete(tunnelId);
    }
  },

  updateTunnelState: (state) => {
    set((s) => ({
      tunnelStates: { ...s.tunnelStates, [state.tunnelId]: state },
    }));
  },
});
