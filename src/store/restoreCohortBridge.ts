/**
 * Restore-cohort projection bridge — Phase 4 step 5a render + mutation cut of the
 * restore-cohort machine (#2241, part of #2206 / #2152 / #2139).
 *
 * The restore-cohort **shadow** (PR #2240) landed a backend-authoritative,
 * client-scoped [`RestoreCohortStore`](../../src-tauri/src/restore_cohort_projection/store.rs)
 * served as the `restore-cohort@<clientId>` projection region, with `restore.*`
 * intents (`restore.beginCohort` / `restore.settleTab`), but nothing in the UI
 * touched it. This step cuts the live UI over to it — the direct analog of the
 * session render cut ({@link import("./useSessionLifecycle")}, #2204), the monitor
 * render + mutation cuts ({@link import("./systemMonitorBridge")}, #2224) and the
 * agents cut ({@link import("./agentsBridge")}, #2226).
 *
 * Unlike the declarative render cuts (agents/monitors read a slice from the region
 * every render), the restore-cohort render surface is a single **fire-once side
 * effect**: the aggregate summary toast raised when a restore/launch cohort
 * settles. So the "render cut" here is a projection subscriber that fires the toast
 * exactly once per new monotonic settlement `seq`, driven by the region.
 *
 * # Two independent flags, both on by default
 *
 * - {@link restoreRenderFromProjectionEnabled} (render cut) — when on, the summary
 *   toast is fired under the projected settlement `seq` (validated to faithfully
 *   mirror the locally-computed summary) instead of straight from the local
 *   reducer. Parity-safe: the fired content is the gate-validated local summary, so
 *   it is byte-identical to the pre-cut toast, and any dispatch failure falls back
 *   to firing locally **synchronously**, so the toast can never be lost.
 * - {@link restoreIntentsEnabled} (mutation cut) — when on, the cohort transitions
 *   dispatch `restore.beginCohort` / `restore.settleTab` so the backend store is
 *   authoritative. The local `appStore` reducers stay in place as the resilience /
 *   rollback fallback (removal is a later step).
 *
 * The region is populated by these same begin/settle intents, dispatched whenever
 * **either** flag is on ({@link shouldMirrorRestore}); that keeps the render cut
 * independent of the mutation flag (the region is always populated when rendering
 * from it). Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_RESTORE_RENDER__` / `localStorage["termihub.restoreRender"]`
 * and `window.__TERMIHUB_RESTORE_INTENTS__` / `localStorage["termihub.restoreIntents"]`
 * (set `"false"` to restore the pre-cut local path).
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

// ── Feature flags (runtime-flippable so a dev build can verify either path) ────

interface RestoreFlagWindow {
  __TERMIHUB_RESTORE_RENDER__?: boolean;
  __TERMIHUB_RESTORE_INTENTS__?: boolean;
  localStorage?: Storage;
}

let renderFlagOverride: boolean | null = null;
let intentsFlagOverride: boolean | null = null;

/** Programmatic override for the render-cut flag (tests, runtime toggle). `null`
 * clears it and falls back to the window/localStorage signal, then the default. */
export function setRestoreRenderFromProjectionEnabled(value: boolean | null): void {
  renderFlagOverride = value;
}

/** Programmatic override for the mutation-cut flag (tests, runtime toggle). */
export function setRestoreIntentsEnabled(value: boolean | null): void {
  intentsFlagOverride = value;
}

/** Read a boolean feature signal from `window`/`localStorage`, else `dflt`. */
function readFlag(
  override: boolean | null,
  windowKey: keyof RestoreFlagWindow,
  storageKey: string,
  dflt: boolean
): boolean {
  if (override !== null) return override;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as RestoreFlagWindow;
      const wv = w[windowKey];
      if (typeof wv === "boolean") return wv;
      const ls = w.localStorage?.getItem(storageKey);
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return dflt;
}

/**
 * Whether the aggregate restore-cohort summary toast is fired under the projected
 * settlement `seq` (render cut) instead of straight from the local reducer.
 *
 * **On by default.** Parity-safe: the fired content is the local summary validated
 * to faithfully mirror the projected settlement, so the toast is byte-identical to
 * the pre-cut path; a dispatch failure falls back to firing locally. Independent of
 * the mutation cut — the region is populated whenever either flag is on. Overridable
 * via `window.__TERMIHUB_RESTORE_RENDER__` / `localStorage["termihub.restoreRender"]`.
 */
