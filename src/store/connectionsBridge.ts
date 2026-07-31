/**
 * Connections projection bridge — Phase 5 render cut of the Connections-tree
 * domain (#2225, part of #2139 and #2153).
 *
 * The Connections **shadow** (PR #2231) landed a backend-authoritative
 * [`ConnectionsStore`](../../src-tauri/src/connections_projection/store.rs)
 * served as the shared `connections` projection region, with `connection.*`
 * intents, but nothing in the UI touched it. This step makes the **connection
 * tree sidebar** ({@link import("../components/Sidebar/ConnectionList").ConnectionList})
 * source the saved-connection / folder inventory from that region — the
 * parity-safe render cut (the direct analog of the agents render cut
 * {@link import("./agentsBridge")}, #2226, and the system-monitor render cut
 * {@link import("./systemMonitorBridge")}, #2224).
 *
 * # Strangler safety — flag-gated, on by default, faithful-mirror gate
 *
 * The `appStore` connections slice is still authoritative (the mutation cut is a
 * later step). To keep the render cut parity-safe **independent of any mutation
 * flag**, the region is kept a faithful copy of `appStore` by
 * {@link seedConnectionsRegion} (a `connection.replace` mirror, the analog of the
 * agents bridge's `agent.replace` seed), and the UI renders from the region
 * **only when it faithfully mirrors** `appStore` ({@link connectionsViewMirrors});
 * otherwise it falls back to `appStore` verbatim. Because the gate guarantees the
 * projected view deep-equals `appStore`'s slice, the rendered output is
 * byte-identical to the pre-cut path.
 *
 * Gated by {@link connectionRenderFromProjectionEnabled} — **on by default**.
 * Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_CONNECTION_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.connectionRenderFromProjection"]` (set `"false"` to
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

// ── Render-cut feature flag (runtime-flippable, on by default) ─────────────────

let renderFlagOverride: boolean | null = null;

interface ConnectionRenderFlagWindow {
  __TERMIHUB_CONNECTION_RENDER_FROM_PROJECTION__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the render-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setConnectionRenderFromProjectionEnabled(value: boolean | null): void {
  renderFlagOverride = value;
}

/**
 * Whether the connection tree sidebar renders the saved-connection / folder
 * inventory from the projected `connections` region instead of reading
 * `appStore`'s connections slice directly.
 *
 * **On by default** — the render cut is parity-safe: the UI renders from the
 * region only when it faithfully mirrors `appStore` ({@link connectionsViewMirrors}),
 * and otherwise falls back to `appStore` verbatim, so the output is byte-identical
 * to the pre-cut path. Independent of the (later) mutation cut: the region is kept
 * a mirror of `appStore` by {@link seedConnectionsRegion}, so it is always
 * populated. Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_CONNECTION_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.connectionRenderFromProjection"]`.
 */
export function connectionRenderFromProjectionEnabled(): boolean {
  if (renderFlagOverride !== null) return renderFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as ConnectionRenderFlagWindow;
      if (typeof w.__TERMIHUB_CONNECTION_RENDER_FROM_PROJECTION__ === "boolean") {
        return w.__TERMIHUB_CONNECTION_RENDER_FROM_PROJECTION__;
      }
      const ls = w.localStorage?.getItem("termihub.connectionRenderFromProjection");
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
 * drops any active subscription / seed dedup. */
export function setConnectionTransportForTest(t: Transport | null): void {
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
  lastSeededSignature = null;
}

/** The last view fanned out (for a hook that subscribes after the first diff). */
export function currentConnectionsView(): ConnectionsView {
  return lastView;
}

// ── Seed: keep the region a faithful mirror of appStore (connection.replace) ───

let lastSeededSignature: string | null = null;

/**
 * Seed the shared region with `appStore`'s whole connections slice via a
 * `connection.replace` intent, so the projection tracks `appStore`'s current
 * state while `appStore` stays authoritative (the render-side counterpart to the
 * agents bridge's seed). The payload is keyed to the Rust snapshot shape
 * (`folders`/`connections`). De-duplicated: a slice identical to the last seeded
 * one is not re-dispatched. Never throws synchronously — a transport that cannot
 * dispatch surfaces as a rejected promise the caller logs and ignores (staying on
 * the `appStore` fallback). Idempotent server-side: replacing with the same
 * content yields no diff.
 */
export function seedConnectionsRegion(
  folders: ConnectionFolder[],
  connections: SavedConnection[]
): Promise<void> {
  const payload = { folders, connections };
  const signature = JSON.stringify(payload);
  if (signature === lastSeededSignature) return Promise.resolve();
  // Set before dispatching so concurrent callers do not double-dispatch the seed.
  lastSeededSignature = signature;
  try {
    return transport()
      .dispatch({
        intentId: newIntentId(),
        kind: "connection.replace",
        payload,
        clientId,
      })
      .then((ack: IntentAck) => {
        if (ack.status === "rejected") {
          // Let a later change retry the seed rather than latch on a failure.
          lastSeededSignature = null;
          throw new Error(ack.error?.message ?? "connection.replace rejected");
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
 * Whether a projected `view` faithfully mirrors `appStore`'s connections slice —
 * the gate deciding whether the UI may render from the projection (true) or must
 * fall back to `appStore` (false). A deep value comparison of the ordered folder
 * and connection arrays; because the projected records match the frontend shapes
 * one-to-one, a mirroring view is value-identical to the `appStore` slice, so
 * rendering from it can never diverge.
 *
 * The twin of the agents render cut's `agentsViewMirrors`.
 */
export function connectionsViewMirrors(
  view: ConnectionsView | undefined,
  folders: ConnectionFolder[],
  connections: SavedConnection[]
): boolean {
  if (!view) return false;
  return deepEqual(view.folders, folders) && deepEqual(view.connections, connections);
}

/**
 * A structural deep-equal for the JSON-ish connections view model (objects,
 * arrays, and primitives — no functions/dates/maps). Numbers compare with `===`,
 * so an integer that round-tripped through JSON as a float (`22` vs `22.0`) still
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
    return aKeys.every(
      (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k])
    );
  }
  return false;
}

/** Log a bridge fallback so the appStore-path recovery is visible in the LogViewer. */
export function logConnectionBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("connection_bridge", `${kind} fell back to appStore connections: ${message}`);
}
