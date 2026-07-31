/**
 * Settings projection bridge — Phase 5 render cut of the Settings domain (#2227,
 * part of #2153 / #2139).
 *
 * The Settings **shadow** (PR #2260) landed a backend-authoritative
 * [`SettingsStore`](../../src-tauri/src/settings_projection/store.rs) served as the
 * shared `settings` projection region, with `settings.*` intents, but nothing in
 * the UI touched it. This step makes the **Settings screen** source the persisted
 * `AppSettings` document from that region — the parity-safe render cut (the direct
 * analog of the system-monitor render cut
 * {@link import("./systemMonitorBridge")}, #2224, and the agents render cut
 * {@link import("./agentsBridge")}, #2226).
 *
 * # The settings document is opaque
 *
 * `AppSettings` is one large, open-ended JSON document the app loads and saves as a
 * whole. The Rust store models it opaquely (see the shadow's `store.rs`); the
 * region snapshot **is** that document, so the projected view maps one-to-one to
 * the frontend {@link AppSettings} shape and the render cut is a pure parity swap.
 *
 * # Strangler safety — flag-gated, on by default, faithful-mirror gate
 *
 * The `appStore` settings slice is still authoritative (the mutation cut is a later
 * step). To keep the render cut parity-safe **independent of any mutation flag**,
 * the region is kept a faithful copy of `appStore` by {@link seedSettingsRegion} (a
 * `settings.replace` mirror, the analog of the monitor bridge's `monitor.replace`
 * seed), and the UI renders from the region **only when it faithfully mirrors**
 * `appStore` ({@link settingsViewMirrors}); otherwise it falls back to `appStore`
 * verbatim. Because the gate guarantees the projected view deep-equals `appStore`'s
 * slice, the rendered output is byte-identical to the pre-cut path.
 *
 * Gated by {@link settingsRenderFromProjectionEnabled} — **on by default**.
 * Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_SETTINGS_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.settingsRenderFromProjection"]` (set `"false"` to render
 * straight from `appStore`).
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
 * view maps one-to-one to the frontend {@link AppSettings} shape and rendering from
 * it is a pure parity swap.
 */
export type SettingsView = AppSettings;

// ── Render-cut feature flag (runtime-flippable, on by default) ─────────────────

let renderFlagOverride: boolean | null = null;

