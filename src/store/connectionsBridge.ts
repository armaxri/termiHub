/**
 * Connections projection bridge — Phase 5 Connections-tree domain (#2225, part of
 * #2139 and #2153).
 *
 * The Connections **shadow** (PR #2231) landed a backend
 * [`ConnectionsStore`](../../src-tauri/src/connections_projection/store.rs) served
 * as the shared `connections` projection region, with `connection.*` intents. The
 * region is now **authoritative** for the connection tree sidebar
 * ({@link import("../components/Sidebar/ConnectionList").ConnectionList}): the store
 * is fed at the source — every persisted saved-connection / folder mutation and the
 * external-file overlay are folded server-side (#2389 and #2394) — so the sidebar
 * reads the region directly through {@link import("./useProjectedConnections").useProjectedConnections},
 * with no `appStore` seed, mirror gate, or fallback (the direct analog of the
 * authoritative transfers bridge {@link import("./transfersBridge")}, #2229, and the
 * authoritative system-monitor bridge {@link import("./systemMonitorBridge")},
 * #2224).
 *
 * # Fully region-authoritative (#2401, PR B)
 *
 * The reducer removal is complete: `appStore` no longer holds a `connections` /
 * `folders` slice. **Every** reader — the sidebar, the connection editor, the
 * command palette, the tunnel / workflow sidebars, the file browser, and the
 * store's own connect / session / tab logic — sources the inventory from this
 * region, synchronously via {@link currentConnectionsView} or reactively via
 * {@link import("./useProjectedConnections").useProjectedConnections}. The
 * connection-tree lifecycle actions are thin backend-command wrappers around
 * {@link persistWithOverlay}.
 *
 * # Single authoritative writer (#2831)
 *
 * The persist command is the **only** writer of the `connections` region: it
 * writes `connections.json` and, in the same backend step, folds the disk truth
 * into the region (the `commit` choke point) — whether the write succeeded,
 * failed cleanly, or failed half-way. No `connection.*` intent is dispatched, so
 * there is never a second, uncoupled region write that a failed persist has to
 * compensate for, and the region cannot sit ahead of (or behind) disk.
 *
 * Instant feedback comes from a **client-local optimistic overlay**
 * ({@link persistWithOverlay}): a pure {@link ConnectionsFold} layered over the
 * authoritative view while the persist is in flight. The overlay's lifecycle is
 * driven by the persist result, not by an intent ack: once the persist settles
 * (either way) the bridge waits for the region to catch up to the backend's
 * post-persist version, then drops the overlay. On success the authoritative
 * view already carries the change; on failure it carries exactly what is on
 * disk — exact membership and order, no compensating write, no drift.
 *
 * # Previews that land under a different id (#3961)
 *
 * An add previews its row under a client-generated id (`conn-<ulid>`), but the
 * persist command stores it under the id it recomputes from folder + name. The
 * region diff carrying the saved row and the command's reply are independent
 * messages, so the diff can land first — and even in the other order the
 * catch-up adopts the saved row one step before the overlay drops. Without a
 * match, the preview and the saved row would both show for that window.
 *
 * The client-generated id doubles as the match key: the backend echoes it in
 * the region's `savedAs` map (`optimistic id → persisted id`), written in the
 * **same** fold that publishes the saved row. An add overlay registered with
 * its `previewId` stops applying the moment the authoritative view lists that
 * id in `savedAs`, so the saved row replaces the preview in one emitted view,
 * whichever message arrives first.
 */

import { createTransport, ProjectionClient, type Transport } from "@/services/transport";
import type { SavedConnection, ConnectionFolder } from "@/types/connection";
import { frontendLog } from "@/utils/frontendLog";
import { makeVersionGuard } from "./bridgeVersionGuard";
import type { ConnectionsFold, ConnectionsView } from "./connectionsOverlay";
import { errorMessage } from "@/utils/errorMessage";

export type { ConnectionsFold, ConnectionsView } from "./connectionsOverlay";

/** The projection region id for the connections-tree domain (twin of the Rust
 * `CONNECTIONS_REGION` const). Shared (Open Design Decision #4). */
export const CONNECTIONS_REGION = "connections";

/** The empty view a fresh region reports (twin of the empty store snapshot). */
const EMPTY_VIEW: ConnectionsView = {
  folders: [],
  connections: [],
};

/**
 * The raw region view model as the Rust store serialises it, keyed
 * `folders`/`connections` (see `ConnectionsStore::snapshot`). The keys already
 * match the `appStore`-named {@link ConnectionsView}, so mapping is a defaulting
 * pass ({@link toView}).
 */