export function restoreRenderFromProjectionEnabled(): boolean {
  return readFlag(
    renderFlagOverride,
    "__TERMIHUB_RESTORE_RENDER__",
    "termihub.restoreRender",
    true
  );
}

/**
 * Whether the cohort transitions (`beginRestoreCohort` / `settleRestoreTab`)
 * dispatch `restore.beginCohort` / `restore.settleTab` intents so the backend
 * {@link import("../../src-tauri/src/restore_cohort_projection/store").RestoreCohortStore}
 * is authoritative (mutation cut).
 *
 * **On by default.** The local `appStore` reducers stay in place as the render
 * source and the resilience / rollback fallback (removal is a later step) — a
 * dispatch failure is logged and the local mutation continues, so a backend hiccup
 * can never break restore feedback. Overridable via
 * `window.__TERMIHUB_RESTORE_INTENTS__` / `localStorage["termihub.restoreIntents"]`.
 */
export function restoreIntentsEnabled(): boolean {
  return readFlag(
    intentsFlagOverride,
    "__TERMIHUB_RESTORE_INTENTS__",
    "termihub.restoreIntents",
    true
  );
}

/** The begin/settle intents are dispatched whenever either flag is on: the
 * mutation cut needs them for authority, and the render cut needs them to keep the
 * region populated (making the render cut independent of the mutation flag). */
function shouldMirrorRestore(): boolean {
  return restoreIntentsEnabled() || restoreRenderFromProjectionEnabled();
}

// ── Transport + client-scoped region client (lazy, mirrors the layout slice) ───

// A stable per-session client identity. The client-scoped region is
// `restore-cohort@<clientId>`, and dispatched intents carry the same id, so this
// checkout mutates and subscribes to its own restore-cohort region.
const clientId = newClientId();
const region = restoreCohortRegion(clientId);

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription and pending settlement. */
export function setRestoreTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastObservedSeq = 0;
  pendingSettlement = null;
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
 * and rethrown so the caller can fall back to the local reducer.
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
  pendingSettlement = null;
}

// ── Fire-once settlement rendering ─────────────────────────────────────────────

/**
 * A settlement awaiting its toast: the local closure that fires it (using the
 * gate-validated local summary) plus the expected numbers used to check the
 * projection faithfully mirrors it. Set by {@link expectProjectedRestoreSettlement}
 * when the render cut is on; consumed exactly once — by the projection subscriber
 * on the matching `seq` (the happy path) or by {@link firePendingRestoreFallback}
 * on a dispatch failure (the fallback). Whichever runs first clears it, so the
 * toast fires exactly once.
 */
interface PendingSettlement {
  fire: () => void;
  expected: { total: number; restored: number; failed: number; retryTabIds: string[] };
}

let pendingSettlement: PendingSettlement | null = null;
let lastObservedSeq = 0;

/**
 * Register the local summary to be fired under the projected settlement `seq`
 * (render cut). Called by `appStore.settleRestoreCohort` when the render flag is on,
 * in place of firing the toast directly. The subsequent begin/settle mirror
 * dispatch drives the region; its diff fires this via {@link onRegionChange}, or a
 * dispatch failure fires it via {@link firePendingRestoreFallback}.
 */
export function expectProjectedRestoreSettlement(
  fire: () => void,
  expected: { total: number; restored: number; failed: number; retryTabIds: string[] }
): void {
  pendingSettlement = { fire, expected };
}

/** Whether the projected settlement faithfully mirrors the locally-computed one:
 * identical tallies and the same raw failed-tab set (the backend keeps the retry
 * set raw; the frontend live-filters it, so compare against the raw expectation). */
function settlementMirrors(
  settlement: ProjectedSettlement,
  expected: PendingSettlement["expected"]
): boolean {
  return (
    settlement.total === expected.total &&
    settlement.restored === expected.restored &&
    settlement.failed === expected.failed &&
    sameSet(settlement.retryTabIds, expected.retryTabIds)
  );
}

