/**
 * Broadcast-membership projection bridge — Phase 4 step 5b render + mutation cut
 * of the broadcast machine (#2242, part of #2206 / #2139).
 *
 * The broadcast **shadow** (PR #2254) landed a backend-authoritative,
 * client-scoped `BroadcastStore` served as the `broadcast@<clientId>` projection
 * region with `broadcast.*` intents, but nothing in the UI touched it. This step
 * makes the broadcast UI (the status-bar pill, the tab badges, the panel
 * ring/glow, the toolbar toggle) source its membership from that region — the
 * parity-safe render cut — and routes the membership actions through the intents
 * so the store becomes authoritative — the flag-gated mutation cut. It mirrors the
 * Monitors render cut ({@link import("./systemMonitorBridge")}, #2224) and the
 * client-scoped `layout` pilot ({@link import("./layoutBridge")}, #2151).
 *
 * # Client-scoped region
 *
 * Unlike the shared `system-monitors` region, broadcast membership is a
 * **per-client input-fan-out overlay over that client's own tabs** (Open Design
 * Decision #4 / #6), so the region is `broadcast@<clientId>` — a stable per-session
 * client identity, mirroring the layout bridge.
 *
 * # Strangler safety — two flags, both on by default
 *
 * - **Render cut** ({@link broadcastRenderFromProjectionEnabled}, on by default).
 *   The region is kept a faithful copy of `appStore`'s broadcast slice by
 *   {@link seedBroadcastRegion} (a `broadcast.replace` mirror, the analog of the
 *   monitors `monitor.replace` seed), and the UI renders from the region **only
 *   when it faithfully mirrors** `appStore` ({@link broadcastViewMirrors}),
 *   otherwise it falls back to `appStore` verbatim — so the rendered output is
 *   value-identical to the pre-cut path.
 * - **Mutation cut** ({@link broadcastIntentsEnabled}, on by default). The
 *   membership actions (`startBroadcast` / `stopBroadcast` / `toggleBroadcast` /
 *   `addBroadcastTarget` / `removeBroadcastTarget` / `refreshBroadcastMembership`)
 *   mirror their transition through granular `broadcast.*` intents (via
 *   {@link mirrorBroadcastIntent}), so the backend store is authoritative. The
 *   local `appStore` reducer path stays in place as the render source and the
 *   resilience / rollback fallback — any dispatch failure is logged and the local
 *   mutation continues, so a backend hiccup can never break broadcast (the reducer
 *   removal is a later step).
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
 * `appStore` `broadcastTargetTabIds` `Set`.
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

// ── Render-cut feature flag (runtime-flippable, on by default) ─────────────────

let renderFlagOverride: boolean | null = null;

interface BroadcastRenderFlagWindow {
  __TERMIHUB_BROADCAST_RENDER_FROM_PROJECTION__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the render-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setBroadcastRenderFromProjectionEnabled(value: boolean | null): void {
  renderFlagOverride = value;
}

/**
 * Whether the broadcast UI renders its membership from the projected
 * `broadcast@<clientId>` region instead of reading `appStore`'s broadcast slice
 * directly.
 *
 * **On by default** — the render cut is parity-safe: the UI renders from the
 * region only when it faithfully mirrors `appStore` ({@link broadcastViewMirrors}),
 * and otherwise falls back to `appStore` verbatim, so the output is value-identical
 * to the pre-cut path. The region is kept a mirror of `appStore` by
 * {@link seedBroadcastRegion}, so it is always populated. Overridable at runtime
 * for rollback / tests via `window.__TERMIHUB_BROADCAST_RENDER_FROM_PROJECTION__`
 * or `localStorage["termihub.broadcastRenderFromProjection"]` (set `"false"` to
 * render straight from `appStore`).
 */