interface ConnectionsRegionSnapshot {
  folders?: ConnectionFolder[];
  connections?: SavedConnection[];
  /** Recent saves whose id changed: optimistic id → persisted id (#3961). */
  savedAs?: Record<string, string>;
}

/** Translate the raw region snapshot into the `appStore`-named view. */
function toView(raw: ConnectionsRegionSnapshot): ConnectionsView {
  return {
    folders: raw.folders ?? [],
    connections: raw.connections ?? [],
  };
}

// ── Transport + shared region client (lazy, mirrors the agents slice) ──────────

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription. */
export function setConnectionTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  resetViewState();
}

function transport(): Transport {
  if (!transportInstance) {
    transportInstance = createTransport();
  }
  return transportInstance;
}

// ── View fan-out (one subscription, many consuming hooks) ──────────────────────

/** A change listener for the projected `connections` view. */
export type ConnectionsViewListener = (view: ConnectionsView) => void;

const viewListeners = new Set<ConnectionsViewListener>();
/** The authoritative view: what the backend region says (disk truth). */
let baseView: ConnectionsView = EMPTY_VIEW;
/** The authoritative region's `savedAs` map, committed with {@link baseView}. */
let baseSavedAs: Readonly<Record<string, string>> = {};
/** In-flight optimistic overlays, in mutation order (#2831). */
let overlays: PendingOverlay[] = [];
/** The effective view every reader sees: {@link baseView} with the pending
 * {@link overlays} applied. Reference-identical to `baseView` with no overlay. */
let lastView: ConnectionsView = EMPTY_VIEW;
// The monotonic region-version guard for `baseView` (FES-006): a projected view
// strictly older than the last applied is a stale, out-of-order delivery and is
// ignored, so it can never clobber a newer view.
const versionGuard = makeVersionGuard();

/** One in-flight optimistic overlay awaiting its persist result. */
interface PendingOverlay {
  fold: ConnectionsFold;
  /** The client-generated id an add previews its row under (#3961). */
  previewId?: string;
}

/** Options for {@link persistWithOverlay}. */
export interface PersistOverlayOptions {
  /**
   * For an add: the client-generated id the preview row uses. Once the
   * authoritative region reports that id as saved (its `savedAs` map), the
   * overlay stops applying, so the preview is replaced by the saved row rather
   * than shown next to it (#3961).
   */
  previewId?: string;
}

/** Whether the authoritative region already carries this overlay's row. */
function hasLanded(entry: PendingOverlay): boolean {
  return (
    entry.previewId !== undefined &&
    Object.prototype.hasOwnProperty.call(baseSavedAs, entry.previewId)
  );
}

/** Drop every overlay and the cached view (tests / re-init). */
function resetViewState(): void {
  baseView = EMPTY_VIEW;
  baseSavedAs = {};
  overlays = [];
  lastView = EMPTY_VIEW;
  versionGuard.reset();
}

/** Recompute the effective view from the base and the overlays, and notify. */
function recomputeAndEmit(): void {
  lastView = overlays.reduce<ConnectionsView>(
    (view, o) => (hasLanded(o) ? view : o.fold(view)),
    baseView
  );
  for (const listener of viewListeners) {
    try {
      listener(lastView);
    } catch (err) {
      logConnectionBridgeFallback("reconcile", err);
    }
  }
}

/**
 * Commit a projected view (at its region `version`) as the authoritative base and
 * notify subscribers, unless it is stale (a version strictly older than the last
 * applied). On today's substrate versions arrive monotonically so the guard never
 * drops a valid update — it only adds out-of-order protection.
 */
function commitConnectionsView(
  view: ConnectionsView,
  version: number,
  savedAs: Readonly<Record<string, string>> = baseSavedAs
): void {
  if (!versionGuard.shouldApply(version)) return;
  baseView = view;
  baseSavedAs = savedAs;
  recomputeAndEmit();
}

/**
 * Register a listener, invoked with the projected view on every diff. Returns an
 * unsubscribe. The region client is started on first use.
 */
export function onConnectionsView(listener: ConnectionsViewListener): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

/**
 * Ensure the shared `connections` region client is subscribed so projected diffs
 * are received and fanned out to the {@link onConnectionsView} listeners.
 * Idempotent and de-duplicated across concurrent callers; a transport/subscribe
 * failure is logged and rethrown so the caller can fall back to `appStore`.
 */
export function ensureConnectionsSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), CONNECTIONS_REGION);
    client.onChange((state) => {
      const raw = (state.view ?? {}) as ConnectionsRegionSnapshot;
      commitConnectionsView(toView(raw), state.version, raw.savedAs ?? {});
    });
    startPromise = client
      .start()
      .then(() => {
        regionClient = client;
        return client;
      })
      .catch((err) => {
        startPromise = null;
        logConnectionBridgeFallback("subscribe", err);
        throw err;
      });
  }
  return startPromise;
}