/** Unordered set equality over two string arrays. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** React to a region diff: fire the pending settlement once per new `seq`. */
function onRegionChange(state: ProjectionCacheState): void {
  const view = state.view as RestoreCohortView | undefined;
  const settlement = view?.settlement;
  if (!settlement || settlement.seq <= lastObservedSeq) return;
  lastObservedSeq = settlement.seq;
  const pending = pendingSettlement;
  if (!pending) return; // already fired locally, or nothing awaiting render
  pendingSettlement = null;
  if (!settlementMirrors(settlement, pending.expected)) {
    // Not a faithful mirror — still fire the local summary (never lose the toast),
    // but log the divergence so the render-cut drift is visible.
    logRestoreBridgeFallback("settlement", new Error("projected settlement diverged from local"));
  }
  pending.fire();
}

/** Fire a pending settlement's local toast now (the fallback path), if one is
 * awaiting. Called when a begin/settle mirror dispatch cannot reach the region
 * (synchronous transport failure, rejected ack, or async error), so the projected
 * `seq` will never arrive — the toast must still fire. No-op if already consumed. */
function firePendingRestoreFallback(reason: string, err: unknown): void {
  const pending = pendingSettlement;
  if (!pending) return;
  pendingSettlement = null;
  logRestoreBridgeFallback(reason, err);
  pending.fire();
}

// ── Mutation cut: begin/settle intent dispatch (also seeds the render region) ──

/** Dispatch a `restore.*` intent, resolving with the ack (parity tests). */
export function dispatchRestoreIntent(
  kind: "restore.beginCohort" | "restore.settleTab",
  payload: Record<string, unknown>
): Promise<IntentAck> {
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId });
}

/** Fire a `restore.*` mirror intent, keeping the backend store authoritative and
 * the render region populated. Any failure falls back to firing the pending
 * settlement's local toast so a bridge hiccup never loses the summary and never
 * disrupts the local reducer path. A no-op when both flags are off (pure rollback).
 * A synchronous transport-construction failure (non-Tauri, no socket) fires the
 * fallback synchronously — preserving the pre-cut synchronous toast in that env. */
function mirrorRestore(
  kind: "restore.beginCohort" | "restore.settleTab",
  payload: Record<string, unknown>
): void {
  if (!shouldMirrorRestore()) {
    // Both flags off: the local reducer already fired the toast; nothing to mirror.
    return;
  }
  // Keep the subscription warm so settlement diffs are received. Guarded because a
  // non-Tauri env without a socket throws *synchronously* from transport
  // construction (not as a rejection) — the dispatch below then fires the fallback.
  try {
    void ensureRestoreSubscribed().catch(() => {
      /* logged in ensureRestoreSubscribed; fallback handled per-dispatch below */
    });
  } catch {
    /* handled by the dispatch try/catch below */
  }
  let dispatchPromise: Promise<IntentAck>;
  try {
    dispatchPromise = dispatchRestoreIntent(kind, payload);
  } catch (err) {
    // Synchronous transport-construction failure — fire the fallback now so the
    // toast still appears synchronously (the pre-cut behaviour without a transport).
    firePendingRestoreFallback(kind, err);
    return;
  }
  void dispatchPromise
    .then((ack) => {
      if (ack.status === "rejected") {
        firePendingRestoreFallback(kind, new Error(ack.error?.message ?? "rejected"));
      }
      // Accepted: the region diff will fire the pending settlement via onRegionChange.
    })
    .catch((err) => firePendingRestoreFallback(kind, err));
}

/** Mirror `restore.beginCohort` (register a restore/launch cohort). */
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

/** Mirror `restore.settleTab` (settle one tab of the active cohort). */
export function mirrorRestoreSettle(payload: {
  tabId: string;
  outcome: "connected" | "failed";
}): void {
  mirrorRestore("restore.settleTab", { tabId: payload.tabId, outcome: payload.outcome });
}

/** Log a bridge fallback so the local-path recovery is visible in the LogViewer. */
export function logRestoreBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("restore_cohort_bridge", `${kind} fell back to local restore summary: ${message}`);
}
