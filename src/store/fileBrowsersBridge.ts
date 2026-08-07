/**
 * File-browsers projection bridge — Phase 5 render cut of the File-browsers
 * domain (#2228, part of #2139 and #2153).
 *
 * The File-browsers **shadow** (PR #2272) landed a backend-authoritative,
 * client-scoped
 * [`FileBrowserStore`](../../src-tauri/src/file_browser_projection/store.rs)
 * served as the `file-browser@<clientId>` projection region, with `fileBrowser.*`
 * intents, but nothing in the UI touched it. This step makes the file-browser
 * panel ({@link import("../components/Sidebar/FileBrowser").FileBrowser}, via
 * {@link import("../hooks/useFileBrowser").useFileBrowser}) source its per-pane
 * UI state — the active pane, each pane's cwd / listing / loading / error, and the
 * copy-cut clipboard — from that region: the parity-safe render cut (the direct
 * analog of the client-scoped broadcast render cut
 * {@link import("./broadcastBridge")}, #2242, and the connections render cut
 * {@link import("./connectionsBridge")}, #2225).
 *
 * # Client-scoped region
 *
 * An open file browser — its active pane, each pane's cwd / listing, and the
 * clipboard — is a property of the *viewing client's* pane, not shared
 * infrastructure (Open Design Decision #4 / #6). So, like the client-scoped
 * `broadcast` and `layout` regions, the region is `file-browser@<clientId>` — a
 * stable per-session client identity — and dispatched intents carry the same id.
 *
 * # Scope — the browser *view*, not the session model
 *
 * This bridge mirrors only the **browser view**: which pane is active, each pane's
 * cwd / listing / list-operation loading+error, and the clipboard. It deliberately
 * leaves the backend session model on `appStore` — the live session id
 * (`sessionFileBrowserId`, which gates `isConnected`) and transfers stay `appStore`
 * reads. Since the SFTP convergence (#2313 / #2422) SSH browses through the session
 * pane like every other remote type; the legacy standalone SFTP pane and its
 * `sftpSessionId` model were retired, so only the `local` and `session` panes
 * remain.
 *
 * # Strangler safety — flag-gated, on by default, faithful-mirror gate
 *
 * The `appStore` file-browser slice is still authoritative (the mutation cut is a
 * later step). To keep the render cut parity-safe **independent of any mutation
 * flag**, the region is kept a faithful copy of `appStore` by
 * {@link seedFileBrowsersRegion} (a `fileBrowser.replace` whole-slice mirror, the
 * analog of the broadcast bridge's `broadcast.replace` seed), and the UI renders
 * from the region **only when it faithfully mirrors** `appStore`
 * ({@link fileBrowsersViewMirrors}); otherwise it falls back to `appStore`
 * verbatim. Because the gate guarantees the projected view deep-equals `appStore`'s
 * slice, the rendered output is value-identical to the pre-cut path.
 *
 * Gated by {@link fileBrowsersRenderFromProjectionEnabled} — **on by default**.
 * Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_FILE_BROWSERS_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.fileBrowsersRenderFromProjection"]` (set `"false"` to
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
import type { FileClipboard } from "@/store/appStore";
import type { FileEntry } from "@/types/connection";
import { frontendLog } from "@/utils/frontendLog";

/** The active file-browser pane (twin of the Rust `mode` string; `"none"` is no
 * open browser). Mirrors the frontend `fileBrowserMode`. */
export type FileBrowserMode = "none" | "local" | "session";

/** One browser pane's view: the directory it shows, its listing, and the
 * in-flight/error status of a directory list. Twin of the Rust `Pane::to_view`. */
export interface FileBrowserPaneView {
  path: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
}

/**
 * The `file-browser@<clientId>` region view model — a twin of the Rust store
 * snapshot: the active pane, the two panes (local / session), and the copy-cut
 * clipboard. Each field matches the `appStore` slice one-to-one, so the render
 * cut is a pure parity swap.
 */
export interface FileBrowsersView {
  mode: FileBrowserMode;
  local: FileBrowserPaneView;
  session: FileBrowserPaneView;
  clipboard: FileClipboard | null;
}

/** The idle baseline a pane reports before its first listing (twin of `Pane::default`). */
export const EMPTY_PANE_VIEW: FileBrowserPaneView = {
  path: "/",
  entries: [],
  loading: false,
  error: null,
};

