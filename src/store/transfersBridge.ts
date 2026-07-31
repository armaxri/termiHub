/**
 * Transfers projection bridge — Phase 5 render cut of the Transfer-Queue domain
 * (#2229, part of #2139 and #2153).
 *
 * The Transfers **shadow** (PR #2275) landed a backend-authoritative
 * [`TransferStore`](../../src-tauri/src/transfers_projection/store.rs) served as
 * the shared `transfers` projection region, with `transfer.*` intents, but
 * nothing in the UI touched it. This step makes the **Transfer Queue panel**
 * ({@link import("../components/TransferQueue/TransferQueue").TransferQueue} and
 * its status-bar {@link import("../components/TransferQueue/TransferQueueIndicator").TransferQueueIndicator})
 * source the queue rows + minimized flag from that region — the parity-safe
 * render cut (the direct analog of the connections render cut
 * {@link import("./connectionsBridge")}, #2225, and the agents render cut
 * {@link import("./agentsBridge")}, #2226).
 *
 * # Strangler safety — flag-gated, on by default, faithful-mirror gate
 *
 * The `appStore` transfer-queue slice (`transferQueue` / `transferQueueMinimized`)
 * is still authoritative (the mutation cut is a later step). To keep the render
 * cut parity-safe **independent of any mutation flag**, the region is kept a
 * faithful copy of `appStore` by {@link seedTransfersRegion} (a `transfer.replace`
 * mirror, the analog of the connections bridge's `connection.replace` seed), and
 * the UI renders from the region **only when it faithfully mirrors** `appStore`
 * ({@link transfersViewMirrors}); otherwise it falls back to `appStore` verbatim.
 * Because the gate guarantees the projected view deep-equals `appStore`'s slice,
 * the rendered output is byte-identical to the pre-cut path.
 *
 * Gated by {@link transferRenderFromProjectionEnabled} — **on by default**.
 * Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_TRANSFER_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.transferRenderFromProjection"]` (set `"false"` to
 * render straight from `appStore`).
 */

import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type IntentAck,
  type Transport,
} from "@/services/transport";
import type { TransferEntry } from "@/types/transfer";
import { frontendLog } from "@/utils/frontendLog";

/** The projection region id for the transfer-queue domain (twin of the Rust
 * `TRANSFERS_REGION` const). Shared (Open Design Decision #4). */
export const TRANSFERS_REGION = "transfers";

/**
 * The projected transfers view model, in `appStore` terms — a twin of the Rust
 * store snapshot: the per-transfer queue map keyed by `transferId`, plus the
 * panel-minimized flag. The projected records match the frontend
 * {@link TransferEntry} shape one-to-one, so the render cut is a pure parity swap.
 */
export interface TransfersView {
  queue: Record<string, TransferEntry>;
  minimized: boolean;
}

/** The empty view a fresh region reports (twin of the empty store snapshot). */
const EMPTY_VIEW: TransfersView = {
  queue: {},
  minimized: false,
};

/**
 * The raw region view model as the Rust store serialises it, keyed
 * `queue`/`minimized` (see `TransferStore::snapshot`). The keys already match the
 * `appStore`-mapped {@link TransfersView}, so mapping is a defaulting pass
 * ({@link toView}).
 */
interface TransfersRegionSnapshot {
  queue?: Record<string, TransferEntry>;
  minimized?: boolean;
}

/** Translate the raw region snapshot into the `appStore`-named view. */
function toView(raw: TransfersRegionSnapshot): TransfersView {
  return {
    queue: raw.queue ?? {},
    minimized: raw.minimized ?? false,
  };
}

// ── Render-cut feature flag (runtime-flippable, on by default) ─────────────────

let renderFlagOverride: boolean | null = null;

