/**
 * Restore-cohort projection bridge — the restore-cohort machine is now
 * **region-authoritative** (#2206, Phase 4 step 5; reducer removal after the
 * render + mutation cut of #2241).
 *
 * The client-scoped [`RestoreCohortStore`](../../src-tauri/src/restore_cohort_projection/store.rs)
 * served as the `restore-cohort@<clientId>` projection region is the sole source
 * of truth for the aggregate restore/launch feedback (#1146 / #1227): it owns the
 * in-flight cohort, the captured failed-tab set, and the monotonic settlement
 * summary. `appStore` holds no cohort slice — its `beginRestoreCohort` /
 * `settleRestoreTab` actions are thin dispatchers of the `restore.beginCohort` /
 * `restore.settleTab` intents, and the aggregate summary toast is fired from the
 * projected settlement diff (the direct analog of the monitors reducer removal,
 * {@link import("./systemMonitorBridge")}, #2385, and the transfers one,
 * {@link import("./transfersBridge")}, #2399).
 *
 * # Render surface: a fire-once settlement side effect
 *
 * Unlike the declarative render cuts (agents/monitors read a slice every render),
 * the restore-cohort render surface is a single **fire-once side effect**: the
 * aggregate summary toast raised when a restore/launch cohort settles. So instead
 * of a `useProjected*` hook, the bridge fires the toast exactly once per new
 * monotonic settlement `seq` via a renderer the store registers
 * ({@link setRestoreSettlementRenderer}). The renderer lives in `appStore` because
 * firing the toast and intersecting the retry set with the live terminal tabs both
 * need the tab registry — concerns that deliberately stay frontend-side.
 *
 * # What stays frontend
 *
 * - **The toast itself.** The backend produces the settlement summary (tallies +
 *   raw retry set + `seq`); rendering it as a `sonner` toast is presentation.
 * - **The live-terminal filter.** The store keeps the raw failed-tab set; the
 *   frontend intersects it with its live terminal tabs when it renders the retry
 *   action and when {@link import("./appStore").AppState.reconnectFailedRestoreTabs}
 *   re-drives — exactly as before.
 */

import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type IntentAck,
  type ProjectionCacheState,
  type Transport,
} from "@/services/transport";
import { frontendLog } from "@/utils/frontendLog";

/** The projection region id for a client's restore cohort
 * (`restore-cohort@<clientId>`, twin of the Rust `restore_cohort_region`). */
export function restoreCohortRegion(clientId: string): string {
  return `restore-cohort@${clientId}`;
}

// ── Projected view model (twin of the Rust store snapshot) ─────────────────────

/** The in-flight cohort projected by the region. */
export interface ProjectedCohort {
  pending: string[];
  total: number;
  failed: number;
  failedTabIds: string[];
  toastId?: string | null;
}

/** The settlement summary projected by the region — the render-cut seam. `seq`
 * increments per settle so the subscriber fires the toast once per new settle. */
export interface ProjectedSettlement {
  seq: number;
  total: number;
  restored: number;
  failed: number;
  retryTabIds: string[];
  toastId?: string | null;
}

/** The `restore-cohort@<clientId>` region view model:
 * `{ cohort, failedTabIds, settlement }` (twin of `ClientState::to_view`). */
export interface RestoreCohortView {
  cohort: ProjectedCohort | null;
  failedTabIds: string[];
  settlement: ProjectedSettlement | null;
}

/** The empty view returned before the first projection diff lands. */
export const EMPTY_RESTORE_COHORT_VIEW: RestoreCohortView = {
  cohort: null,
  failedTabIds: [],
  settlement: null,
};

// ── Transport + client-scoped region client (lazy, mirrors the layout slice) ───

// A stable per-session client identity. The client-scoped region is
// `restore-cohort@<clientId>`, and dispatched intents carry the same id, so this
// checkout mutates and subscribes to its own restore-cohort region.
const clientId = newClientId();
const region = restoreCohortRegion(clientId);

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

/** The last projected view received — the frontend's current picture of the
 * authoritative cohort state, read synchronously by the store's cohort actions. */
let lastView: RestoreCohortView = EMPTY_RESTORE_COHORT_VIEW;

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription and cached view. */
export function setRestoreTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastObservedSeq = 0;
  lastView = EMPTY_RESTORE_COHORT_VIEW;
}

function transport(): Transport {
  if (!transportInstance) {
    transportInstance = createTransport();
  }
  return transportInstance;
}

/**
 * Ensure the `restore-cohort@<clientId>` region client is subscribed so settlement
 * diffs are received and the summary toast can be fired from them. Idempotent and
 * de-duplicated across concurrent callers; a transport/subscribe failure is logged
 * and rethrown so the caller can log a bridge fallback.
 */
