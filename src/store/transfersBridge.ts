/**
 * Transfers projection bridge — the Transfers domain is now
 * **region-authoritative** (#2229, part of #2139 and #2153).
 *
 * The shared `transfers` projection region, backed by the Rust
 * [`TransferStore`](../../src-tauri/src/transfers_projection/store.rs), is the
 * single source of truth for the Transfer Queue panel (the per-transfer queue
 * rows keyed by `transferId` plus the panel-minimized flag). The backend folds
 * every live transfer lifecycle transition and progress sample into the store
 * **at the source** (#2387): the SFTP copy loop and the FTP scheduler executor
 * emit `transfer-progress` events that `app_progress_sink` folds server-side,
 * covering the whole register → queue → progress → pause → resume → finish →
 * cancel lifecycle with no client round-trip. `appStore` no longer holds any
 * transfer-queue state — the render-cut seed, the deep-equal mirror gate, and the
 * `appStore` `transferQueue`/`transferQueueMinimized` reducers were all removed
 * once the region became authoritative.
 *
 * This bridge is the frontend's window onto that region. It:
 *
 * - **subscribes** to the region diffs and fans the projected view out to the
 *   reader hooks ({@link import("./useProjectedTransfers").useProjectedTransfers}),
 *   also caching the latest view for synchronous store-side reads
 *   ({@link currentTransfersView});
 * - **dispatches** the few client-originated `transfer.*` intents that have no
 *   live-engine data source and are therefore genuine client actions, never
 *   server-produced progress: seeding a `queued` row at registration
 *   (`transfer.seed`, #1632), the dropped-terminal-event reconcile backstop
 *   (`transfer.reconcile`, #1645), removing a row (`transfer.remove`), clearing
 *   completed rows (`transfer.clearCompleted`), and collapsing/expanding the
 *   panel (`transfer.setMinimized`).
 *
 * All server-originated transitions (every live progress sample and lifecycle
 * step) reach the region without any client round-trip, so the inversion is
 * non-lossy — no transfer progress is routed through the client.
 *
 * # Multi-window note (maintainer-approved, #2229)
 *
 * The region is **shared**, so the Transfer Queue panel now shows the same queue
 * in every window — a transfer's progress/state is a property of the transfer,
 * not the viewer (Open Design Decision #4, "like tunnels"). This intentionally
 * drops the panel's former per-window scoping (#1964) and the tab-handoff carrying
 * of queue rows (#1951): single-window behavior is unchanged; in multi-window
 * every window sees every transfer. The transient `transfers` map (Open
 * Connections, the file-browser footer, the status-bar aggregate) keeps its
 * per-window scoping — it is separate from this projection.
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
 * {@link TransferEntry} shape one-to-one, so consumers read it directly.
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

// ── Transport + shared region client (lazy) ────────────────────────────────────

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

// A stable per-session client identity for dispatched intents (fan-out / audit
// only; the shared region's diff reaches every subscriber regardless of who
// dispatched it).
const clientId = newClientId();

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription. */
export function setTransferTransportForTest(t: Transport | null): void {
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
 * failure is logged and rethrown so the caller can react.
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
}

/**
 * The last projected view received (for a hook that subscribes after the first
 * diff, and for synchronous store-side reads). Since the region is authoritative
 * and the backend folds every live transition at the source, this is the
 * frontend's current picture of the transfer queue.
 */
export function currentTransfersView(): TransfersView {
  return lastView;
}

// ── Client-originated transfer.* intent dispatch ───────────────────────────────

/**
 * The granular `transfer.*` intent kinds the frontend dispatches (twins of the
 * Rust routes). The backend folds the server-originated progress stream itself
 * (#2387) — every live `transfer-progress` sample and lifecycle step — so the
 * frontend only ever dispatches the client-originated transitions that have no
 * live-engine data source: the registration seed, the reconcile backstop, and the
 * panel-only remove / clearCompleted / setMinimized actions. Excludes
 * `transfer.progress` (server-fed) and the retired `transfer.replace` render
 * mirror.
 */
export type TransferIntentKind =
  | "transfer.seed"
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
 * Fire a client-originated `transfer.*` intent against the authoritative region,
 * swallowing and logging any failure so a bridge/transport hiccup never throws out
 * of a UI action or hook. Used for the transitions that have no live-engine data
 * source — the registration seed, the reconcile backstop, and the panel-only
 * remove / clearCompleted / setMinimized actions — so they are genuine client
 * actions, not server-produced progress routed through the client. Never throws: a
 * synchronous transport-construction failure (non-Tauri, no socket) is caught and
 * logged. The twin of the monitor bridge's
 * {@link import("./systemMonitorBridge").dispatchMonitorIntentBestEffort}.
 */
export function dispatchTransferIntentBestEffort(
  kind: TransferIntentKind,
  payload: Record<string, unknown>
): void {
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

/** Log a bridge dispatch failure so it is visible in the LogViewer. */
export function logTransferBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("transfer_bridge", `${kind} transfer intent failed: ${message}`);
}
