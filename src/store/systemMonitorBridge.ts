/**
 * System-monitor projection bridge — Phase 5 render cut of the Monitors domain
 * (#2224, part of #2139).
 *
 * The Monitors **shadow** (PR #2230) landed a backend-authoritative
 * `SystemMonitorStore` served as the shared `system-monitors` projection region,
 * with `monitor.*` intents, but nothing in the UI touched it. This step makes the
 * **status bar** and **Open Connections** source their monitor stats/status from
 * that region — the parity-safe render cut (the direct analog of the layout
 * render cut {@link import("./useLayoutRenderTree").useLayoutRenderTree}, #2151,
 * and the session render cut {@link import("./useSessionLifecycle")}, #2204).
 *
 * # Strangler safety — flag-gated, on by default, faithful-mirror gate
 *
 * The `appStore` monitoring slice is still authoritative (the mutation cut is a
 * later step). To keep the render cut parity-safe **independent of any mutation
 * flag**, the region is kept a faithful copy of `appStore` by
 * {@link seedMonitorsRegion} (a `monitor.replace` mirror, the analog of the layout
 * bridge's `layout.replace` seed), and the UI renders from the region **only when
 * it faithfully mirrors** `appStore` ({@link monitorsViewMirrors}); otherwise it
 * falls back to `appStore` verbatim. Because the gate guarantees the projected
 * view deep-equals `appStore`'s slice, the rendered output is byte-identical to
 * the pre-cut path.
 *
 * Gated by {@link monitorRenderFromProjectionEnabled} — **on by default**.
 * Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_MONITOR_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.monitorRenderFromProjection"]` (set `"false"` to render
 * straight from `appStore`).
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
 * one-to-one, so the render cut is a pure parity swap.
 */
export interface SystemMonitorsView {
  monitors: Record<string, MonitoringEntry>;
  statsCache: Record<string, SystemStats>;
}

/** The empty view a fresh region reports (twin of the empty store snapshot). */
const EMPTY_VIEW: SystemMonitorsView = { monitors: {}, statsCache: {} };

// ── Render-cut feature flag (runtime-flippable, on by default) ─────────────────

let renderFlagOverride: boolean | null = null;

interface MonitorRenderFlagWindow {
  __TERMIHUB_MONITOR_RENDER_FROM_PROJECTION__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the render-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setMonitorRenderFromProjectionEnabled(value: boolean | null): void {
  renderFlagOverride = value;
}

/**
 * Whether the status bar and Open Connections render their monitor stats/status
 * from the projected `system-monitors` region instead of reading `appStore`'s
 * monitoring slice directly.
 *
 * **On by default** — the render cut is parity-safe: the UI renders from the
 * region only when it faithfully mirrors `appStore` ({@link monitorsViewMirrors}),
 * and otherwise falls back to `appStore` verbatim, so the output is byte-identical
 * to the pre-cut path. Independent of the (later) mutation cut: the region is kept
 * a mirror of `appStore` by {@link seedMonitorsRegion}, so it is always populated.
 * Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_MONITOR_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.monitorRenderFromProjection"]`.
 */
export function monitorRenderFromProjectionEnabled(): boolean {
  if (renderFlagOverride !== null) return renderFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as MonitorRenderFlagWindow;
      if (typeof w.__TERMIHUB_MONITOR_RENDER_FROM_PROJECTION__ === "boolean") {
        return w.__TERMIHUB_MONITOR_RENDER_FROM_PROJECTION__;
      }
      const ls = w.localStorage?.getItem("termihub.monitorRenderFromProjection");
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return true;
}

// ── Transport + shared region client (lazy, mirrors the session slice) ─────────

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

// A stable per-session client identity for dispatched intents (fan-out / audit
// only; the shared region's diff reaches every subscriber regardless of who
// dispatched it).
const clientId = newClientId();

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription / seed dedup. */
export function setMonitorTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastView = EMPTY_VIEW;
  lastSeededSignature = null;
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
 * failure is logged and rethrown so the caller can fall back to `appStore`.
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
  lastSeededSignature = null;
}

/** The last view fanned out (for a hook that subscribes after the first diff). */
export function currentMonitorsView(): SystemMonitorsView {
  return lastView;
}

// ── Seed: keep the region a faithful mirror of appStore (monitor.replace) ──────

let lastSeededSignature: string | null = null;

/**
 * Seed the shared region with `appStore`'s whole monitoring slice via a
 * `monitor.replace` intent, so the projection tracks `appStore`'s current state
 * while `appStore` stays authoritative (the render-side counterpart to the layout
 * bridge's seed). De-duplicated: a slice identical to the last seeded one is not
 * re-dispatched. Never throws synchronously — a transport that cannot dispatch
 * surfaces as a rejected promise the caller logs and ignores (staying on the
 * `appStore` fallback). Idempotent server-side: replacing with the same content
 * yields no diff.
 */
export function seedMonitorsRegion(
  monitors: Record<string, MonitoringEntry>,
  statsCache: Record<string, SystemStats>
): Promise<void> {
  const signature = JSON.stringify({ monitors, statsCache });
  if (signature === lastSeededSignature) return Promise.resolve();
  // Set before dispatching so concurrent callers (status bar + Open Connections)
  // do not double-dispatch the same seed.
  lastSeededSignature = signature;
  try {
    return transport()
      .dispatch({
        intentId: newIntentId(),
        kind: "monitor.replace",
        payload: { monitors, statsCache },
        clientId,
      })
      .then((ack: IntentAck) => {
        if (ack.status === "rejected") {
          // Let a later change retry the seed rather than latch on a failure.
          lastSeededSignature = null;
          throw new Error(ack.error?.message ?? "monitor.replace rejected");
        }
      })
      .catch((err) => {
        lastSeededSignature = null;
        throw err;
      });
  } catch (err) {
    // A synchronous transport-construction failure (non-Tauri, no socket).
    lastSeededSignature = null;
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

// ── Faithful-mirror gate ───────────────────────────────────────────────────────

/**
 * Whether a projected `view` faithfully mirrors `appStore`'s monitoring slice —
 * the gate deciding whether the UI may render from the projection (true) or must
 * fall back to `appStore` (false). A deep value comparison of both the `monitors`
 * map and the `statsCache`; because the projected `MonitorEntry` shape matches
 * {@link MonitoringEntry} one-to-one, a mirroring view is value-identical to the
 * `appStore` slice, so rendering from it can never diverge.
 *
 * The twin of the layout render cut's `viewMatchesTree` and the session render
 * cut's `projectedReconnectMirrors`.
 */
export function monitorsViewMirrors(
  view: SystemMonitorsView | undefined,
  monitors: Record<string, MonitoringEntry>,
  statsCache: Record<string, SystemStats>
): boolean {
  if (!view) return false;
  return deepEqual(view.monitors, monitors) && deepEqual(view.statsCache, statsCache);
}

/**
 * A structural deep-equal for the JSON-ish monitoring view model (objects,
 * arrays, and primitives — no functions/dates/maps). Numbers compare with `===`,
 * so an integer that round-tripped through JSON as a float (`40` vs `40.0`) still
 * matches. Exported for the bridge's parity tests.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

/** Log a bridge fallback so the appStore-path recovery is visible in the LogViewer. */
export function logMonitorBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("monitor_bridge", `${kind} fell back to appStore monitoring: ${message}`);
}
