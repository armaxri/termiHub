/**
 * Settings projection bridge — the Settings domain reads the **authoritative**
 * `settings` projection region (#2227 hook-authoritative cut, part of #2153 /
 * #2139).
 *
 * The shared `settings` projection region, backed by the Rust
 * [`SettingsStore`](../../src-tauri/src/settings_projection/store.rs), is the
 * source of truth for the persisted `AppSettings` document (theme, fonts,
 * confirmation prompts, shell integration, editor mappings, …). The backend feeds
 * it **at the source** (#2386): the region is seeded from the persisted
 * `AppSettings` document at startup, and every `save_settings` folds the resolved
 * document into the store — so the region always reflects what was persisted,
 * without any client round-trip.
 *
 * This bridge is the frontend's window onto that region. It:
 *
 * - **subscribes** to the region diffs and fans the projected view out to the
 *   reader hook ({@link import("./useProjectedSettings").useProjectedSettings}),
 *   caching the latest view for synchronous reads ({@link currentSettingsView});
 * - **dispatches** client-originated mutations into the region via the `settings.*`
 *   intents ({@link mirrorSettingsIntent}) — the optimistic write of the
 *   `appStore` settings command wrappers. Since the reducer removal (#2404) the
 *   `appStore` `settings` / `savedSettings` slice is gone, so this is no longer a
 *   "mirror" of a local slice: it **is** the mutation's client-side transition,
 *   applied to the authoritative region ahead of the persist command's
 *   server-side fold (#2386 / #2407).
 *
 * # The settings document is opaque
 *
 * `AppSettings` is one large, open-ended JSON document the app loads and saves as a
 * whole. The Rust store models it opaquely (see the shadow's `store.rs`); the
 * region snapshot **is** that document, so the projected view maps one-to-one to
 * the frontend {@link AppSettings} shape and reading from it is a pure read.
 */

import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type IntentAck,
  type Transport,
} from "@/services/transport";
import type { AppSettings } from "@/types/connection";
import { frontendLog } from "@/utils/frontendLog";

/** The projection region id for the settings domain (twin of the Rust
 * `SETTINGS_REGION` const). Shared (Open Design Decision #4 / #6). */
export const SETTINGS_REGION = "settings";

/**
 * The projected `settings` region view model — the persisted `AppSettings`
 * document itself. The Rust store snapshots the document opaquely, so the region
 * view maps one-to-one to the frontend {@link AppSettings} shape and reading from
 * it is a pure parity swap.
 */
export type SettingsView = AppSettings;

/**
 * The minimal valid `AppSettings` document a consumer sees before the first region
 * diff arrives (twin of the backend store's seed baseline). The backend seeds the
 * region from the persisted document at startup (#2386), so this default only
 * covers the brief window between a hook mounting and the first snapshot — the same
 * pre-hydration window `appStore`'s initial slice covered before the cut. `version`
 * and `externalConnectionFiles` are the only required {@link AppSettings} fields.
 */
export const DEFAULT_SETTINGS_VIEW: SettingsView = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
};

// ── Transport + shared region client (lazy, mirrors the monitor slice) ─────────

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

// A stable per-session client identity for dispatched intents (fan-out / audit
// only; the shared region's diff reaches every subscriber regardless of who
// dispatched it).
const clientId = newClientId();

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription / seed dedup. */
export function setSettingsTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastView = DEFAULT_SETTINGS_VIEW;
  lastViewSignature = JSON.stringify(DEFAULT_SETTINGS_VIEW);
  lastAppliedVersion = -1;
  lastSeededSignature = null;
}

function transport(): Transport {
  if (!transportInstance) {
    transportInstance = createTransport();
  }
  return transportInstance;
}

// ── View fan-out (one subscription, many consuming hooks) ──────────────────────

/** A change listener for the projected `settings` view. */
export type SettingsViewListener = (view: SettingsView) => void;

