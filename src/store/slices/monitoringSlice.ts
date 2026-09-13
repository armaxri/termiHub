import { StateCreator } from "zustand";

import {
  sessionMonitoringOpen,
  sessionMonitoringClose,
  sessionMonitoringSetPaused,
  sessionMonitoringSetInterval,
  sessionMonitoringCancel,
} from "@/services/api";
import { useRunLocationStore } from "@/store/runLocationStore";
import {
  currentMonitorsView,
  dispatchMonitorIntentBestEffort,
  ensureMonitorsSubscribed,
} from "@/store/systemMonitorBridge";
import { DEFAULT_MONITORING_INTERVAL_MS } from "@/types/monitoring";
import { frontendLog } from "@/utils/frontendLog";
import { THIS_COMPUTER, type RunLocation } from "@/utils/runLocation";

import type { AppState } from "../appStore";

/**
 * System-monitoring domain slice — a cut of the appStore god-module split
 * (ARCH-001 / FES-011), following the first slices PR #2880 (file-browser) and
 * PR #2890 (transfers).
 *
 * The per-host/session monitoring state (the `monitors` map + stats cache) does
 * NOT live here (#2224, audit gap G6, #1231): it is owned by the backend
 * `SystemMonitorStore` and projected through the authoritative `system-monitors`
 * region. Readers source it from the region via
 * {@link import("../useProjectedMonitors").useProjectedMonitors} (components) or
 * {@link import("../systemMonitorBridge").currentMonitorsView} (store-side). The
 * lifecycle actions below drive the backend commands, which fold the transitions
 * at the source; the few client-originated transitions with no backend command
 * dispatch a `monitor.*` intent against the region directly.
 *
 * The only local state carried here is {@link MonitoringSlice.sessionCapabilities}
 * — the per-session `{ monitoring, fileBrowser }` capability probe fetched after
 * session creation, which the status bar reads to gate its monitoring controls.
 */
export interface MonitoringSlice {
  /**
   * Subscribe the terminal session `sessionId` to its `MonitoringProvider` push
   * path, keying the entry by `sessionId`. `host` is the human-readable label
   * shown in the status bar. All monitors — desktop-direct SSH and
   * remote-session alike — flow through this single path (#1232). The backend
   * owns entry creation and the connect outcome (#2224); this action calls the
   * `session_monitoring_open` command and the region reflects the result.
   */
  connectMonitoring: (
    sessionId: string,
    host?: string | null,
    runLocation?: RunLocation
  ) => Promise<void>;
  /** Disconnect one monitor by key, or every monitor when `key` is omitted. */
  disconnectMonitoring: (key?: string) => Promise<void>;
  /** Clear a lingering error on one entry so a stale tooltip cannot persist (audit gap G9). */
  clearMonitoringError: (key: string) => void;
  /**
   * Pause or resume one monitor (#1233). Signals the backend session monitoring
   * loop to stop/resume collecting; the transport stays open either way.
   */
  setMonitoringPaused: (key: string, paused: boolean) => Promise<void>;
  /**
   * Change one monitor's refresh interval in milliseconds (#1233), reconfiguring
   * the backend session monitoring loop cadence.
   */
  setMonitoringInterval: (key: string, intervalMs: number) => Promise<void>;
  /**
   * Cancel a monitor that is still connecting (#1233). Aborts the backend connect
   * and tears the entry down so the picker/Retry is reachable again.
   */
  cancelMonitoring: (key: string) => Promise<void>;
  /** Per-session capabilities fetched after session creation (keyed by sessionId). */
  sessionCapabilities: Record<string, { monitoring: boolean; fileBrowser: boolean }>;
  setSessionCapabilities: (
    sessionId: string,
    caps: { monitoring: boolean; fileBrowser: boolean }
  ) => void;
}

