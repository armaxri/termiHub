/**
 * Broadcast-membership projection bridge — the authoritative, client-scoped
 * `broadcast@<clientId>` region (#2206, Phase 4 step 5 of #2139).
 *
 * The broadcast **shadow** (PR #2254) landed a backend-authoritative,
 * client-scoped `BroadcastStore` served as the `broadcast@<clientId>` region with
 * `broadcast.*` intents; the render + mutation cut (#2242) cut the live UI over to
 * it behind flags. This step makes the region **authoritative**: the broadcast UI
 * ({@link import("./useProjectedBroadcast").useProjectedBroadcast}) reads its
 * membership straight from the region, and the `appStore` broadcast actions route
 * every transition through the granular `broadcast.*` intents — the `appStore`
 * reducers, the render/mutation flags, the `broadcast.replace` seed and the
 * faithful-mirror gate are all gone. It mirrors the authoritative Monitors bridge
 * ({@link import("./systemMonitorBridge")}, #2224) and Transfers bridge
 * ({@link import("./transfersBridge")}, #2229).
 *
 * # Client-scoped region
 *
 * Unlike the shared `system-monitors` / `transfers` regions, broadcast membership
 * is a **per-client input-fan-out overlay over that client's own tabs** (Open
 * Design Decision #4 / #6), so the region is `broadcast@<clientId>` — a stable
 * per-session client identity, mirroring the layout bridge.
 *
 * # Non-lossy inversion
 *
 * Broadcast has **no server data source**: the membership machine is a pure
 * appStore-internal overlay driven entirely by client actions, so making the
 * region authoritative routes every transition through a client-dispatched
 * `broadcast.*` intent (there is no server feed to miss). The region's idle
 * baseline ({@link EMPTY_BROADCAST_VIEW}) equals the old `appStore` initial slice,
 * so a fresh session starts populated correctly without any seed.
 *
 * # What stays frontend
 *
 * The scope→tabs resolution (`resolveBroadcastTargetTabIds`), the connected-terminal
 * fan-out filter (`getBroadcastTargetTabIds`), and the dynamic-membership recompute
 * (`refreshBroadcastMembership`) deliberately stay on the frontend — they need the
 * live tab tree the layout machine owns. This bridge owns only the membership
 * orchestration state.
 */

import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type IntentAck,
  type Transport,
} from "@/services/transport";
import type { BroadcastScope } from "@/types/terminal";
import { frontendLog } from "@/utils/frontendLog";

/**
 * The `broadcast@<clientId>` region view model — a twin of the Rust store
 * snapshot. `targetTabIds` is an ordered array (source first) mirroring the
 * former `appStore` `broadcastTargetTabIds` `Set`.
 */
export interface BroadcastView {
  active: boolean;
  sourceTabId: string | null;
  scope: BroadcastScope;
  targetTabIds: string[];
  lastScope: BroadcastScope;
}

/** The idle baseline a fresh region reports (twin of the empty store snapshot). */
export const EMPTY_BROADCAST_VIEW: BroadcastView = {
  active: false,
  sourceTabId: null,
  scope: "all",
  targetTabIds: [],
  lastScope: "all",
};

// ── Transport + client-scoped region client (lazy, mirrors the layout slice) ───

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

// A stable per-session client identity. The region is `broadcast@<clientId>` and
// dispatched intents carry the same id, so this checkout mutates and subscribes to
// its own broadcast region (mirroring the client-scoped layout bridge).
const clientId = newClientId();

/** The client-scoped projection region id for this session's broadcast membership. */
export const BROADCAST_REGION = `broadcast@${clientId}`;

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription. */
export function setBroadcastTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastView = EMPTY_BROADCAST_VIEW;
}

function transport(): Transport {
  if (!transportInstance) {
    transportInstance = createTransport();
  }
  return transportInstance;
}

// ── View fan-out (one subscription, many consuming hooks) ──────────────────────

/** A change listener for the projected `broadcast` view. */
export type BroadcastViewListener = (view: BroadcastView) => void;

const viewListeners = new Set<BroadcastViewListener>();
let lastView: BroadcastView = EMPTY_BROADCAST_VIEW;

/**
 * Register a listener, invoked with the projected view on every diff. Returns an
 * unsubscribe. The region client is started on first use.
 */
