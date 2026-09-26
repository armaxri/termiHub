/**
 * UI mirror of the network-tool run history (PROD-032).
 *
 * The backend owns the persisted, bounded store (`network-tool-history.json`);
 * this Zustand store only caches the newest-first list for the history views
 * and routes record/delete/clear through the backend commands. Recording is
 * fire-and-forget — a failed write is logged, never surfaced as a tool error —
 * and is skipped entirely while the `networkToolHistoryEnabled` setting is off.
 */

import { create } from "zustand";
import {
  clearNetworkToolHistory,
  deleteNetworkToolRun,
  listNetworkToolRuns,
  recordNetworkToolRun,
} from "@/services/networkHistoryApi";
import { currentSettingsView } from "@/store/settingsBridge";
import type { NetworkHistoryTool, NetworkToolRun } from "@/types/network";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

interface NetworkToolHistoryState {
  /** Every recorded run, newest first. */
  runs: NetworkToolRun[];
  /** True once the list has been fetched from the backend. */
  loaded: boolean;
  /** Fetch the full list from the backend. */
  load: () => Promise<void>;
  /** Record a finished run (no-op while history is disabled in settings). */
  record: (run: NetworkToolRun) => Promise<void>;
  /** Delete one run. Rejects on failure so the caller can show an error. */
  remove: (id: string) => Promise<void>;
  /** Clear one tool's runs, or every run when `tool` is omitted. */
  clear: (tool?: NetworkHistoryTool) => Promise<void>;
}

/** Whether recording is enabled (defaults to on when the setting is unset). */
export function isNetworkToolHistoryEnabled(): boolean {
  return currentSettingsView().networkToolHistoryEnabled !== false;
}

export const useNetworkToolHistoryStore = create<NetworkToolHistoryState>((set) => ({
  runs: [],
  loaded: false,

  load: async () => {
    try {
      const runs = await listNetworkToolRuns();
      set({ runs: Array.isArray(runs) ? runs : [], loaded: true });
    } catch (err) {
      frontendLog("network_history", `Failed to load run history: ${errorMessage(err)}`);
      set({ loaded: true });
    }
  },

  record: async (run) => {
    if (!isNetworkToolHistoryEnabled()) return;
    try {
      const stored = (await recordNetworkToolRun(run)) ?? run;
      set((s) => ({ runs: [stored, ...s.runs.filter((r) => r.id !== stored.id)] }));
    } catch (err) {
      frontendLog("network_history", `Failed to record ${run.tool} run: ${errorMessage(err)}`);
    }
  },

  remove: async (id) => {
    await deleteNetworkToolRun(id);
    set((s) => ({ runs: s.runs.filter((r) => r.id !== id) }));
  },

  clear: async (tool) => {
    await clearNetworkToolHistory(tool);
    set((s) => ({ runs: tool ? s.runs.filter((r) => r.tool !== tool) : [] }));
  },
}));