export const createMonitoringSlice: StateCreator<AppState, [], [], MonitoringSlice> = (
  set,
  get
) => ({
  // Monitoring — state lives in the authoritative `system-monitors` region
  // (#2224), not here (audit gap G6, #1231).
  sessionCapabilities: {},

  clearMonitoringError: (key) => {
    const entry = currentMonitorsView().monitors[key];
    if (!entry || entry.error == null) return;
    // Region-authoritative (#2224): dismissing an error banner is a
    // client-originated action with no backend command, so dispatch the intent
    // against the region directly; the diff clears the entry's error.
    dispatchMonitorIntentBestEffort("monitor.clearError", { key });
  },

  setSessionCapabilities: (sessionId, caps) =>
    set((state) => ({
      sessionCapabilities: { ...state.sessionCapabilities, [sessionId]: caps },
    })),

  connectMonitoring: async (
    sessionId: string,
    host: string | null = null,
    runLocation?: RunLocation
  ) => {
    // Unified session-based (push) monitoring: the key is the id of the terminal
    // session that owns the monitor. The backend owns the entry lifecycle in the
    // authoritative `system-monitors` region (#2224): the `session_monitoring_open`
    // command folds `open` (connecting, priming any cached stats from the store),
    // then the connect outcome `opened` / `openFailed` — all server-side. The
    // collector loop folds every subsequent stats/status sample (#2376). No
    // client-side entry, no event listeners, no `appStore` writes.
    const key = sessionId;

    // Ensure the region subscription is live so the connecting / opened / failed
    // diffs reach the UI (the status bar mounts it too, but a connect can race
    // that mount). Non-Tauri / no socket just leaves the UI on the empty view.
    void ensureMonitorsSubscribed().catch(() => {});

    // Preserve a previously-chosen refresh interval across a reconnect so the
    // user's rate selection is not silently reset (#1233), sourced from the
    // authoritative region.
    const intervalMs =
      currentMonitorsView().monitors[key]?.intervalMs ?? DEFAULT_MONITORING_INTERVAL_MS;

    // A rejection means the backend recorded `openFailed` in the region (the
    // command's error branch folds it), so the UI already shows the error
    // without any client write. Propagate so callers — the status bar
    // auto-connect latch and the Open Connections retry toast — can react.
    // Route the subscription to the chosen execution host (#2593): omitted or
    // This computer keeps the session's own provider (unchanged); an agent
    // choice hosts the monitor on that agent. Falls back to any recorded
    // preference so a reconnect keeps the chosen vantage.
    const location =
      runLocation ?? useRunLocationStore.getState().systemMonitorLocations[key] ?? THIS_COMPUTER;
    await sessionMonitoringOpen(key, host ?? key, intervalMs, location);
  },

  disconnectMonitoring: async (key) => {
    // Kill exactly one entry when a key is given, or every entry otherwise
    // (Open Connections "Kill All", global toggle-off). The current set is read
    // from the authoritative region (#2224).
    const monitors = currentMonitorsView().monitors;
    const keys = key !== undefined ? [key] : Object.keys(monitors);

    for (const k of keys) {
      const entry = monitors[k];
      if (entry?.monitorSessionId) {
        // A live monitor: the `session_monitoring_close` command tears down the
        // provider subscription and folds `close` into the region server-side
        // (retaining the stats cache for an instant reconnect). Ignore close
        // errors — the entry is torn down regardless.
        try {
          await sessionMonitoringClose(entry.monitorSessionId);
        } catch {
          // Ignore — torn down regardless.
        }
      } else {
        // A still-connecting or failed entry has no backend session to close, so
        // drop it from the region directly (a client-originated teardown).
        dispatchMonitorIntentBestEffort("monitor.close", { key: k });
      }
    }
  },

  setMonitoringPaused: async (key, paused) => {
    const entry = currentMonitorsView().monitors[key];
    if (!entry) return;
    if (entry.monitorSessionId) {
      // The backend session loop is authoritative: the `session_monitoring_set_paused`
      // command folds the pause/resume into the region at the source (#2224), and
      // the collector loop also emits the authoritative `paused`/`live` status.
      // A failure folds nothing, so the region stays live — the caller re-throws
      // to surface the error toast.
      await sessionMonitoringSetPaused(entry.monitorSessionId, paused);
    } else {
      // No backend session (a still-connecting entry): reflect the pause in the
      // region directly.
      dispatchMonitorIntentBestEffort("monitor.setPaused", { key, paused });
    }
  },

  setMonitoringInterval: async (key, intervalMs) => {
    const entry = currentMonitorsView().monitors[key];
    if (!entry) return;
    if (entry.monitorSessionId) {
      // The `session_monitoring_set_interval` command reconfigures the backend
      // loop cadence and folds the new interval into the region (#2224).
      await sessionMonitoringSetInterval(entry.monitorSessionId, intervalMs);
    } else {
      // No backend session yet: persist the chosen cadence in the region so the
      // next connect picks it up.
      dispatchMonitorIntentBestEffort("monitor.setInterval", { key, intervalMs });
    }
  },

  cancelMonitoring: async (key) => {
    const entry = currentMonitorsView().monitors[key];
    if (!entry) return;
    // Abort the backend monitor connect (keyed by session id) so a stuck
    // handshake stops promptly (#1233); the command folds `close` into the
    // region. Ignore errors — torn down anyway.
    try {
      await sessionMonitoringCancel(key);
    } catch (err) {
      frontendLog("monitoring", `cancel failed for ${key}: ${err}`);
    }
    // Belt-and-suspenders: drop any lingering entry (e.g. one that never
    // established a session) from the region so the picker / Retry is reachable.
    await get().disconnectMonitoring(key);
  },
});