const viewListeners = new Set<SettingsViewListener>();
// The last projected document received, defaulting to the seed baseline so a
// synchronous read before the first diff still returns a valid document.
let lastView: SettingsView = DEFAULT_SETTINGS_VIEW;
// A content signature of `lastView`, so an identical-content diff (e.g. a resync
// re-delivering the same document with a fresh object identity) does not churn the
// view identity or re-notify subscribers — which would reset a consumer's local
// draft or trigger needless re-renders.
let lastViewSignature: string = JSON.stringify(DEFAULT_SETTINGS_VIEW);
// The monotonic region version of `lastView`. A projected view older than this is
// stale (e.g. an initial subscribe snapshot delivered late, after a newer diff has
// already landed) and is ignored, so it can never clobber the current document.
let lastAppliedVersion = -1;

/**
 * Commit a projected document (at its region `version`) as the current view and
 * notify subscribers — but only when it is not stale and its content actually
 * changed. Ignoring an older version stops a late-delivered snapshot from
 * overwriting a newer document; preserving identity for unchanged content keeps the
 * reader hook's value referentially stable across resyncs.
 */
function commitSettingsView(view: SettingsView, version: number): void {
  if (version < lastAppliedVersion) return;
  lastAppliedVersion = version;
  const signature = JSON.stringify(view);
  if (signature === lastViewSignature) return;
  lastView = view;
  lastViewSignature = signature;
  for (const listener of viewListeners) {
    try {
      listener(view);
    } catch (err) {
      logSettingsBridgeFallback("reconcile", err);
    }
  }
}

/**
 * Register a listener, invoked with the projected view on every diff. Returns an
 * unsubscribe. The region client is started on first use.
 */
export function onSettingsView(listener: SettingsViewListener): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

/**
 * Ensure the shared `settings` region client is subscribed so projected diffs are
 * received and fanned out to the {@link onSettingsView} listeners. Idempotent and
 * de-duplicated across concurrent callers; a transport/subscribe failure is logged
 * and rethrown so the caller can react.
 */
export function ensureSettingsSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), SETTINGS_REGION);
    client.onChange((state) => {
      const view = state.view as Partial<SettingsView> | undefined;
      // Only accept a real document; an empty/absent view keeps the last known one
      // so a reader never sees a document missing its required fields. `state.version`
      // is the region's monotonic version (not the settings doc's `version` field).
      if (view && typeof view.version === "string") {
        commitSettingsView(view as SettingsView, state.version);
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
        logSettingsBridgeFallback("subscribe", err);
        throw err;
      });
  }
  return startPromise;
}

/** Drop the region subscription (tests / re-init). */
export function stopSettingsSubscription(): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  lastView = DEFAULT_SETTINGS_VIEW;
  lastViewSignature = JSON.stringify(DEFAULT_SETTINGS_VIEW);
  lastAppliedVersion = -1;
  lastSeededSignature = null;
}

/**
 * The last projected view received (for a hook that subscribes after the first
 * diff, and for synchronous reads). Since the region is authoritative and the
 * backend feeds every transition at the source (#2386), this is the frontend's
 * current picture of the persisted settings document; before the first diff it is
 * the {@link DEFAULT_SETTINGS_VIEW} baseline.
 */
export function currentSettingsView(): SettingsView {
  return lastView;
}

/**
 * Test-only: synchronously set the projected view and notify subscribers, without
 * the async transport subscribe round-trip. The settings region test harness uses
 * this to mirror an `appStore`-driven test's document into the region immediately,
 * so a reader that renders (or re-renders on a mutation) sees the document without
 * an explicit flush — matching the synchronous behaviour the removed `appStore`
 * fallback used to provide. Never call this from production code.
 */
export function __emitSettingsViewForTest(view: SettingsView, version: number): void {
  commitSettingsView(view, version);
}

// ── Seed: reliably push appStore's document into the region (settings.replace) ─

let lastSeededSignature: string | null = null;

