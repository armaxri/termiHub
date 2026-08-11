/**
 * File-browsers projection bridge — the file-browser panel reads the
 * **authoritative** client-scoped `file-browser@<clientId>` region (#2228
 * hook-authoritative cut, part of #2139 / #2153; reducer removal #2283).
 *
 * The client-scoped region, backed by the Rust
 * [`FileBrowserStore`](../../src-tauri/src/file_browser_projection/store.rs), is the
 * source of truth for the file-browser *view*: the active pane, each pane's cwd /
 * listing / list-operation loading+error, and the copy-cut clipboard. Since the
 * reducer removal (#2283) the `appStore` file-browser slice is gone, so this bridge
 * is no longer a "mirror" of a local slice — it **is** the mutation path: the
 * `appStore` file-browser actions do the async list op and report each transition
 * through a granular `fileBrowser.*` intent, and every reader sources the view from
 * this region ({@link import("./useProjectedFileBrowsers").useProjectedFileBrowsers}
 * for components, {@link currentFileBrowsersView} for synchronous store-side reads).
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
 * This bridge owns only the **browser view**: which pane is active, each pane's
 * cwd / listing / list-operation loading+error, and the clipboard. It deliberately
 * leaves the backend session model on `appStore` — the live session id
 * (`sessionFileBrowserId`, which gates `isConnected`) and transfers stay `appStore`
 * reads: that id is a per-client pointer to the active terminal session, set
 * imperatively from the active tab, and is not part of the projected view. Since
 * the SFTP convergence (#2313 / #2422) SSH browses through the session pane like
 * every other remote type; the legacy standalone SFTP pane and its `sftpSessionId`
 * model were retired, so only the `local` and `session` panes remain.
 *
 * # Gap-free optimistic folding (#2533)
 *
 * The backend `FileBrowserStore` applies the granular `fileBrowser.*` intents and
 * broadcasts the authoritative diff, but the frontend needs several transitions to
 * be reflected **synchronously** — the loading spinner the instant a navigation
 * starts, the active-pane switch, and the clipboard a paste reads right after a
 * copy. So each mutation is routed through the region client's
 * {@link ProjectionClient.dispatchOptimistic}: the client-side twin of the Rust
 * store reducer ({@link foldFor}) overlays the transition on
 * the projected view at once, then the authoritative diff prunes the overlay when
 * it lands (version-gated reconcile) — zero flash, no double-apply. The region
 * client is created synchronously on first use so the overlay applies before its
 * subscription has even started.
 */

import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type Intent,
  type IntentAck,
  type OptimisticFold,
  type ProjectionCacheState,
  type Transport,
} from "@/services/transport";
import type { FileClipboard } from "@/store/appStore";
import type { FileEntry } from "@/types/connection";
import { frontendLog } from "@/utils/frontendLog";

/** The active file-browser pane (twin of the Rust `mode` string; `"none"` is no
 * open browser). */
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
 * clipboard.
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

// ── Transport + region client (lazy, mirrors the session-lifecycle slice) ──────

let transportInstance: Transport | null = null;
/** The region client once its subscription has started (its snapshot adopted). */
let regionClient: ProjectionClient | null = null;
/** The region client instance the moment it is created — before `start()`
 * resolves — so an optimistic dispatch can overlay on it synchronously (#2533).
 * Same object as {@link regionClient} once started. */
let creatingClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

// A stable per-session client identity. The region is `file-browser@<clientId>` and
// dispatched intents carry the same id, so this checkout mutates and subscribes to
// its own file-browser region (mirroring the client-scoped broadcast bridge).
const clientId = newClientId();