export function onBroadcastView(listener: BroadcastViewListener): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

/** Normalize a possibly-partial projected view into a full {@link BroadcastView}. */
function normalizeView(view: Partial<BroadcastView> | undefined): BroadcastView {
  return {
    active: view?.active ?? false,
    sourceTabId: view?.sourceTabId ?? null,
    scope: view?.scope ?? "all",
    targetTabIds: view?.targetTabIds ?? [],
    lastScope: view?.lastScope ?? "all",
  };
}

/**
 * Ensure the `broadcast@<clientId>` region client is subscribed so projected diffs
 * are received and fanned out to the {@link onBroadcastView} listeners. Idempotent
 * and de-duplicated across concurrent callers; a transport/subscribe failure is
 * logged and rethrown so the caller can react.
 */
export function ensureBroadcastSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), BROADCAST_REGION);
    client.onChange((state) => {
      lastView = normalizeView(state.view as Partial<BroadcastView> | undefined);
      for (const listener of viewListeners) {
        try {
          listener(lastView);
        } catch (err) {
          logBroadcastBridgeFallback("reconcile", err);
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
        logBroadcastBridgeFallback("subscribe", err);
        throw err;
      });
  }
  return startPromise;
}

/** Drop the region subscription (tests / re-init). */
export function stopBroadcastSubscription(): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  lastView = EMPTY_BROADCAST_VIEW;
}

/**
 * The last projected view, cached for synchronous store-side reads (the fan-out
 * seam, the membership recompute, the tab-close teardown) and for a hook that
 * subscribes after the first diff. It is the authoritative membership snapshot.
 */
export function currentBroadcastView(): BroadcastView {
  return lastView;
}

// ── Granular broadcast.* intent dispatch (the authoritative mutation path) ─────

/**
 * The granular `broadcast.*` intent kinds the actions dispatch (twins of the Rust
 * routes). Excludes the retired `broadcast.replace` render mirror; the region is
 * now driven purely through these per-transition intents so the store is
 * authoritative. `toggle` is covered by the store's own `start`/`stop` (which the
 * action resolves before dispatching).
 */
export type BroadcastIntentKind =
  | "broadcast.start"
  | "broadcast.stop"
  | "broadcast.addTarget"
  | "broadcast.removeTarget";

/** Dispatch a granular `broadcast.*` intent, resolving with the ack (parity tests). */
export function dispatchBroadcastIntent(
  kind: BroadcastIntentKind,
  payload: Record<string, unknown>
): Promise<IntentAck> {
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId });
}

/**
 * Fire a granular `broadcast.*` intent against the authoritative region, swallowing
 * and logging any failure so a bridge/transport hiccup never throws out of a UI
 * action. Broadcast has no server data source, so these intents are the *only*
 * path that mutates the membership machine — there is no local reducer fallback.
 * Never throws: a synchronous transport-construction failure (non-Tauri, no socket)
 * is caught and logged. The twin of the monitor bridge's
 * {@link import("./systemMonitorBridge").dispatchMonitorIntentBestEffort}.
 */
export function dispatchBroadcastIntentBestEffort(
  kind: BroadcastIntentKind,
  payload: Record<string, unknown>
): void {
  try {
    void dispatchBroadcastIntent(kind, payload)
      .then((ack) => {
        if (ack.status === "rejected") {
          logBroadcastBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
        }
      })
      .catch((err) => logBroadcastBridgeFallback(kind, err));
  } catch (err) {
    logBroadcastBridgeFallback(kind, err);
  }
}

// ── Render slice shape ─────────────────────────────────────────────────────────

/**
 * The broadcast membership slice the UI renders. `targetTabIds` is a `Set`
 * (order-independent membership is what the UI reads: `.has()`, `.size`, and the
 * connected-terminal filter), so this is a drop-in for the former direct
 * `appStore` reads.
 */
export interface BroadcastSlice {
  active: boolean;
  sourceTabId: string | null;
  scope: BroadcastScope;
  targetTabIds: Set<string>;
  lastScope: BroadcastScope;
}

/** Log a bridge dispatch failure so it is visible in the LogViewer. */
export function logBroadcastBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("broadcast_bridge", `${kind} broadcast intent failed: ${message}`);
}