interface SettingsRenderFlagWindow {
  __TERMIHUB_SETTINGS_RENDER_FROM_PROJECTION__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the render-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setSettingsRenderFromProjectionEnabled(value: boolean | null): void {
  renderFlagOverride = value;
}

/**
 * Whether the Settings screen renders the persisted `AppSettings` document from the
 * projected `settings` region instead of reading `appStore`'s settings slice
 * directly.
 *
 * **On by default** — the render cut is parity-safe: the UI renders from the region
 * only when it faithfully mirrors `appStore` ({@link settingsViewMirrors}), and
 * otherwise falls back to `appStore` verbatim, so the output is byte-identical to
 * the pre-cut path. Independent of the (later) mutation cut: the region is kept a
 * mirror of `appStore` by {@link seedSettingsRegion}, so it is always populated.
 * Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_SETTINGS_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.settingsRenderFromProjection"]`.
 */
export function settingsRenderFromProjectionEnabled(): boolean {
  if (renderFlagOverride !== null) return renderFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as SettingsRenderFlagWindow;
      if (typeof w.__TERMIHUB_SETTINGS_RENDER_FROM_PROJECTION__ === "boolean") {
        return w.__TERMIHUB_SETTINGS_RENDER_FROM_PROJECTION__;
      }
      const ls = w.localStorage?.getItem("termihub.settingsRenderFromProjection");
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

interface SettingsMutationFlagWindow {
  __TERMIHUB_SETTINGS_INTENTS__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the mutation-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setSettingsIntentsEnabled(value: boolean | null): void {
  mutationFlagOverride = value;
}

/**
 * Whether the settings mutations (`updateSettings` whole-document save,
 * `updateShellIntegration`'s targeted field write, and the update-skip
 * refreshes) dispatch `settings.*` intents so the backend
 * {@link import("../../src-tauri/src/settings_projection/store").SettingsStore}
 * becomes authoritative — instead of only the render-cut {@link seedSettingsRegion}
 * `settings.replace` mirror driving the region.
 *
 * **On by default** (#2227 mutation cut). When on, each setter mirrors its
 * transition through a `settings.*` intent (via {@link mirrorSettingsIntent}) — a
 * whole-document `settings.replace` for `updateSettings`, a `settings.patch` for
 * the shell-integration field write — and the render-cut hook
 * ({@link import("./useProjectedSettings").useProjectedSettings}) reflects the
 * region back into the Settings UI. The local `appStore` reducer path stays in
 * place as the render source and as a resilience / rollback fallback — any dispatch
 * failure is logged and the local mutation continues, so a backend hiccup can never
 * break the Settings screen (the reducer removal is a later step). The persistence
 * side-effect (`saveSettings` / `save_shell_integration_settings`) is untouched:
 * the intent is dispatched alongside it, not in place of it. When off, `appStore`
 * drives the slice purely locally (the pre-cut path). The flip was taken on the
 * automated parity tests plus the instant local fallback, mirroring the connections
 * (#2225) and agents (#2226) mutation cuts. Overridable at runtime for rollback /
 * tests via `window.__TERMIHUB_SETTINGS_INTENTS__` or
 * `localStorage["termihub.settingsIntents"]` (set `"false"` to restore the pre-cut
 * local-mutation path; `"true"` to force on).
 */
export function settingsIntentsEnabled(): boolean {
  if (mutationFlagOverride !== null) return mutationFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as SettingsMutationFlagWindow;
      if (typeof w.__TERMIHUB_SETTINGS_INTENTS__ === "boolean") {
        return w.__TERMIHUB_SETTINGS_INTENTS__;
      }
      const ls = w.localStorage?.getItem("termihub.settingsIntents");
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return true;
}

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
  lastView = undefined;
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
// `undefined` until the first diff arrives, so the gate falls back to `appStore`
// before the region has been observed.
let lastView: SettingsView | undefined = undefined;

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
 * and rethrown so the caller can fall back to `appStore`.
 */
export function ensureSettingsSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), SETTINGS_REGION);
    client.onChange((state) => {
      lastView = (state.view ?? {}) as SettingsView;
      for (const listener of viewListeners) {
        try {
          listener(lastView);
        } catch (err) {
          logSettingsBridgeFallback("reconcile", err);
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
  lastView = undefined;
  lastSeededSignature = null;
}

/** The last view fanned out (for a hook that subscribes after the first diff). */
export function currentSettingsView(): SettingsView | undefined {
  return lastView;
}

// ── Seed: keep the region a faithful mirror of appStore (settings.replace) ─────

let lastSeededSignature: string | null = null;

/**
 * Seed the shared region with `appStore`'s whole settings document via a
 * `settings.replace` intent, so the projection tracks `appStore`'s current state
 * while `appStore` stays authoritative (the render-side counterpart to the monitor
 * bridge's seed). The payload is keyed to the Rust intent shape (`{ settings }`).
 * De-duplicated: a document identical to the last seeded one is not re-dispatched.
 * Never throws synchronously — a transport that cannot dispatch surfaces as a
 * rejected promise the caller logs and ignores (staying on the `appStore`
 * fallback). Idempotent server-side: replacing with the same content yields no
 * diff.
 */
export function seedSettingsRegion(settings: AppSettings): Promise<void> {
  const signature = JSON.stringify(settings);
  if (signature === lastSeededSignature) return Promise.resolve();
  // Set before dispatching so concurrent callers (the various Settings panels) do
  // not double-dispatch the same seed.
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
 * render-cut whole-slice mirror only — the settings document is opaque and edited
 * by whole-document save, so `settings.replace` is itself the authoritative
 * mutation for `updateSettings`; {@link seedSettingsRegion} uses the same kind for
 * the (independent) render-cut mirror.
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
 * Fire a `settings.*` intent to keep the backend store authoritative, swallowing
 * and logging any failure so the local `appStore` mutation path is never disrupted
 * by a bridge hiccup (the resilience fallback). A no-op when the mutation cut is
 * disabled ({@link settingsIntentsEnabled} off — the rollback path). Never throws —
 * a synchronous transport-construction failure (non-Tauri, no socket) is caught and
 * logged, leaving the UI on the local slice. The twin of the connections bridge's
 * {@link import("./connectionsBridge").mirrorConnectionIntent} and the agents
 * bridge's {@link import("./agentsBridge").mirrorAgentIntent}.
 */
export function mirrorSettingsIntent(
  kind: SettingsIntentKind,
  payload: Record<string, unknown>
): void {
  if (!settingsIntentsEnabled()) return;
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

// ── Faithful-mirror gate ───────────────────────────────────────────────────────

/**
 * Whether a projected `view` faithfully mirrors `appStore`'s settings document —
 * the gate deciding whether the UI may render from the projection (true) or must
 * fall back to `appStore` (false). A deep value comparison of the whole document;
 * because the projected document maps to {@link AppSettings} one-to-one, a
 * mirroring view is value-identical to the `appStore` slice, so rendering from it
 * can never diverge.
 *
 * The twin of the monitor render cut's `monitorsViewMirrors` and the agents render
 * cut's `agentsViewMirrors`.
 */
export function settingsViewMirrors(
  view: SettingsView | undefined,
  settings: AppSettings
): boolean {
  if (!view) return false;
  return deepEqual(view, settings);
}

/**
 * A structural deep-equal for the JSON-ish settings view model (objects, arrays,
 * and primitives — no functions/dates/maps). Numbers compare with `===`, so an
 * integer that round-tripped through JSON as a float (`14` vs `14.0`) still
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
export function logSettingsBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("settings_bridge", `${kind} fell back to appStore settings: ${message}`);
}