export function ensureRestoreSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), region);
    client.onChange((state) => onRegionChange(state));
    startPromise = client
      .start()
      .then(() => {
        regionClient = client;
        return client;
      })
      .catch((err) => {
        startPromise = null;
        logRestoreBridgeFallback("subscribe", err);
        throw err;
      });
  }
  return startPromise;
}

/** Drop the region subscription (tests / re-init). */
export function stopRestoreSubscription(): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  lastObservedSeq = 0;
  lastView = EMPTY_RESTORE_COHORT_VIEW;
}

/**
 * The current projected restore-cohort view. Since the region is authoritative,
 * this is the frontend's picture of the cohort state — read by
 * {@link import("./appStore").AppState.reconnectFailedRestoreTabs} for the captured
 * failed-tab set. Empty until the first projection diff lands.
 */
export function currentRestoreCohortView(): RestoreCohortView {
  return lastView;
}

// ── Fire-once settlement rendering ─────────────────────────────────────────────

/** Renders a settled cohort's aggregate summary (fires the toast, intersecting the
 * retry set with the live terminal tabs). Registered by `appStore`, which owns the
 * tab registry the render needs. */
export type RestoreSettlementRenderer = (settlement: ProjectedSettlement) => void;

let settlementRenderer: RestoreSettlementRenderer | null = null;
let lastObservedSeq = 0;

/** Register the settlement renderer (the store's toast + live-filter logic). `null`
 * clears it (tests). Called once at store init. */
export function setRestoreSettlementRenderer(fn: RestoreSettlementRenderer | null): void {
  settlementRenderer = fn;
}

/** React to a region diff: cache the view, and fire the settlement renderer once
 * per new monotonic `seq` so the aggregate summary toast appears exactly once. */
function onRegionChange(state: ProjectionCacheState): void {
  const view = (state.view as RestoreCohortView | undefined) ?? EMPTY_RESTORE_COHORT_VIEW;
  lastView = view;
  const settlement = view.settlement;
  if (!settlement || settlement.seq <= lastObservedSeq) return;
  lastObservedSeq = settlement.seq;
  settlementRenderer?.(settlement);
}

// ── Mutation: begin/settle intent dispatch (also seeds the render region) ──────

/** Dispatch a `restore.*` intent, resolving with the ack (parity tests). */
export function dispatchRestoreIntent(
  kind: "restore.beginCohort" | "restore.settleTab",
  payload: Record<string, unknown>
): Promise<IntentAck> {
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId });
}

/** Fire a `restore.*` intent against the authoritative region and keep the
 * subscription warm so the settlement diff (and its toast) arrives. Best-effort:
 * any failure is logged and swallowed so a bridge/transport hiccup never throws out
 * of a store action. A synchronous transport-construction failure (non-Tauri, no
 * socket) is caught the same way. */
function mirrorRestore(
  kind: "restore.beginCohort" | "restore.settleTab",
  payload: Record<string, unknown>
): void {
  // Keep the subscription warm so settlement diffs are received. Guarded because a
  // non-Tauri env without a socket throws *synchronously* from transport
  // construction (not as a rejection) — logged via the dispatch catch below.
  try {
    void ensureRestoreSubscribed().catch(() => {
      /* logged in ensureRestoreSubscribed */
    });
  } catch {
    /* handled by the dispatch try/catch below */
  }
  let dispatchPromise: Promise<IntentAck>;
  try {
    dispatchPromise = dispatchRestoreIntent(kind, payload);
  } catch (err) {
    logRestoreBridgeFallback(kind, err);
    return;
  }
  void dispatchPromise
    .then((ack) => {
      if (ack.status === "rejected") {
        logRestoreBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
      }
    })
    .catch((err) => logRestoreBridgeFallback(kind, err));
}

/** Dispatch `restore.beginCohort` (register a restore/launch cohort). */
export function mirrorRestoreBegin(payload: {
  pendingTabIds: string[];
  preFailedCount: number;
  toastId?: string | number;
}): void {
  const body: Record<string, unknown> = {
    pendingTabIds: payload.pendingTabIds,
    preFailedCount: payload.preFailedCount,
  };
  if (payload.toastId !== undefined) body.toastId = String(payload.toastId);
  mirrorRestore("restore.beginCohort", body);
}

/** Dispatch `restore.settleTab` (settle one tab of the active cohort). */
export function mirrorRestoreSettle(payload: {
  tabId: string;
  outcome: "connected" | "failed";
}): void {
  mirrorRestore("restore.settleTab", { tabId: payload.tabId, outcome: payload.outcome });
}

/** Log a bridge failure so a dropped restore summary is visible in the LogViewer. */
export function logRestoreBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("restore_cohort_bridge", `${kind} restore intent failed: ${message}`);
}