export function broadcastRenderFromProjectionEnabled(): boolean {
  if (renderFlagOverride !== null) return renderFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as BroadcastRenderFlagWindow;
      if (typeof w.__TERMIHUB_BROADCAST_RENDER_FROM_PROJECTION__ === "boolean") {
        return w.__TERMIHUB_BROADCAST_RENDER_FROM_PROJECTION__;
      }
      const ls = w.localStorage?.getItem("termihub.broadcastRenderFromProjection");
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

interface BroadcastMutationFlagWindow {
  __TERMIHUB_BROADCAST_INTENTS__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the mutation-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setBroadcastIntentsEnabled(value: boolean | null): void {
  mutationFlagOverride = value;
}

/**
 * Whether the broadcast membership actions dispatch granular `broadcast.*` intents
 * so the backend {@link BroadcastStore} is authoritative — instead of only the
 * render-cut {@link seedBroadcastRegion} `broadcast.replace` mirror driving the
 * region.
 *
 * **On by default** (#2242 mutation cut). When on, each action mirrors its
 * transition through a `broadcast.*` intent (via {@link mirrorBroadcastIntent}),
 * and the render-cut hook ({@link import("./useProjectedBroadcast").useProjectedBroadcast})
 * reflects the region back into the UI. The local `appStore` reducer path stays in
 * place as the render source and as a resilience / rollback fallback — any dispatch
 * failure is logged and the local mutation continues, so a backend hiccup can never
 * break broadcast (the reducer removal is a later step). When off, `appStore` drives
 * the slice purely locally (the pre-cut path). The flip was taken on the automated
 * parity tests plus the instant local fallback, mirroring the monitors mutation cut
 * (#2224). Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_BROADCAST_INTENTS__` or `localStorage["termihub.broadcastIntents"]`
 * (set `"false"` to restore the pre-cut local-mutation path; `"true"` to force on).
 */
export function broadcastIntentsEnabled(): boolean {
  if (mutationFlagOverride !== null) return mutationFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as BroadcastMutationFlagWindow;
      if (typeof w.__TERMIHUB_BROADCAST_INTENTS__ === "boolean") {
        return w.__TERMIHUB_BROADCAST_INTENTS__;
      }
      const ls = w.localStorage?.getItem("termihub.broadcastIntents");
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return true;
}

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
 * drops any active subscription / seed dedup. */
export function setBroadcastTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastView = EMPTY_BROADCAST_VIEW;
  lastSeededSignature = null;
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
 * logged and rethrown so the caller can fall back to `appStore`.
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
  lastSeededSignature = null;
}

/** The last view fanned out (for a hook that subscribes after the first diff). */
export function currentBroadcastView(): BroadcastView {
  return lastView;
}

// ── Seed: keep the region a faithful mirror of appStore (broadcast.replace) ────

let lastSeededSignature: string | null = null;

/**
 * Seed the region with `appStore`'s whole broadcast slice via a `broadcast.replace`
 * intent, so the projection tracks `appStore`'s current state while `appStore` stays
 * authoritative (the render-side counterpart of the monitors bridge seed).
 * De-duplicated: a slice identical to the last seeded one is not re-dispatched.
 * Never throws synchronously — a transport that cannot dispatch surfaces as a
 * rejected promise the caller logs and ignores (staying on the `appStore` fallback).
 * Idempotent server-side: replacing with the same content yields no diff.
 */
export function seedBroadcastRegion(view: BroadcastView): Promise<void> {
  const signature = JSON.stringify(view);
  if (signature === lastSeededSignature) return Promise.resolve();
  // Set before dispatching so concurrent callers do not double-dispatch the seed.
  lastSeededSignature = signature;
  try {
    return transport()
      .dispatch({
        intentId: newIntentId(),
        kind: "broadcast.replace",
        payload: {
          active: view.active,
          sourceTabId: view.sourceTabId,
          scope: view.scope,
          targetTabIds: view.targetTabIds,
          lastScope: view.lastScope,
        },
        clientId,
      })
      .then((ack: IntentAck) => {
        if (ack.status === "rejected") {
          // Let a later change retry the seed rather than latch on a failure.
          lastSeededSignature = null;
          throw new Error(ack.error?.message ?? "broadcast.replace rejected");
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

// ── Mutation cut: granular broadcast.* intent dispatch ─────────────────────────

/**
 * The granular `broadcast.*` intent kinds the mutation cut dispatches (twins of the
 * Rust routes). Excludes `broadcast.replace`, which is the render-cut whole-state
 * mirror ({@link seedBroadcastRegion}); the mutation cut drives the region through
 * these per-transition intents instead so the store becomes authoritative.
 * `toggle` is covered by the store's own `start`/`stop` (which the reducer delegates
 * to), so the frontend mirrors the resolved `start`/`stop` rather than a separate
 * `broadcast.toggle`.
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
 * Fire a granular `broadcast.*` intent to keep the backend store authoritative,
 * swallowing and logging any failure so the local `appStore` mutation path is never
 * disrupted by a bridge hiccup (the resilience fallback). A no-op when the mutation
 * cut is disabled ({@link broadcastIntentsEnabled} off — the rollback path). Never
 * throws — a synchronous transport-construction failure (non-Tauri, no socket) is
 * caught and logged, leaving the UI on the local slice. The twin of the monitors
 * bridge's {@link import("./systemMonitorBridge").dispatchMonitorIntentBestEffort}.
 */
export function mirrorBroadcastIntent(
  kind: BroadcastIntentKind,
  payload: Record<string, unknown>
): void {
  if (!broadcastIntentsEnabled()) return;
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

// ── Faithful-mirror gate ───────────────────────────────────────────────────────

/**
 * The `appStore` broadcast slice, shaped for the mirror comparison. `targetTabIds`
 * is the live `Set` (order-independent membership is what the UI reads: `.has()`,
 * `.size`, and the connected-terminal filter).
 */
export interface BroadcastSlice {
  active: boolean;
  sourceTabId: string | null;
  scope: BroadcastScope;
  targetTabIds: Set<string>;
  lastScope: BroadcastScope;
}

/** Compare a projected `targetTabIds` array with an `appStore` `Set` as sets. */
function targetsEqual(view: string[], slice: Set<string>): boolean {
  if (view.length !== slice.size) return false;
  for (const id of view) {
    if (!slice.has(id)) return false;
  }
  return true;
}

/**
 * Whether a projected `view` faithfully mirrors `appStore`'s broadcast slice — the
 * gate deciding whether the UI may render from the projection (true) or must fall
 * back to `appStore` (false). `active` / `sourceTabId` / `scope` / `lastScope`
 * compare by value; `targetTabIds` compares as a **set** (order-independent), since
 * the UI reads membership, size, and the connected filter, never order. A mirroring
 * view is value-identical to what the UI renders from `appStore`, so rendering from
 * it can never diverge. The twin of the monitors render cut's `monitorsViewMirrors`.
 */
export function broadcastViewMirrors(
  view: BroadcastView | undefined,
  slice: BroadcastSlice
): boolean {
  if (!view) return false;
  return (
    view.active === slice.active &&
    view.sourceTabId === slice.sourceTabId &&
    view.scope === slice.scope &&
    view.lastScope === slice.lastScope &&
    targetsEqual(view.targetTabIds, slice.targetTabIds)
  );
}

/** Log a bridge fallback so the appStore-path recovery is visible in the LogViewer. */
export function logBroadcastBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("broadcast_bridge", `${kind} fell back to appStore broadcast: ${message}`);
}