interface TransferRenderFlagWindow {
  __TERMIHUB_TRANSFER_RENDER_FROM_PROJECTION__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the render-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setTransferRenderFromProjectionEnabled(value: boolean | null): void {
  renderFlagOverride = value;
}

/**
 * Whether the Transfer Queue panel renders the queue rows + minimized flag from
 * the projected `transfers` region instead of reading `appStore`'s transfer-queue
 * slice directly.
 *
 * **On by default** — the render cut is parity-safe: the UI renders from the
 * region only when it faithfully mirrors `appStore` ({@link transfersViewMirrors}),
 * and otherwise falls back to `appStore` verbatim, so the output is byte-identical
 * to the pre-cut path. Independent of the (later) mutation cut: the region is kept
 * a mirror of `appStore` by {@link seedTransfersRegion}, so it is always populated.
 * Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_TRANSFER_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.transferRenderFromProjection"]`.
 */
export function transferRenderFromProjectionEnabled(): boolean {
  if (renderFlagOverride !== null) return renderFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as TransferRenderFlagWindow;
      if (typeof w.__TERMIHUB_TRANSFER_RENDER_FROM_PROJECTION__ === "boolean") {
        return w.__TERMIHUB_TRANSFER_RENDER_FROM_PROJECTION__;
      }
      const ls = w.localStorage?.getItem("termihub.transferRenderFromProjection");
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return true;
}

// ── Mutation-cut feature flag (runtime-flippable, on by default) ───────────────

let mutationFlagOverride: boolean | null = null;

interface TransferMutationFlagWindow {
  __TERMIHUB_TRANSFER_INTENTS__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the mutation-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setTransferIntentsEnabled(value: boolean | null): void {
  mutationFlagOverride = value;
}

/**
 * Whether the Transfer Queue mutations (seed/progress/reconcile a queue row,
 * remove a row, clear completed, collapse/expand the panel) dispatch granular
 * `transfer.*` intents so the backend
 * {@link import("../../src-tauri/src/transfers_projection/store").TransferStore} is
 * authoritative — instead of only the render-cut {@link seedTransfersRegion}
 * `transfer.replace` mirror driving the region.
 *
 * **On by default** (#2229 mutation cut, the final Phase-5 domain). When on, each
 * queue action mirrors its transition through a `transfer.*` intent (via
 * {@link mirrorTransferIntent}), and the render-cut hook
 * ({@link import("./useProjectedTransfers").useProjectedTransfers}) reflects the
 * region back into the UI. The local `appStore` reducer path stays in place as the
 * render source and as a resilience / rollback fallback — any dispatch failure is
 * logged and the local mutation continues, so a backend hiccup can never break the
 * transfer queue (the reducer removal is a later step). When off, `appStore` drives
 * the slice purely locally (the pre-cut path). The flip was taken on the automated
 * parity tests plus the instant local fallback, mirroring the connections mutation
 * cut (#2225). Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_TRANSFER_INTENTS__` or
 * `localStorage["termihub.transferIntents"]` (set `"false"` to restore the pre-cut
 * local-mutation path; `"true"` to force on).
 */
export function transferIntentsEnabled(): boolean {
  if (mutationFlagOverride !== null) return mutationFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as TransferMutationFlagWindow;
      if (typeof w.__TERMIHUB_TRANSFER_INTENTS__ === "boolean") {
        return w.__TERMIHUB_TRANSFER_INTENTS__;
      }
      const ls = w.localStorage?.getItem("termihub.transferIntents");
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return true;
}

// ── Transport + shared region client (lazy, mirrors the connections slice) ─────

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

// A stable per-session client identity for dispatched intents (fan-out / audit
// only; the shared region's diff reaches every subscriber regardless of who
// dispatched it).
const clientId = newClientId();

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription / seed dedup. */
export function setTransferTransportForTest(t: Transport | null): void {
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

/** A change listener for the projected `transfers` view. */
export type TransfersViewListener = (view: TransfersView) => void;

const viewListeners = new Set<TransfersViewListener>();
let lastView: TransfersView = EMPTY_VIEW;

/**
 * Register a listener, invoked with the projected view on every diff. Returns an
 * unsubscribe. The region client is started on first use.
 */
export function onTransfersView(listener: TransfersViewListener): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

/**
 * Ensure the shared `transfers` region client is subscribed so projected diffs
 * are received and fanned out to the {@link onTransfersView} listeners.
 * Idempotent and de-duplicated across concurrent callers; a transport/subscribe
 * failure is logged and rethrown so the caller can fall back to `appStore`.
 */
export function ensureTransfersSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), TRANSFERS_REGION);
    client.onChange((state) => {
      lastView = toView((state.view ?? {}) as TransfersRegionSnapshot);
      for (const listener of viewListeners) {
        try {
          listener(lastView);
        } catch (err) {
          logTransferBridgeFallback("reconcile", err);
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
        logTransferBridgeFallback("subscribe", err);
        throw err;
      });
  }
  return startPromise;
}

/** Drop the region subscription (tests / re-init). */
export function stopTransfersSubscription(): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  lastView = EMPTY_VIEW;
  lastSeededSignature = null;
}

/** The last view fanned out (for a hook that subscribes after the first diff). */
export function currentTransfersView(): TransfersView {
  return lastView;
}

// ── Seed: keep the region a faithful mirror of appStore (transfer.replace) ─────

let lastSeededSignature: string | null = null;

/**
 * Seed the shared region with `appStore`'s whole transfer-queue slice via a
 * `transfer.replace` intent, so the projection tracks `appStore`'s current state
 * while `appStore` stays authoritative (the render-side counterpart to the
 * granular mutation intents). The payload is keyed to the Rust snapshot shape
 * (`queue`/`minimized`). De-duplicated: a slice identical to the last seeded one
 * is not re-dispatched. Never throws synchronously — a transport that cannot
 * dispatch surfaces as a rejected promise the caller logs and ignores (staying on
 * the `appStore` fallback). Idempotent server-side: replacing with the same
 * content yields no diff.
 */