/** The idle baseline a fresh region reports (twin of the empty store snapshot). */
export const EMPTY_FILE_BROWSERS_VIEW: FileBrowsersView = {
  mode: "none",
  local: EMPTY_PANE_VIEW,
  session: EMPTY_PANE_VIEW,
  clipboard: null,
};

// ── Render-cut feature flag (runtime-flippable, on by default) ─────────────────

let renderFlagOverride: boolean | null = null;

interface FileBrowsersRenderFlagWindow {
  __TERMIHUB_FILE_BROWSERS_RENDER_FROM_PROJECTION__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the render-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setFileBrowsersRenderFromProjectionEnabled(value: boolean | null): void {
  renderFlagOverride = value;
}

/**
 * Whether the file-browser panel renders its per-pane UI state from the projected
 * `file-browser@<clientId>` region instead of reading `appStore`'s file-browser
 * slice directly.
 *
 * **On by default** — the render cut is parity-safe: the UI renders from the
 * region only when it faithfully mirrors `appStore` ({@link fileBrowsersViewMirrors}),
 * and otherwise falls back to `appStore` verbatim, so the output is value-identical
 * to the pre-cut path. Independent of the (later) mutation cut: the region is kept
 * a mirror of `appStore` by {@link seedFileBrowsersRegion}, so it is always
 * populated. Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_FILE_BROWSERS_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.fileBrowsersRenderFromProjection"]`.
 */
export function fileBrowsersRenderFromProjectionEnabled(): boolean {
  if (renderFlagOverride !== null) return renderFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as FileBrowsersRenderFlagWindow;
      if (typeof w.__TERMIHUB_FILE_BROWSERS_RENDER_FROM_PROJECTION__ === "boolean") {
        return w.__TERMIHUB_FILE_BROWSERS_RENDER_FROM_PROJECTION__;
      }
      const ls = w.localStorage?.getItem("termihub.fileBrowsersRenderFromProjection");
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

interface FileBrowsersMutationFlagWindow {
  __TERMIHUB_FILE_BROWSERS_INTENTS__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the mutation-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setFileBrowsersIntentsEnabled(value: boolean | null): void {
  mutationFlagOverride = value;
}

/**
 * Whether the file-browser UI-state actions (set the active pane, a pane's
 * directory-list start / success / failure, and the copy-cut clipboard) dispatch
 * granular `fileBrowser.*` intents so the client-scoped backend
 * {@link import("../../src-tauri/src/file_browser_projection/store").FileBrowserStore}
 * is authoritative — instead of only the render-cut {@link seedFileBrowsersRegion}
 * `fileBrowser.replace` whole-slice mirror driving the region.
 *
 * **On by default** (#2228 mutation cut). When on, each action mirrors its
 * transition through a `fileBrowser.*` intent (via {@link mirrorFileBrowserIntent}),
 * and the render-cut hook
 * ({@link import("./useProjectedFileBrowsers").useProjectedFileBrowsers}) reflects
 * the region back into the UI. The local `appStore` reducer path stays in place as
 * the render source and as a resilience / rollback fallback — any dispatch failure
 * is logged and the local mutation continues, so a backend hiccup can never break
 * the file browser (the reducer removal is a later step). When off, `appStore`
 * drives the slice purely locally (the pre-cut path). The flip was taken on the
 * automated parity tests plus the instant local fallback, mirroring the
 * connections (#2225) and agents (#2226) mutation cuts.
 *
 * Scope note: the session list operations mirror only the browser *view* fields
 * (path / listing / list flags); the backend session model (live session ids,
 * transfers) stays `appStore`-driven and is carried into the region by the
 * render-cut `fileBrowser.replace` mirror. Since the SFTP convergence
 * (#2313 / #2422) the legacy standalone SFTP pane and its `sftpSessionId` session
 * model were retired, leaving only the `local` and `session` panes.
 *
 * Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_FILE_BROWSERS_INTENTS__` or
 * `localStorage["termihub.fileBrowsersIntents"]` (set `"false"` to restore the
 * pre-cut local-mutation path; `"true"` to force on).
 */
export function fileBrowsersIntentsEnabled(): boolean {
  if (mutationFlagOverride !== null) return mutationFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as FileBrowsersMutationFlagWindow;
      if (typeof w.__TERMIHUB_FILE_BROWSERS_INTENTS__ === "boolean") {
        return w.__TERMIHUB_FILE_BROWSERS_INTENTS__;
      }
      const ls = w.localStorage?.getItem("termihub.fileBrowsersIntents");
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return true;
}

// ── Transport + client-scoped region client (lazy, mirrors the broadcast slice) ─

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

// A stable per-session client identity. The region is `file-browser@<clientId>` and
// dispatched intents carry the same id, so this checkout mutates and subscribes to
// its own file-browser region (mirroring the client-scoped broadcast bridge).
const clientId = newClientId();

/** The client-scoped projection region id for this session's file browsers. */
export const FILE_BROWSERS_REGION = `file-browser@${clientId}`;

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription / seed dedup. */
export function setFileBrowsersTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastView = EMPTY_FILE_BROWSERS_VIEW;
  lastSeededSignature = null;
}

function transport(): Transport {
  if (!transportInstance) {
    transportInstance = createTransport();
  }
  return transportInstance;
}

// ── View fan-out (one subscription, many consuming hooks) ──────────────────────

/** A change listener for the projected `file-browser` view. */
export type FileBrowsersViewListener = (view: FileBrowsersView) => void;

const viewListeners = new Set<FileBrowsersViewListener>();
let lastView: FileBrowsersView = EMPTY_FILE_BROWSERS_VIEW;

/**
 * Register a listener, invoked with the projected view on every diff. Returns an
 * unsubscribe. The region client is started on first use.
 */
export function onFileBrowsersView(listener: FileBrowsersViewListener): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

/** Normalize a possibly-partial pane view into a full {@link FileBrowserPaneView}. */
function normalizePane(pane: Partial<FileBrowserPaneView> | undefined): FileBrowserPaneView {
  return {
    path: pane?.path ?? "/",
    entries: pane?.entries ?? [],
    loading: pane?.loading ?? false,
    error: pane?.error ?? null,
  };
}

/** Normalize a possibly-partial projected view into a full {@link FileBrowsersView}. */
function normalizeView(view: Partial<FileBrowsersView> | undefined): FileBrowsersView {
  return {
    mode: view?.mode ?? "none",
    local: normalizePane(view?.local),
    session: normalizePane(view?.session),
    clipboard: view?.clipboard ?? null,
  };
}

/**
 * Ensure the `file-browser@<clientId>` region client is subscribed so projected
 * diffs are received and fanned out to the {@link onFileBrowsersView} listeners.
 * Idempotent and de-duplicated across concurrent callers; a transport/subscribe
 * failure is logged and rethrown so the caller can fall back to `appStore`.
 */
export function ensureFileBrowsersSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), FILE_BROWSERS_REGION);
    client.onChange((state) => {
      lastView = normalizeView(state.view as Partial<FileBrowsersView> | undefined);
      for (const listener of viewListeners) {
        try {
          listener(lastView);
        } catch (err) {
          logFileBrowsersBridgeFallback("reconcile", err);
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
        logFileBrowsersBridgeFallback("subscribe", err);
        throw err;
      });
  }
  return startPromise;
}