/** The client-scoped projection region id for this session's file browsers. */
export const FILE_BROWSERS_REGION = `file-browser@${clientId}`;

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription / cached view. */
export function setFileBrowsersTransportForTest(t: Transport | null): void {
  (regionClient ?? creatingClient)?.stop();
  regionClient = null;
  creatingClient = null;
  startPromise = null;
  transportInstance = t;
  lastView = EMPTY_FILE_BROWSERS_VIEW;
  lastViewSignature = JSON.stringify(EMPTY_FILE_BROWSERS_VIEW);
  lastAppliedVersion = -1;
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
// The last projected view received, defaulting to the empty baseline so a
// synchronous read before the first diff still returns a valid view.
let lastView: FileBrowsersView = EMPTY_FILE_BROWSERS_VIEW;
// A content signature of `lastView`, so an identical-content emit (e.g. a resync
// re-delivering the same view with a fresh object identity) does not churn the view
// identity or re-notify subscribers.
let lastViewSignature: string = JSON.stringify(EMPTY_FILE_BROWSERS_VIEW);
// The monotonic region version of `lastView`. A projected view strictly older than
// this is stale and ignored, so a late-delivered snapshot can never clobber a newer
// view; an optimistic overlay re-emitted at the same version still commits.
let lastAppliedVersion = -1;

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
 * Commit a projected view (at its region `version`) as the current view and notify
 * subscribers — but only when it is not stale and its content actually changed.
 * Ignoring a strictly-older version stops a late-delivered snapshot from
 * overwriting a newer view; preserving identity for unchanged content keeps the
 * reader hook's value referentially stable. An optimistic overlay re-emitted at the
 * same version still commits (its content changed), so gap-free feedback is not
 * suppressed.
 */
function commitFileBrowsersView(next: FileBrowsersView, version: number): void {
  if (version < lastAppliedVersion) return;
  lastAppliedVersion = version;
  const signature = JSON.stringify(next);
  if (signature === lastViewSignature) return;
  lastView = next;
  lastViewSignature = signature;
  for (const listener of viewListeners) {
    try {
      listener(next);
    } catch (err) {
      logFileBrowsersBridgeFallback("reconcile", err);
    }
  }
}

/**
 * Register a listener, invoked with the projected view on every diff. Returns an
 * unsubscribe. The region client is started on first use.
 */
export function onFileBrowsersView(listener: FileBrowsersViewListener): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

/** Fan a region-client change out to the {@link onFileBrowsersView} listeners. */
function fanOutFileBrowsersView(state: ProjectionCacheState): void {
  commitFileBrowsersView(
    normalizeView(state.view as Partial<FileBrowsersView> | undefined),
    state.version
  );
}

/**
 * The region client instance, created (and its change fan-out registered) on first
 * use — **synchronously**, before its subscription has started — so an optimistic
 * dispatch can overlay on it at once (#2533). Returns the started
 * {@link regionClient} once available, else the {@link creatingClient}. Throws only
 * if the transport itself cannot be built (non-Tauri without a socket).
 */
function fileBrowsersRegionClient(): ProjectionClient {
  if (regionClient) return regionClient;
  if (!creatingClient) {
    creatingClient = new ProjectionClient(transport(), FILE_BROWSERS_REGION);
    creatingClient.onChange(fanOutFileBrowsersView);
  }
  return creatingClient;
}

/**
 * Ensure the `file-browser@<clientId>` region client is subscribed so projected
 * diffs are received and fanned out to the {@link onFileBrowsersView} listeners.
 * Idempotent and de-duplicated across concurrent callers; a transport/subscribe
 * failure is logged and rethrown so the caller can react.
 */
export function ensureFileBrowsersSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = fileBrowsersRegionClient();
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
  (regionClient ?? creatingClient)?.stop();
  regionClient = null;
  creatingClient = null;
  startPromise = null;
  lastView = EMPTY_FILE_BROWSERS_VIEW;
  lastViewSignature = JSON.stringify(EMPTY_FILE_BROWSERS_VIEW);
  lastAppliedVersion = -1;
}

/**
 * The last projected view received (for a hook that subscribes after the first
 * diff, and for synchronous store-side reads). Since the region is authoritative
 * and every mutation overlays its transition synchronously (#2533), this is the
 * frontend's current picture of the file-browser view; before the first diff it is
 * the {@link EMPTY_FILE_BROWSERS_VIEW} baseline.
 */
export function currentFileBrowsersView(): FileBrowsersView {
  return lastView;
}

/**
 * Test-only: synchronously set the projected view and notify subscribers, without
 * the async transport subscribe round-trip. The file-browsers region test harness
 * uses this to seed the region so a reader that renders (or re-renders) sees the
 * view without an explicit flush. Never call this from production code.
 */
export function __emitFileBrowsersViewForTest(view: FileBrowsersView, version: number): void {
  commitFileBrowsersView(normalizeView(view), version);
}

// ── Mutation: granular fileBrowser.* intent dispatch (optimistically folded) ───

/**
 * The concrete browser pane a `fileBrowser.*` load/reset intent targets. Unlike
 * {@link FileBrowserMode}, `"none"` is not a pane — it is the *absence* of an
 * active pane, expressed only through `fileBrowser.setMode`.
 */
export type FileBrowserPane = "local" | "session";