/**
 * Push `appStore`'s whole settings document into the shared region via a
 * `settings.replace` intent, keeping the backend store in step with an `appStore`
 * edit while the reducer removal is completed. **Reliable dispatch**: the returned
 * promise resolves only once the region has accepted the replace and rejects on a
 * rejected ack or a transport failure, so a caller can await the mirror rather than
 * fire-and-forget. The payload is keyed to the Rust intent shape (`{ settings }`).
 * De-duplicated: a document identical to the last seeded one is not re-dispatched
 * (a repeated no-op is idempotent server-side anyway). On any failure the dedup
 * signature is cleared so a later change retries the mirror.
 */
export function seedSettingsRegion(settings: AppSettings): Promise<void> {
  const signature = JSON.stringify(settings);
  if (signature === lastSeededSignature) return Promise.resolve();
  // Set before dispatching so concurrent callers do not double-dispatch the seed.
  lastSeededSignature = signature;
  try {
    return transport()
      .dispatch({
        intentId: newIntentId(),
        kind: "settings.replace",
        payload: { settings },
        clientId,
      })
      .then((ack: IntentAck) => {
        if (ack.status === "rejected") {
          // Let a later change retry the seed rather than latch on a failure.
          lastSeededSignature = null;
          throw new Error(ack.error?.message ?? "settings.replace rejected");
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

// ── Mutation cut: settings.* intent dispatch ──────────────────────────────────

/**
 * The `settings.*` intent kinds the mutation cut dispatches (twins of the Rust
 * routes on the {@link import("../../src-tauri/src/settings_projection/store").SettingsStore}):
 * `settings.replace` overwrites the whole document (the `updateSettings` /
 * update-refresh whole-document save), `settings.patch` shallow-merges a partial
 * document (the shell-integration field write), and `settings.reset` restores the
 * default baseline. Unlike the connection/agent cuts — where `*.replace` is the
 * whole-slice mirror only — the settings document is opaque and edited by
 * whole-document save, so `settings.replace` is itself the authoritative mutation
 * for `updateSettings`; {@link seedSettingsRegion} uses the same kind for the
 * appStore→region mirror.
 */
export type SettingsIntentKind = "settings.replace" | "settings.patch" | "settings.reset";

/** Dispatch a `settings.*` intent, resolving with the ack (parity tests). */
export function dispatchSettingsIntent(
  kind: SettingsIntentKind,
  payload: Record<string, unknown>
): Promise<IntentAck> {
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId });
}

/**
 * Fire a `settings.*` intent against the authoritative region — the optimistic
 * write of the `appStore` settings command wrappers. Since the reducer removal
 * (#2404) the `appStore` `settings` / `savedSettings` slice is gone, so this is no
 * longer a "mirror" of a local mutation: it **is** the mutation's client-side
 * transition, applied to the shared `settings` region ahead of the persist
 * command's authoritative server-side fold (#2386 / #2407) so the UI updates
 * instantly. Best-effort: any dispatch failure is swallowed and logged (the paired
 * persist command still folds the reconciled truth into the region), and a
 * synchronous transport-construction failure (non-Tauri, no socket) is caught too,
 * so it never throws out of a command wrapper. The twin of the connections
 * bridge's {@link import("./connectionsBridge").mirrorConnectionIntent} and the
 * agents bridge's {@link import("./agentsBridge").mirrorAgentIntent}.
 */
export function mirrorSettingsIntent(
  kind: SettingsIntentKind,
  payload: Record<string, unknown>
): void {
  try {
    void dispatchSettingsIntent(kind, payload)
      .then((ack) => {
        if (ack.status === "rejected") {
          logSettingsBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
        }
      })
      .catch((err) => logSettingsBridgeFallback(kind, err));
  } catch (err) {
    logSettingsBridgeFallback(kind, err);
  }
}

/** Log a bridge dispatch failure so it is visible in the LogViewer. */
export function logSettingsBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("settings_bridge", `${kind} settings intent failed: ${message}`);
}
