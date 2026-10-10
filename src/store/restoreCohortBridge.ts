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
import { makeVersionGuard } from "./bridgeVersionGuard";
import { errorMessage } from "@/utils/errorMessage";

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
// The monotonic region-version guard for `lastView` (FES-006): a projected view
// strictly older than the last applied is a stale, out-of-order delivery and is
// ignored, so it can never clobber a newer view (nor re-fire a stale settlement).
const versionGuard = makeVersionGuard();

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription and cached view. */
export function setRestoreTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastObservedSeq = 0;
  lastView = EMPTY_RESTORE_COHORT_VIEW;
  versionGuard.reset();
  resetSettledSignal();
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
function ensureRestoreSubscribed(): Promise<ProjectionClient> {
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
  versionGuard.reset();
  resetSettledSignal();
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
 * per new monotonic `seq` so the aggregate summary toast appears exactly once. A
 * stale (strictly-older region version) diff is ignored (FES-006) so it can neither
 * clobber a newer view nor re-fire a settlement. */
function commitRestoreCohortView(view: RestoreCohortView, version: number): void {
  if (!versionGuard.shouldApply(version)) return;
  lastView = view;
  lastAppliedVersion = version;
  const settlement = view.settlement;
  if (settlement && settlement.seq > lastObservedSeq) {
    lastObservedSeq = settlement.seq;
    settlementRenderer?.(settlement);
  }
  checkAwaitedCohortSettled();
}

// ── Cohort-settled signal (#4387) ──────────────────────────────────────────────
//
// The restore-in-progress auto-save guard (GAP G5, #1146) used to lower after a
// fixed 2s wall-clock guess. The region already knows exactly when a cohort has
// settled — every tab connected or failed — so the guard now listens for that.
//
// Correlation: the cohort begun by the most recent `restore.beginCohort` is the
// one awaited. Its ack carries the region version the begin produced; the cohort
// counts as settled once a view at (or after) that version shows no in-flight
// cohort. A settlement from an older, superseded cohort that is still in flight
// is therefore never mistaken for the new one. A begin that fails or is rejected
// leaves the await pending — the guard's own safety timeout covers that case.

/** Fired once the most recently begun cohort has settled. */
export type RestoreCohortSettledListener = () => void;

const settledListeners = new Set<RestoreCohortSettledListener>();
/** The awaited begin: `version` is `null` until its ack lands. */
let awaitedBegin: { token: number; version: number | null } | null = null;
let beginToken = 0;
/** The region version of {@link lastView} (`-1` before the first diff). */
let lastAppliedVersion = -1;

/**
 * Subscribe to the "most recently begun restore cohort has settled" signal
 * (#4387). Returns an unsubscribe function. Survives transport swaps in tests.
 */
export function onRestoreCohortSettled(listener: RestoreCohortSettledListener): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}

function resetSettledSignal(): void {
  awaitedBegin = null;
  lastAppliedVersion = -1;
}

function notifyCohortSettled(): void {
  awaitedBegin = null;
  for (const listener of [...settledListeners]) listener();
}

function checkAwaitedCohortSettled(): void {
  if (!awaitedBegin || awaitedBegin.version === null) return;
  if (lastAppliedVersion < awaitedBegin.version) return;
  if (lastView.cohort !== null) return;
  notifyCohortSettled();
}

/** Record the version a begin's ack produced, then re-check settlement (the
 * settling diff may already have landed before the ack resolved). */
function onBeginAck(token: number, ack: IntentAck): void {
  if (!awaitedBegin || awaitedBegin.token !== token) return;
  if (ack.status === "rejected") return;
  const produced = ack.produced?.find((p) => p.region === region);
  // No produced region means the begin did not change the view; settle against
  // whatever the current view already shows.
  awaitedBegin.version = produced?.version ?? lastAppliedVersion;
  checkAwaitedCohortSettled();
}

function onRegionChange(state: ProjectionCacheState): void {
  const view = (state.view as RestoreCohortView | undefined) ?? EMPTY_RESTORE_COHORT_VIEW;
  commitRestoreCohortView(view, state.version);
}

/**
 * Test-only: synchronously commit a projected view at an explicit region `version`
 * through the same guarded path a real diff takes, so a test can drive the
 * stale-drop / apply behaviour without a transport double. Never call from
 * production code.
 */
export function __emitRestoreCohortViewForTest(view: RestoreCohortView, version: number): void {
  commitRestoreCohortView(view, version);
}

// ── Mutation: begin/settle intent dispatch (also seeds the render region) ──────

/** Dispatch a `restore.*` intent, resolving with the ack. */
function dispatchRestoreIntent(
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
  payload: Record<string, unknown>,
  onAck?: (ack: IntentAck) => void
): void {
  // Keep the subscription warm so settlement diffs are received. Guarded because a
  // non-Tauri env without a socket throws *synchronously* from transport
  // construction (not as a rejection) — logged via the dispatch catch below.
  try {
    // ensureRestoreSubscribed logs the failure itself; keep a call-site trace too.
    void ensureRestoreSubscribed().catch((err: unknown) =>
      frontendLog("restore_cohort", `keep-warm subscribe failed: ${errorMessage(err)}`)
    );
  } catch {
    // Not logged here: the same synchronous transport-construction failure is
    // thrown again by the dispatch below, which logs it. Logging both would
    // duplicate every line (#4520).
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
      onAck?.(ack);
    })
    .catch((err) => logRestoreBridgeFallback(kind, err));
}

/** Dispatch `restore.beginCohort` (register a restore/launch cohort). The begun
 * cohort becomes the one {@link onRestoreCohortSettled} awaits. */
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
  const token = ++beginToken;
  awaitedBegin = { token, version: null };
  mirrorRestore("restore.beginCohort", body, (ack) => onBeginAck(token, ack));
  // An empty cohort (nothing to connect, nothing pre-failed) is a region no-op
  // that never settles, so there is nothing to wait for: signal it now.
  if (new Set(payload.pendingTabIds).size + payload.preFailedCount === 0) {
    notifyCohortSettled();
  }
}

/** Dispatch `restore.settleTab` (settle one tab of the active cohort). */
export function mirrorRestoreSettle(payload: {
  tabId: string;
  outcome: "connected" | "failed";
}): void {
  mirrorRestore("restore.settleTab", { tabId: payload.tabId, outcome: payload.outcome });
}

/** Log a bridge failure so a dropped restore summary is visible in the LogViewer. */
function logRestoreBridgeFallback(kind: string, err: unknown): void {
  const message = errorMessage(err);
  frontendLog("restore_cohort_bridge", `${kind} restore intent failed: ${message}`);
}