/** Drop the region subscription (tests / re-init). */
export function stopFileBrowsersSubscription(): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  lastView = EMPTY_FILE_BROWSERS_VIEW;
  lastSeededSignature = null;
}

/** The last view fanned out (for a hook that subscribes after the first diff). */
export function currentFileBrowsersView(): FileBrowsersView {
  return lastView;
}

// ── Seed: keep the region a faithful mirror of appStore (fileBrowser.replace) ───

let lastSeededSignature: string | null = null;

/**
 * Seed the region with `appStore`'s whole file-browser slice via a
 * `fileBrowser.replace` intent, so the projection tracks `appStore`'s current
 * state while `appStore` stays authoritative (the render-side counterpart of the
 * broadcast bridge seed). De-duplicated: a slice identical to the last seeded one
 * is not re-dispatched. Never throws synchronously — a transport that cannot
 * dispatch surfaces as a rejected promise the caller logs and ignores (staying on
 * the `appStore` fallback). Idempotent server-side: replacing with the same
 * content yields no diff.
 */
export function seedFileBrowsersRegion(view: FileBrowsersView): Promise<void> {
  const signature = JSON.stringify(view);
  if (signature === lastSeededSignature) return Promise.resolve();
  // Set before dispatching so concurrent callers do not double-dispatch the seed.
  lastSeededSignature = signature;
  try {
    return transport()
      .dispatch({
        intentId: newIntentId(),
        kind: "fileBrowser.replace",
        payload: {
          mode: view.mode,
          local: view.local,
          session: view.session,
          clipboard: view.clipboard,
        },
        clientId,
      })
      .then((ack: IntentAck) => {
        if (ack.status === "rejected") {
          // Let a later change retry the seed rather than latch on a failure.
          lastSeededSignature = null;
          throw new Error(ack.error?.message ?? "fileBrowser.replace rejected");
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

// ── Mutation cut: granular fileBrowser.* intent dispatch ──────────────────────

/**
 * The concrete browser pane a `fileBrowser.*` load/reset intent targets. Unlike
 * {@link FileBrowserMode}, `"none"` is not a pane — it is the *absence* of an
 * active pane, expressed only through `fileBrowser.setMode`.
 */
export type FileBrowserPane = "local" | "session";

/**
 * The granular `fileBrowser.*` intent kinds the mutation cut dispatches (twins of
 * the Rust routes). Excludes `fileBrowser.replace`, which is the render-cut
 * whole-slice mirror ({@link seedFileBrowsersRegion}); the mutation cut drives the
 * region through these per-transition intents instead so the store becomes
 * authoritative.
 */
export type FileBrowserIntentKind =
  | "fileBrowser.setMode"
  | "fileBrowser.loadStarted"
  | "fileBrowser.loadSucceeded"
  | "fileBrowser.loadFailed"
  | "fileBrowser.setClipboard";

/** Dispatch a granular `fileBrowser.*` intent, resolving with the ack (parity tests). */
export function dispatchFileBrowserIntent(
  kind: FileBrowserIntentKind,
  payload: Record<string, unknown>
): Promise<IntentAck> {
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId });
}

/**
 * Fire a granular `fileBrowser.*` intent to keep the client's backend store
 * authoritative, swallowing and logging any failure so the local `appStore`
 * mutation path is never disrupted by a bridge hiccup (the resilience fallback). A
 * no-op when the mutation cut is disabled ({@link fileBrowsersIntentsEnabled} off —
 * the rollback path). Never throws — a synchronous transport-construction failure
 * (non-Tauri, no socket) is caught and logged, leaving the UI on the local slice.
 * The twin of the connections bridge's
 * {@link import("./connectionsBridge").mirrorConnectionIntent}.
 */
export function mirrorFileBrowserIntent(
  kind: FileBrowserIntentKind,
  payload: Record<string, unknown>
): void {
  if (!fileBrowsersIntentsEnabled()) return;
  try {
    void dispatchFileBrowserIntent(kind, payload)
      .then((ack) => {
        if (ack.status === "rejected") {
          logFileBrowsersBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
        }
      })
      .catch((err) => logFileBrowsersBridgeFallback(kind, err));
  } catch (err) {
    logFileBrowsersBridgeFallback(kind, err);
  }
}

// ── Faithful-mirror gate ───────────────────────────────────────────────────────

/**
 * Whether a projected `view` faithfully mirrors `appStore`'s file-browser slice —
 * the gate deciding whether the UI may render from the projection (true) or must
 * fall back to `appStore` (false). A deep value comparison of the active pane, the
 * three panes and the clipboard; because the projected records match the frontend
 * shapes one-to-one, a mirroring view is value-identical to the `appStore` slice,
 * so rendering from it can never diverge. The twin of the broadcast render cut's
 * `broadcastViewMirrors`.
 */
export function fileBrowsersViewMirrors(
  view: FileBrowsersView | undefined,
  slice: FileBrowsersView
): boolean {
  if (!view) return false;
  return deepEqual(view, slice);
}

/**
 * A structural deep-equal for the JSON-ish file-browsers view model (objects,
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
export function logFileBrowsersBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("file_browsers_bridge", `${kind} fell back to appStore file browsers: ${message}`);
}