export function seedTransfersRegion(
  queue: Record<string, TransferEntry>,
  minimized: boolean
): Promise<void> {
  const payload = { queue, minimized };
  const signature = JSON.stringify(payload);
  if (signature === lastSeededSignature) return Promise.resolve();
  // Set before dispatching so concurrent callers do not double-dispatch the seed.
  lastSeededSignature = signature;
  try {
    return transport()
      .dispatch({
        intentId: newIntentId(),
        kind: "transfer.replace",
        payload,
        clientId,
      })
      .then((ack: IntentAck) => {
        if (ack.status === "rejected") {
          // Let a later change retry the seed rather than latch on a failure.
          lastSeededSignature = null;
          throw new Error(ack.error?.message ?? "transfer.replace rejected");
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

// ── Mutation cut: granular transfer.* intent dispatch ─────────────────────────

/**
 * The granular `transfer.*` intent kinds the mutation cut dispatches (twins of the
 * Rust routes). Excludes `transfer.replace`, which is the render-cut whole-slice
 * mirror ({@link seedTransfersRegion}); the mutation cut drives the region through
 * these per-transition intents instead so the store becomes authoritative.
 */
export type TransferIntentKind =
  | "transfer.seed"
  | "transfer.progress"
  | "transfer.reconcile"
  | "transfer.remove"
  | "transfer.clearCompleted"
  | "transfer.setMinimized";

/** Dispatch a granular `transfer.*` intent, resolving with the ack (parity tests). */
export function dispatchTransferIntent(
  kind: TransferIntentKind,
  payload: Record<string, unknown>
): Promise<IntentAck> {
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId });
}

/**
 * Fire a granular `transfer.*` intent to keep the backend store authoritative,
 * swallowing and logging any failure so the local `appStore` mutation path is
 * never disrupted by a bridge hiccup (the resilience fallback). A no-op when the
 * mutation cut is disabled ({@link transferIntentsEnabled} off — the rollback
 * path). Never throws — a synchronous transport-construction failure (non-Tauri,
 * no socket) is caught and logged, leaving the UI on the local slice. The twin of
 * the connections bridge's {@link import("./connectionsBridge").mirrorConnectionIntent}.
 */
export function mirrorTransferIntent(
  kind: TransferIntentKind,
  payload: Record<string, unknown>
): void {
  if (!transferIntentsEnabled()) return;
  try {
    void dispatchTransferIntent(kind, payload)
      .then((ack) => {
        if (ack.status === "rejected") {
          logTransferBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
        }
      })
      .catch((err) => logTransferBridgeFallback(kind, err));
  } catch (err) {
    logTransferBridgeFallback(kind, err);
  }
}

// ── Faithful-mirror gate ───────────────────────────────────────────────────────

/**
 * Whether a projected `view` faithfully mirrors `appStore`'s transfer-queue slice
 * — the gate deciding whether the UI may render from the projection (true) or
 * must fall back to `appStore` (false). A deep value comparison of the queue map
 * plus the minimized flag; because the projected records match the frontend shape
 * one-to-one, a mirroring view is value-identical to the `appStore` slice, so
 * rendering from it can never diverge.
 *
 * The twin of the connections render cut's `connectionsViewMirrors`.
 */
export function transfersViewMirrors(
  view: TransfersView | undefined,
  queue: Record<string, TransferEntry>,
  minimized: boolean
): boolean {
  if (!view) return false;
  return view.minimized === minimized && deepEqual(view.queue, queue);
}

/**
 * A structural deep-equal for the JSON-ish transfers view model (objects, arrays,
 * and primitives — no functions/dates/maps). Numbers compare with `===`, so an
 * integer that round-tripped through JSON as a float (`22` vs `22.0`) still
 * matches.
 *
 * **JSON semantics for `undefined`:** a {@link TransferEntry} carries optional
 * fields (`path` / `error` / `attempt` / `maxAttempts`) that `appStore` may hold
 * as explicit `undefined`-valued keys, whereas the region round-trips through JSON
 * and drops them. An absent key and an explicit `undefined` therefore denote the
 * same value, so keys carrying `undefined` are ignored on both sides — otherwise a
 * faithful mirror would be rejected purely over a dropped optional key. Exported
 * for the bridge's parity tests.
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
    const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
    const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k])
    );
  }
  return false;
}

/** Log a bridge fallback so the appStore-path recovery is visible in the LogViewer. */
export function logTransferBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("transfer_bridge", `${kind} fell back to appStore transfers: ${message}`);
}
