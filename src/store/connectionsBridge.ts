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
 * connection-tree lifecycle actions are thin backend-command wrappers: each
 * dispatches its granular `connection.*` intent ({@link mirrorConnectionIntent})
 * as the optimistic write, then calls the persist command whose server-side fold
 * (#2389 / #2394) reconciles the authoritative truth back into the region. There
 * is no local slice left to fall back to, so the mutation-cut flag is gone.
 */

import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type IntentAck,
  type Transport,
} from "@/services/transport";
import type { SavedConnection, ConnectionFolder } from "@/types/connection";
import { frontendLog } from "@/utils/frontendLog";

/** The projection region id for the connections-tree domain (twin of the Rust
 * `CONNECTIONS_REGION` const). Shared (Open Design Decision #4). */
export const CONNECTIONS_REGION = "connections";

/**
 * The projected connections view model, in `appStore` terms — a twin of the Rust
 * store snapshot with the frontend slice's field names: the flat folder tree plus
 * the flat saved-connection list, whose nesting is expressed by parent pointers
 * (`ConnectionFolder.parentId`, `SavedConnection.folderId`) and whose ordering is
 * array position. The projected records match the frontend {@link ConnectionFolder}
 * / {@link SavedConnection} shapes one-to-one, so the render cut is a pure parity
 * swap.
 */
export interface ConnectionsView {
  folders: ConnectionFolder[];
  connections: SavedConnection[];
}

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

// A stable per-session client identity for dispatched intents (fan-out / audit
// only; the shared region's diff reaches every subscriber regardless of who
// dispatched it).
const clientId = newClientId();

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription. */
export function setConnectionTransportForTest(t: Transport | null): void {
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

/** A change listener for the projected `connections` view. */
export type ConnectionsViewListener = (view: ConnectionsView) => void;

const viewListeners = new Set<ConnectionsViewListener>();
let lastView: ConnectionsView = EMPTY_VIEW;

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
      lastView = toView((state.view ?? {}) as ConnectionsRegionSnapshot);
      for (const listener of viewListeners) {
        try {
          listener(lastView);
        } catch (err) {
          logConnectionBridgeFallback("reconcile", err);
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
  lastView = EMPTY_VIEW;
}

/** The last view fanned out (for a hook that subscribes after the first diff). */
export function currentConnectionsView(): ConnectionsView {
  return lastView;
}

/**
 * Test seam: synchronously set the cached region view and fan it to listeners,
 * standing in for the server-side fold so a unit/component test can drive the
 * authoritative region without a live backend. Not used in production.
 */
export function setConnectionsViewForTest(view: ConnectionsView): void {
  lastView = { folders: view.folders, connections: view.connections };
  for (const listener of viewListeners) {
    try {
      listener(lastView);
    } catch (err) {
      logConnectionBridgeFallback("reconcile", err);
    }
  }
}

// ── Mutation cut: granular connection.* intent dispatch ───────────────────────

/**
 * The granular `connection.*` intent kinds the mutation cut dispatches (twins of
 * the Rust routes). Excludes the whole-slice `connection.replace` mirror; the
 * mutation reducers drive the region through these per-transition intents so the
 * store tracks each transition.
 */
export type ConnectionIntentKind =
  | "connection.add"
  | "connection.update"
  | "connection.remove"
  | "connection.move"
  | "connection.reorder"
  | "connection.addFolder"
  | "connection.removeFolder"
  | "connection.toggleFolder";

/** Dispatch a granular `connection.*` intent, resolving with the ack (parity tests). */
export function dispatchConnectionIntent(
  kind: ConnectionIntentKind,
  payload: Record<string, unknown>
): Promise<IntentAck> {
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId });
}

/**
 * Fire a granular `connection.*` intent against the authoritative region — the
 * connection-tree lifecycle actions' optimistic write. Since the reducer removal
 * (#2401) the `appStore` `connections` / `folders` slice is gone, so this is no
 * longer a "mirror" of a local mutation: it **is** the mutation's client-side
 * transition, applied to the shared `connections` region ahead of the persist
 * command's authoritative server-side fold (#2389 / #2394) so the UI updates
 * instantly. Best-effort: any dispatch failure is swallowed and logged (the
 * paired persist command still folds the reconciled truth into the region), and a
 * synchronous transport-construction failure (non-Tauri, no socket) is caught too,
 * so it never throws out of a reducer. The twin of the transfers bridge's
 * {@link import("./transfersBridge").dispatchTransferIntentBestEffort}.
 */
export function mirrorConnectionIntent(
  kind: ConnectionIntentKind,
  payload: Record<string, unknown>
): void {
  try {
    void dispatchConnectionIntent(kind, payload)
      .then((ack) => {
        if (ack.status === "rejected") {
          logConnectionBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
        }
      })
      .catch((err) => logConnectionBridgeFallback(kind, err));
  } catch (err) {
    logConnectionBridgeFallback(kind, err);
  }
}

/** Log a bridge dispatch failure so it is visible in the LogViewer. */
export function logConnectionBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("connection_bridge", `${kind} connection intent failed: ${message}`);
}
