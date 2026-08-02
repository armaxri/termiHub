/**
 * System-monitor projection bridge — the Monitors domain is now
 * **region-authoritative** (#2224, part of #2139).
 *
 * The shared `system-monitors` projection region, backed by the Rust
 * `SystemMonitorStore`, is the single source of truth for monitor
 * stats/status/lifecycle. The backend folds every transition **at the source**
 * (#2376): the session collector loop folds each stats sample and status change,
 * and the session monitoring commands fold `open`/`opened`/`openFailed`/`close`/
 * `setPaused`/`setInterval`. `appStore` no longer holds any monitor state — the
 * render-cut seed, the deep-equal mirror gate, and the `appStore`
 * `monitors`/`monitoringStatsCache` reducers were all removed once the region
 * became authoritative.
 *
 * This bridge is the frontend's window onto that region. It:
 *
 * - **subscribes** to the region diffs and fans the projected view out to the
 *   reader hooks ({@link import("./useProjectedMonitors").useProjectedMonitors}),
 *   also caching the latest view for synchronous store-side reads
 *   ({@link currentMonitorsView});
 * - **dispatches** the few client-originated `monitor.*` intents that have no
 *   backend command and are therefore genuine client actions, never
 *   server-produced data: dismissing an error banner (`monitor.clearError`) and
 *   pause / interval / close on an entry that never established a backend session
 *   (a still-connecting or failed monitor the user tears down or retunes).
 *
 * All server-originated transitions (stats, status, and every command-driven
 * lifecycle step) reach the region without any client round-trip, so the
 * inversion is non-lossy — nothing safety-critical is routed through the client.
 */

import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type IntentAck,
  type Transport,
} from "@/services/transport";
import type { MonitoringEntry, SystemStats } from "@/types/monitoring";
import { frontendLog } from "@/utils/frontendLog";

/** The projection region id for the system-monitor domain (twin of the Rust
 * `SYSTEM_MONITORS_REGION` const). Shared (Open Design Decision #4). */
export const SYSTEM_MONITORS_REGION = "system-monitors";

/**
 * The `system-monitors` region view model — a twin of the Rust store snapshot:
 * `{ monitors: { <key>: MonitorEntry }, statsCache: { <key>: SystemStats } }`.
 * The projected `MonitorEntry` shape matches the frontend {@link MonitoringEntry}
 * one-to-one, so consumers read it directly.
 */
export interface SystemMonitorsView {
  monitors: Record<string, MonitoringEntry>;
  statsCache: Record<string, SystemStats>;
}

/** The empty view a fresh region reports (twin of the empty store snapshot). */
const EMPTY_VIEW: SystemMonitorsView = { monitors: {}, statsCache: {} };

// ── Transport + shared region client (lazy, mirrors the session slice) ─────────

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

// A stable per-session client identity for dispatched intents (fan-out / audit
// only; the shared region's diff reaches every subscriber regardless of who
// dispatched it).
const clientId = newClientId();

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription. */
export function setMonitorTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastView = EMPTY_VIEW;
}

function transport(): Transport {
  if (!transportInstance) {
    transportInstance = createTransport();
  }
  return transportInstance;
}

// ── View fan-out (one subscription, many consuming hooks) ──────────────────────

/** A change listener for the projected `system-monitors` view. */
export type MonitorsViewListener = (view: SystemMonitorsView) => void;

const viewListeners = new Set<MonitorsViewListener>();
let lastView: SystemMonitorsView = EMPTY_VIEW;

/**
 * Register a listener, invoked with the projected view on every diff. Returns an
 * unsubscribe. The region client is started on first use.
 */
export function onMonitorsView(listener: MonitorsViewListener): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

/**
 * Ensure the shared `system-monitors` region client is subscribed so projected
 * diffs are received and fanned out to the {@link onMonitorsView} listeners.
 * Idempotent and de-duplicated across concurrent callers; a transport/subscribe
 * failure is logged and rethrown so the caller can react.
 */
export function ensureMonitorsSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), SYSTEM_MONITORS_REGION);
    client.onChange((state) => {
      const view = (state.view ?? EMPTY_VIEW) as Partial<SystemMonitorsView>;
      lastView = { monitors: view.monitors ?? {}, statsCache: view.statsCache ?? {} };
      for (const listener of viewListeners) {
        try {
          listener(lastView);
        } catch (err) {
          logMonitorBridgeFallback("reconcile", err);
        }
      }
    });
    startPromise = client
      .start()
      .then(() => {
        regionClient = client;
        return client;
      })
      .catch((err) => {
        startPromise = null;
        logMonitorBridgeFallback("subscribe", err);
        throw err;
      });
  }
  return startPromise;
}

/** Drop the region subscription (tests / re-init). */
export function stopMonitorsSubscription(): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  lastView = EMPTY_VIEW;
}

/**
 * The last projected view received (for a hook that subscribes after the first
 * diff, and for synchronous store-side reads in the monitor lifecycle actions).
 * Since the region is authoritative and the backend folds every transition at the
 * source, this is the frontend's current picture of the monitor state.
 */
export function currentMonitorsView(): SystemMonitorsView {
  return lastView;
}

// ── Client-originated monitor.* intent dispatch ────────────────────────────────

/**
 * The granular `monitor.*` intent kinds (twins of the Rust routes). The backend
 * folds the server-originated transitions itself (#2376) — stats, status, and
 * every command-driven lifecycle step — so the frontend only ever dispatches the
 * client-originated ones that have no backend command: `monitor.clearError` and
 * pause / interval / close on an entry with no backend session.
 */
export type MonitorIntentKind =
  | "monitor.open"
  | "monitor.opened"
  | "monitor.openFailed"
  | "monitor.stats"
  | "monitor.status"
  | "monitor.setPaused"
  | "monitor.setInterval"
  | "monitor.clearError"
  | "monitor.close";

/** Dispatch a granular `monitor.*` intent, resolving with the ack (parity tests). */
export function dispatchMonitorIntent(
  kind: MonitorIntentKind,
  payload: Record<string, unknown>
): Promise<IntentAck> {
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId });
}

/**
 * Fire a client-originated `monitor.*` intent against the authoritative region,
 * swallowing and logging any failure so a bridge/transport hiccup never throws
 * out of a UI action. Used for the transitions that have no backend command —
 * dismissing an error banner, and pause / interval / close on an entry with no
 * backend session — so they are genuine client actions, not server-produced data
 * routed through the client. Never throws: a synchronous transport-construction
 * failure (non-Tauri, no socket) is caught and logged.
 */
export function dispatchMonitorIntentBestEffort(
  kind: MonitorIntentKind,
  payload: Record<string, unknown>
): void {
  try {
    void dispatchMonitorIntent(kind, payload)
      .then((ack) => {
        if (ack.status === "rejected") {
          logMonitorBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
        }
      })
      .catch((err) => logMonitorBridgeFallback(kind, err));
  } catch (err) {
    logMonitorBridgeFallback(kind, err);
  }
}

/** Log a bridge dispatch failure so it is visible in the LogViewer. */
export function logMonitorBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("monitor_bridge", `${kind} monitor intent failed: ${message}`);
}