/** Drop the region subscription (tests / re-init). */
export function stopConnectionsSubscription(): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  resetViewState();
}

/** The last view fanned out (for a hook that subscribes after the first diff). */
export function currentConnectionsView(): ConnectionsView {
  return lastView;
}

/**
 * Test-only: synchronously commit a projected view at an explicit region `version`
 * through the same guarded path a real diff takes, so a test can drive the
 * stale-drop / apply behaviour without standing up a transport double. Never call
 * from production code.
 */
export function __emitConnectionsViewForTest(view: ConnectionsView, version: number): void {
  commitConnectionsView(view, version);
}

/**
 * Test seam: synchronously set the cached region view and fan it to listeners,
 * standing in for the server-side fold so a unit/component test can drive the
 * authoritative region without a live backend. Not used in production.
 */
export function setConnectionsViewForTest(view: ConnectionsView): void {
  baseView = { folders: view.folders, connections: view.connections };
  recomputeAndEmit();
}

// ── Persist-confirmed optimistic overlay (#2831) ──────────────────────────────

/**
 * Test seam standing in for the backend's persist fold: invoked with the overlay
 * fold of every persist that **succeeded**, before the overlay is dropped, so a
 * unit / component test with mocked persist commands (and so no real fold) can
 * land the change in its seeded region the way production's fold would. `null`
 * clears it. Never set in production code.
 */
let persistedFoldSinkForTest: ((fold: ConnectionsFold) => void) | null = null;

/** Install (or clear, with `null`) the {@link persistedFoldSinkForTest} seam. */
export function setPersistedFoldSinkForTest(sink: ((fold: ConnectionsFold) => void) | null): void {
  persistedFoldSinkForTest = sink;
}

/**
 * Run a connection-tree mutation through its persist command — the single
 * authoritative writer of the `connections` region — with instant optimistic
 * feedback (#2831).
 *
 * `fold` is applied to the effective view **synchronously**, as a client-local
 * overlay over the authoritative region; nothing is written to the backend
 * region from here. The overlay's lifecycle is driven by the persist result:
 *
 * - **resolved** → the persist's server-side fold has published the change; the
 *   bridge catches the region up to the backend's current version
 *   ({@link ProjectionClient.catchUp}) and then drops the overlay, so the
 *   authoritative view supersedes it with no gap in between.
 * - **rejected** → the backend re-folded the disk truth (the failed write changed
 *   nothing, or exactly what reached disk); the bridge catches up and drops the
 *   overlay, so the view is byte-identical to disk — membership and order —
 *   with no compensating write.
 *
 * The returned promise settles only after the overlay is dropped: it resolves
 * with the persist result, or rejects with the persist error, so a caller that
 * reads {@link currentConnectionsView} after awaiting it sees the authoritative
 * outcome (e.g. a rename's recomputed id, #875). A synchronous throw from
 * `persist` is treated as a rejection. A failing catch-up is logged and the
 * overlay dropped anyway — an overlay is never stranded; the region stream
 * still converges.
 *
 * For an add, pass the preview row's client-generated id as
 * `options.previewId`: the overlay then yields to the saved row as soon as the
 * region reports it saved, whichever of the diff and the reply lands first
 * (#3961).
 */
export function persistWithOverlay<T>(
  fold: ConnectionsFold,
  persist: () => Promise<T>,
  options: PersistOverlayOptions = {}
): Promise<T> {
  const entry: PendingOverlay = { fold, previewId: options.previewId };
  overlays.push(entry);
  recomputeAndEmit();

  let persisted: Promise<T>;
  try {
    persisted = persist();
  } catch (err) {
    persisted = Promise.reject(err);
  }
  return persisted.then(
    async (value) => {
      await settleOverlay(entry, true);
      return value;
    },
    async (err: unknown) => {
      await settleOverlay(entry, false);
      throw err;
    }
  );
}

/** Catch the region up to the backend, then drop the overlay. */
async function settleOverlay(entry: PendingOverlay, persisted: boolean): Promise<void> {
  try {
    await regionClient?.catchUp();
  } catch (err) {
    logConnectionBridgeFallback("catch-up", err);
  }
  if (persisted && persistedFoldSinkForTest) persistedFoldSinkForTest(entry.fold);
  const index = overlays.indexOf(entry);
  if (index === -1) return; // reset while in flight
  overlays.splice(index, 1);
  recomputeAndEmit();
}

/** Log a bridge failure so it is visible in the LogViewer. */
export function logConnectionBridgeFallback(kind: string, err: unknown): void {
  const message = errorMessage(err);
  frontendLog("connection_bridge", `${kind} failed: ${message}`);
}
