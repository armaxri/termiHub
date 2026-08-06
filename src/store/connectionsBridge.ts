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
 * # Scope of this step
 *
 * Only the **sidebar** is authoritative. The `appStore` connections slice is still
 * held for the other, not-yet-migrated readers, and the mutation reducers keep
 * mirroring their transitions through the granular `connection.*` intents
 * ({@link mirrorConnectionIntent}, still gated by {@link connectionIntentsEnabled}).
 * Migrating those remaining readers and removing the `appStore` reducers is a later
 * step.
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

// ── Mutation-cut feature flag (runtime-flippable, on by default) ───────────────

let mutationFlagOverride: boolean | null = null;

interface ConnectionMutationFlagWindow {
  __TERMIHUB_CONNECTION_INTENTS__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the mutation-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setConnectionIntentsEnabled(value: boolean | null): void {
  mutationFlagOverride = value;
}

/**
 * Whether the connection-tree lifecycle actions (add/update/remove/move the saved
 * connections, and add/remove/toggle folders) dispatch granular `connection.*`
 * intents to the backend {@link import("../../src-tauri/src/connections_projection/store").ConnectionsStore}
 * so it tracks each transition (the backend also folds the persisted mutation
 * server-side, #2389 / #2394).
 *
 * **On by default** (#2225 mutation cut). When on, each action mirrors its
 * transition through a `connection.*` intent (via {@link mirrorConnectionIntent}),
 * and the sidebar hook
 * ({@link import("./useProjectedConnections").useProjectedConnections}) reflects
 * the region back into the UI. The local `appStore` reducer path stays in place as
 * the render source for the not-yet-migrated readers and as a resilience / rollback
 * fallback — any dispatch failure is logged and the local mutation continues, so a
 * backend hiccup can never break the connection tree (the reducer removal is a later
 * step). When off, `appStore` drives the slice purely locally (the pre-cut path).
 * The flip was taken on the automated parity tests plus the instant local fallback,
 * mirroring the agents mutation cut (#2226). Overridable at runtime for rollback /
 * tests via
 * `window.__TERMIHUB_CONNECTION_INTENTS__` or
 * `localStorage["termihub.connectionIntents"]` (set `"false"` to restore the
 * pre-cut local-mutation path; `"true"` to force on).
 */
export function connectionIntentsEnabled(): boolean {
  if (mutationFlagOverride !== null) return mutationFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as ConnectionMutationFlagWindow;
      if (typeof w.__TERMIHUB_CONNECTION_INTENTS__ === "boolean") {
        return w.__TERMIHUB_CONNECTION_INTENTS__;
      }
      const ls = w.localStorage?.getItem("termihub.connectionIntents");
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return true;
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
 * Fire a granular `connection.*` intent to keep the backend store authoritative,
 * swallowing and logging any failure so the local `appStore` mutation path is
 * never disrupted by a bridge hiccup (the resilience fallback). A no-op when the
 * mutation cut is disabled ({@link connectionIntentsEnabled} off — the rollback
 * path). Never throws — a synchronous transport-construction failure (non-Tauri,
 * no socket) is caught and logged, leaving the UI on the local slice. The twin of
 * the agents bridge's {@link import("./agentsBridge").mirrorAgentIntent}.
 */
export function mirrorConnectionIntent(
  kind: ConnectionIntentKind,
  payload: Record<string, unknown>
): void {
  if (!connectionIntentsEnabled()) return;
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

/** Log a bridge fallback so the appStore-path recovery is visible in the LogViewer. */
export function logConnectionBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("connection_bridge", `${kind} fell back to appStore connections: ${message}`);
}