/**
 * The granular `fileBrowser.*` intent kinds the mutation path dispatches (twins of
 * the Rust routes). Excludes `fileBrowser.replace`, the retired render-cut
 * whole-slice mirror — the authoritative path drives the region through these
 * per-transition intents.
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

/** Resolve the concrete pane an intent's payload targets (defaults to `local`). */
function paneOf(pane: unknown): FileBrowserPane {
  return pane === "session" ? "session" : "local";
}

/**
 * The client-side optimistic transform for each `fileBrowser.*` intent — the twin
 * of the Rust `FileBrowserStore` reducer (mirrors `file_browser_projection`). Given
 * the current view and the intent payload, return the view as it should appear once
 * the intent has been applied. Pure and immutable (never mutates the shared
 * baseline). Returns `null` for an unknown kind, so the caller dispatches without an
 * overlay.
 */
function foldFor(
  kind: FileBrowserIntentKind,
  payload: Record<string, unknown>
): OptimisticFold | null {
  switch (kind) {
    case "fileBrowser.setMode":
      return (view) => ({
        ...normalizeView(view as Partial<FileBrowsersView>),
        mode: (payload.mode as FileBrowserMode) ?? "none",
      });
    case "fileBrowser.loadStarted":
      return (view) => {
        const v = normalizeView(view as Partial<FileBrowsersView>);
        const pane = paneOf(payload.pane);
        return { ...v, [pane]: { ...v[pane], loading: true, error: null } };
      };
    case "fileBrowser.loadSucceeded":
      return (view) => {
        const v = normalizeView(view as Partial<FileBrowsersView>);
        const pane = paneOf(payload.pane);
        return {
          ...v,
          [pane]: {
            path: (payload.path as string) ?? v[pane].path,
            entries: (payload.entries as FileEntry[]) ?? [],
            loading: false,
            error: null,
          },
        };
      };
    case "fileBrowser.loadFailed":
      return (view) => {
        const v = normalizeView(view as Partial<FileBrowsersView>);
        const pane = paneOf(payload.pane);
        return {
          ...v,
          [pane]: { ...v[pane], loading: false, error: (payload.error as string | null) ?? null },
        };
      };
    case "fileBrowser.setClipboard":
      return (view) => ({
        ...normalizeView(view as Partial<FileBrowsersView>),
        clipboard: (payload.clipboard as FileClipboard | null) ?? null,
      });
    default:
      return null;
  }
}

/**
 * Apply a `fileBrowser.*` transition to the client's authoritative region: overlay
 * it on the projected view synchronously (so the loading spinner, pane switch, and
 * clipboard are gap-free — #2533), then reconcile against the backend's diff. The
 * `appStore` file-browser actions call this after doing the async list op; there is
 * no local slice to keep in step (the reducer removal, #2283).
 *
 * Never throws (the resilience contract): a synchronous transport-construction
 * failure (non-Tauri, no socket) or a rejected/failed dispatch is caught and
 * logged, leaving the last-known view in place. A no-op / rejected intent rolls its
 * overlay back at once ({@link ProjectionClient.dispatchOptimistic}), so a
 * transition is never stranded.
 */
export function mirrorFileBrowserIntent(
  kind: FileBrowserIntentKind,
  payload: Record<string, unknown>
): void {
  const fold = foldFor(kind, payload);
  let client: ProjectionClient;
  try {
    client = fileBrowsersRegionClient();
  } catch (err) {
    // No transport (e.g. non-Tauri without a socket): the projected view is the
    // only source now, but a failed dispatch is a resilience event, not a crash.
    logFileBrowsersBridgeFallback(kind, err);
    return;
  }

  // Ensure the region is subscribed so the authoritative diff arrives to reconcile
  // (prune) the overlay; a subscribe failure is logged and does not strand it — a
  // later resync/snapshot reconciles it.
  void ensureFileBrowsersSubscribed().catch((err) =>
    logFileBrowsersBridgeFallback("subscribe", err)
  );

  const intent: Intent = { intentId: newIntentId(), kind, payload, clientId };
  const overlay: OptimisticFold = fold ?? ((view) => view);

  void client
    .dispatchOptimistic(intent, overlay)
    .then((ack) => {
      if (ack.status === "rejected") {
        logFileBrowsersBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
      }
    })
    .catch((err) => logFileBrowsersBridgeFallback(kind, err));
}

/** Log a bridge dispatch failure so it is visible in the LogViewer. */
export function logFileBrowsersBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("file_browsers_bridge", `${kind} file-browser intent failed: ${message}`);
}
