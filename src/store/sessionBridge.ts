/**
 * Session-lifecycle projection bridge — Phase 4 step 2 of the stateless-UI
 * migration (#2203, part of #2152 / #2139).
 *
 * Phase 4 step 1 (#2202) landed a shadow, backend-authoritative
 * `SessionLifecycleStore` served as the shared `session-lifecycle` projection
 * region, with `session.*` intents, but nothing in the UI touched it. Step 2
 * makes that store authoritative for **session status**: `appStore`'s
 * connect / connected / disconnect / dropped / reconnect / error transitions
 * dispatch `session.*` intents instead of driving the lifecycle purely locally,
 * the backend timer driver drives the reconnect backoff loop's timing (replacing
 * the frontend `setTimeout`), and the projected status is reconciled back into
 * `appStore`'s existing fields so the terminal overlays render exactly as before
 * (the renderer cut is step 3, #2204).
 *
 * # Session identity
 *
 * The frontend's stable lifecycle key is the **tab id** — it survives a reconnect
 * even as the backend session id changes or is briefly absent, which is exactly
 * why the auto-reconnect loop (`appStore.autoReconnectTimers`,
 * `terminalAutoReconnect`) is keyed by tab id. So the bridge uses the tab id as
 * the region's opaque session key; the store treats it as an opaque string.
 *
 * # Backend-authoritative (migration flags removed, #2283)
 *
 * The cut is now unconditional: the lifecycle transitions always dispatch
 * `session.*` intents and the backend `SessionLifecycleStore` is the sole authority
 * for session status; the backend timer drives the reconnect backoff loop (#2205
 * PR-B). The migration flags (`sessionIntentsEnabled` /
 * `sessionRenderFromProjectionEnabled`) and their local-fallback branches were
 * retained through the extended-testing period, then deleted once it proved the cut
 * — the local authoritative reducers they fell back to are gone, so the off-paths
 * were dead. A `session.*` dispatch remains fire-and-forget: any failure is logged
 * (see {@link logSessionBridgeFallback}) and never throws.
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
import type { TerminalAutoReconnectState, TerminalExitInfo } from "@/types/terminal";
import {
  DEFAULT_BACKOFF,
  initialReconnectState,
  reconnectReducer,
  type BackoffConfig,
  type ReconnectPhase,
} from "@/utils/reconnectBackoff";
import { frontendLog } from "@/utils/frontendLog";

/** The projection region id for the session-lifecycle domain (twin of the Rust
 * `SESSION_LIFECYCLE_REGION` const). Shared (Open Design Decision #4). */
export const SESSION_LIFECYCLE_REGION = "session-lifecycle";

// ── Projected shapes (twins of the Rust `SessionLifecycle` serde model) ────────

/** Coarse lifecycle status the UI renders (twin of Rust `SessionStatus`). */
export type ProjectedSessionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "failed"
  /** A resilient **agent** tab re-established its transport on reconnect, but the
   * live agent session it was attached to could not be recovered (agent
   * hard-restart / aged out / daemon died). Terminal state: the frontend renders
   * an explicit "session lost" notice + a manual "start new shell" action rather
   * than silently minting a replacement shell (#2512). Twin of Rust
   * `SessionStatus::SessionLost`. */
  | "sessionLost";

/** Why a session left `connected` (twin of Rust `EndReason`). */
export type ProjectedEndReason = "user" | "unexpected" | "error";

/** The composed auto-reconnect loop detail (twin of the ported `ReconnectState`). */
export interface ProjectedReconnect {
  phase: ReconnectPhase;
  attempt: number;
  delayMs: number;
}

/** The authoritative lifecycle record for one session (twin of Rust `SessionLifecycle`). */
export interface ProjectedSessionLifecycle {
  status: ProjectedSessionStatus;
  reconnect: ProjectedReconnect;
  endReason?: ProjectedEndReason;
  error?: string;
  /** The cause that triggered the current reconnect — the supplementary "why we
   * are reconnecting" note shown while a session is reconnecting (#2442). Twin of
   * the Rust `reconnect_error`. Distinct from `error` (the terminal failure msg). */
  reconnectError?: string;
  /** How this session ended (#2615): the exit cause + code the disconnect overlay
   * derives its heading / subheading wording from. Twin of the Rust
   * `SessionLifecycle.exit` (`TerminalExit` — `{ reason, code }`), structurally
   * identical to the per-client `appStore.terminalExitInfo` slice it re-homes.
   * `undefined` whenever the session has not exited. */
  exit?: TerminalExitInfo;
  /** The **backend** session id the frontend should attach terminal I/O to for
   * this tab, when known (#2457). Twin of the Rust `SessionLifecycle.sessionId`
   * (`backend_session_id`). The region is keyed by the stable tab id; this
   * carries the backend session id that tab currently maps to, so a
   * backend-driven reconnect redrive (#2454) can hand the frontend the new id to
   * re-attach to without calling `create_connection`. `undefined` when there is
   * no live backend session for the tab. */
  sessionId?: string;
}

/** The `session-lifecycle` region view model: `{ sessions: { <id>: … } }`. */
export interface SessionLifecycleView {
  sessions: Record<string, ProjectedSessionLifecycle>;
}

/** The `session.*` intent kinds the bridge dispatches (twins of the Rust routes). */
export type SessionIntentKind =
  | "session.connect"
  | "session.connected"
  | "session.connectFailed"
  | "session.disconnect"
  | "session.dropped"
  | "session.reconnect"
  | "session.reconnectAttempt"
  | "session.reconnectFailed"
  | "session.cancelReconnect"
  | "session.reconnectTrigger"
  | "session.exited"
  | "session.remove";

// ── Transport + region client (lazy, mirrors the tunnel slice) ─────────────────

let transportInstance: Transport | null = null;
/** The region client once its subscription has started (its snapshot adopted). */
let regionClient: ProjectionClient | null = null;
/** The region client instance the moment it is created — before `start()`
 * resolves — so an optimistic dispatch can overlay on it synchronously (#2533).
 * Same object as {@link regionClient} once started. */
let creatingClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

// A stable per-session client identity for dispatched intents (fan-out / audit
// only; the shared region's diff reaches every subscriber regardless of who
// dispatched it).
const clientId = newClientId();

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription. */
export function setSessionTransportForTest(t: Transport | null): void {
  (regionClient ?? creatingClient)?.stop();
  regionClient = null;
  creatingClient = null;
  startPromise = null;
  transportInstance = t;
}

function transport(): Transport {
  if (!transportInstance) {
    transportInstance = createTransport();
  }
  return transportInstance;
}

/** Dispatch a `session.*` intent for a session (tab) id, resolving with the ack. */
export async function dispatchSessionIntent(
  kind: SessionIntentKind,
  sessionId: string,
  error?: string
): Promise<IntentAck> {
  const payload: Record<string, unknown> = { sessionId };
  if (error !== undefined) payload.error = error;
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId });
}

/** Fire a `session.*` intent, swallowing and logging any failure so the local
 * lifecycle path is never disrupted by a bridge hiccup (the resilience
 * fallback). Never throws.
 *
 * When the intent kind carries a synchronous-feedback requirement (it has a
 * registered {@link OPTIMISTIC_SESSION_FOLDS} entry, e.g. `session.connect`), the
 * dispatch is routed through the region client's optimistic-folding path so the
 * projected view reflects the intent immediately — closing the hot-path overlay
 * gap (#2533). Unregistered kinds dispatch without an overlay. */
export function mirrorSessionIntent(
  kind: SessionIntentKind,
  sessionId: string,
  error?: string
): void {
  const fold = OPTIMISTIC_SESSION_FOLDS[kind];
  if (fold) {
    mirrorOptimisticSessionIntent(kind, sessionId, fold, error);
    return;
  }
  void dispatchSessionIntent(kind, sessionId, error)
    .then((ack) => {
      if (ack.status === "rejected") {
        logSessionBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
      }
    })
    .catch((err) => logSessionBridgeFallback(kind, err));
}

/** Dispatch a `session.exited` intent carrying the exit cause + code, resolving
 * with the ack. An async function, so a synchronous transport-build failure (a
 * non-Tauri env without a socket) surfaces as a rejected promise the caller
 * catches — never a synchronous throw. */
async function dispatchSessionExited(
  sessionId: string,
  exit: TerminalExitInfo
): Promise<IntentAck> {
  return transport().dispatch({
    intentId: newIntentId(),
    kind: "session.exited",
    payload: { sessionId, reason: exit.reason, code: exit.code },
    clientId,
  });
}

/** Fire a `session.exited` intent recording how a terminal session ended (#2615):
 * the exit cause + code the disconnect overlay derives its wording from, folded
 * onto the shared `session-lifecycle` region. A pure-metadata write (it does not
 * touch the coarse lifecycle status). Swallows and logs any failure so the local
 * exit path is never disrupted by a bridge hiccup; never throws. */
export function mirrorSessionExited(sessionId: string, exit: TerminalExitInfo): void {
  void dispatchSessionExited(sessionId, exit)
    .then((ack) => {
      if (ack.status === "rejected") {
        logSessionBridgeFallback("session.exited", new Error(ack.error?.message ?? "rejected"));
      }
    })
    .catch((err) => logSessionBridgeFallback("session.exited", err));
}

// ── Optimistic client-side folding (#2533) ─────────────────────────────────────
//
// A dispatching client applies its own `session.*` intent to the local
// projection view synchronously, so the projected read is gap-free — closing the
// hot-path window appStore's synchronous `terminalConnecting` write covers today
// (removed by #2205 PR-B / #2283). ProjectionClient owns the general overlay +
// version-gated reconcile machinery; this file supplies the faithful per-intent
// transform (the client-side twin of the Rust `SessionLifecycleStore` reducer).
// Only the `connecting`-feedback intents are folded — the rest dispatch without
// an overlay, keeping the blast radius minimal.

/** The projected lifecycle for a session entering its initial connect — the twin
 * of the Rust `SessionLifecycle::connecting()` serialisation (every `Option`
 * field is skipped, so only `status` + `reconnect` are present). */
function projectedConnecting(): ProjectedSessionLifecycle {
  return { status: "connecting", reconnect: { ...initialReconnectState } };
}

/** A session-intent optimistic transform: `(view, sessionId, error) => view`,
 * pure and immutable (never mutates the shared baseline). */
type SessionOptimisticFold = (
  view: SessionLifecycleView,
  sessionId: string,
  error: string | undefined
) => SessionLifecycleView;

/**
 * Intents that carry a synchronous-feedback requirement, folded optimistically.
 *
 * `session.connect` sets the tab's lifecycle to `connecting`, matching
 * `SessionLifecycleStore::connect` (a fresh connect resets any prior record) —
 * so the "Connecting…" overlay is gap-free the instant the intent is dispatched,
 * with no local `terminalConnecting` write. Extend this map to add
 * `file-browser` / `layout`-style folds; unregistered kinds dispatch without an
 * overlay (the minimal blast radius on the already-inverted domains).
 */
const OPTIMISTIC_SESSION_FOLDS: Partial<Record<SessionIntentKind, SessionOptimisticFold>> = {
  "session.connect": (view, sessionId) => ({
    ...view,
    sessions: { ...view.sessions, [sessionId]: projectedConnecting() },
  }),
  // A genuine drop that arms the resilient-reconnect loop (#2205 PR-B): surface
  // `reconnecting` synchronously (gap-free) so the disconnect overlay + tab dot
  // switch off the connected state the instant the drop is folded, with no local
  // `terminalReconnectingTabs` write. Twin of the Rust
  // `SessionLifecycleStore::reconnect` fold — feed the engine a `Drop` (idle /
  // connected → `Waiting`, arming the first backoff window; a mid-loop drop is a
  // no-op), force `status = reconnecting`, and clear the stale re-attach id
  // (`sessionId`), end reason and reconnect-trigger cause. The backend redrive is
  // the sole reconnect driver from here — the authoritative diff reconciles the
  // jittered backoff delay this optimistic overlay estimated.
  "session.reconnect": (view, sessionId) => {
    const prev = view.sessions[sessionId];
    const reconnect = reconnectReducer(
      prev?.reconnect ?? initialReconnectState,
      "drop",
      DEFAULT_BACKOFF
    );
    return {
      ...view,
      sessions: {
        ...view.sessions,
        [sessionId]: { status: "reconnecting", reconnect },
      },
    };
  },
  // The transient agent-transport-break reconnecting fold is no longer a client
  // intent: `agent_io_task` folds the `session-lifecycle` region at the backend
  // source (#2556), so there is no optimistic client mirror for it here.
};

/** Dispatch a folded `session.*` intent through the region client so its overlay
 * is applied to the projected view synchronously, then reconciled against the
 * authoritative diff. Never throws (the resilience contract). */
function mirrorOptimisticSessionIntent(
  kind: SessionIntentKind,
  sessionId: string,
  fold: SessionOptimisticFold,
  error?: string
): void {
  let client: ProjectionClient;
  try {
    client = sessionRegionClient();
  } catch (err) {
    // No transport (e.g. non-Tauri without a socket): the optimistic overlay is
    // a hot-path nicety, never a correctness requirement — the plain dispatch
    // path would swallow the same failure. Log and skip.
    logSessionBridgeFallback(kind, err);
    return;
  }

  // Ensure the region is subscribed so the authoritative diff arrives to
  // reconcile (prune) the overlay; a subscribe failure is logged and does not
  // strand the overlay — a later resync/snapshot reconciles it.
  void ensureSessionSubscribed().catch((err) => logSessionBridgeFallback("subscribe", err));

  const payload: Record<string, unknown> = { sessionId };
  if (error !== undefined) payload.error = error;
  const intent: Intent = { intentId: newIntentId(), kind, payload, clientId };

  const overlay: OptimisticFold = (view) =>
    fold((view ?? { sessions: {} }) as SessionLifecycleView, sessionId, error);

  void client
    .dispatchOptimistic(intent, overlay)
    .then((ack) => {
      if (ack.status === "rejected") {
        logSessionBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
      }
    })
    .catch((err) => logSessionBridgeFallback(kind, err));
}

/** A change listener for the reconciled `sessions` view: `(next, prev)`. */
export type SessionViewListener = (
  next: Record<string, ProjectedSessionLifecycle>,
  prev: Record<string, ProjectedSessionLifecycle>
) => void;

const viewListeners = new Set<SessionViewListener>();
let lastSessions: Record<string, ProjectedSessionLifecycle> = {};

/**
 * Register a reconcile listener, invoked with the projected `sessions` map (and
 * the previous one) on every diff. Returns an unsubscribe. Idempotent
 * subscription: the region client is started on first use.
 */
export function onSessionView(listener: SessionViewListener): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

/** Fan a region-client change out to the {@link onSessionView} listeners as the
 * reconciled `sessions` map (and the previous one). */
function fanOutSessionView(state: ProjectionCacheState): void {
  const view = (state.view ?? {}) as Partial<SessionLifecycleView>;
  const next = view.sessions ?? {};
  const prev = lastSessions;
  lastSessions = next;
  for (const listener of viewListeners) {
    try {
      listener(next, prev);
    } catch (err) {
      logSessionBridgeFallback("reconcile", err);
    }
  }
}

/**
 * The region client instance, created (and its change fan-out registered) on
 * first use — **synchronously**, before its subscription has started — so an
 * optimistic dispatch can overlay on it at once (#2533). Returns the started
 * {@link regionClient} once available, else the {@link creatingClient}. Throws
 * only if the transport itself cannot be built (non-Tauri without a socket).
 */
function sessionRegionClient(): ProjectionClient {
  if (regionClient) return regionClient;
  if (!creatingClient) {
    creatingClient = new ProjectionClient(transport(), SESSION_LIFECYCLE_REGION);
    creatingClient.onChange(fanOutSessionView);
  }
  return creatingClient;
}

/**
 * Ensure the `session-lifecycle` region client is subscribed so projected diffs
 * are received and fanned out to the {@link onSessionView} listeners. Idempotent
 * and de-duplicated across concurrent callers; a transport/subscribe failure is
 * logged and rethrown so the caller can fall back to the local path.
 */
export function ensureSessionSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = sessionRegionClient();
    startPromise = client
      .start()
      .then(() => {
        regionClient = client;
        return client;
      })
      .catch((err) => {
        startPromise = null;
        logSessionBridgeFallback("subscribe", err);
        throw err;
      });
  }
  return startPromise;
}

/** Drop the region subscription (tests / re-init). */
export function stopSessionSubscription(): void {
  (regionClient ?? creatingClient)?.stop();
  regionClient = null;
  creatingClient = null;
  startPromise = null;
  lastSessions = {};
}

// ── Await a version, then read the reconciled lifecycle (parity helper) ─────────

function awaitVersion(client: ProjectionClient, version: number, timeoutMs = 4000): Promise<void> {
  if (client.state.version >= version) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`session region did not reach version ${version} in time`));
    }, timeoutMs);
    const unsubscribe = client.onChange((state) => {
      if (state.version >= version) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Dispatch a `session.*` intent and resolve with the resulting projected
 * lifecycle for that session — the authoritative status after the transition.
 * Mirrors {@link import("./layoutBridge").runLayoutIntent}: it subscribes, awaits
 * the produced version, and reads the reconciled view. Used by parity tests to
 * assert the intent path reproduces the local transition.
 *
 * @throws on a rejected intent (the caller falls back to the local path)
 */
export async function runSessionIntent(
  kind: SessionIntentKind,
  sessionId: string,
  error?: string
): Promise<ProjectedSessionLifecycle | undefined> {
  const client = await ensureSessionSubscribed();
  const ack = await dispatchSessionIntent(kind, sessionId, error);
  if (ack.status === "rejected") {
    throw new Error(ack.error?.message ?? `session intent ${kind} rejected`);
  }
  const produced = ack.produced?.find((p) => p.region === SESSION_LIFECYCLE_REGION);
  if (produced) {
    await awaitVersion(client, produced.version);
  }
  const view = client.state.view as SessionLifecycleView | undefined;
  return view?.sessions?.[sessionId];
}

// ── Projected status → appStore display fields (the reconcile mapping) ──────────

/** The backoff schedule the display mapping reports (matches the store's). */
const displayBackoff: BackoffConfig = DEFAULT_BACKOFF;

/**
 * Map a projected lifecycle to the `terminalAutoReconnect` display record the
 * overlay renders, or `null` when no loop is active (idle / connected / gaveup).
 * This reproduces exactly the record `appStore.driveAutoReconnect` builds locally
 * for the `waiting` / `connecting` phases, so reconciling the projected status
 * back into `appStore` is parity-identical to the local path.
 *
 * `now` and `onReconnectCommand` are injected: `nextAttemptAt` is derived from
 * `now + delayMs` (as the local path does with `Date.now()`), and the optional
 * on-reconnect command is echoed from the tab's connection config by the caller.
 */
export function projectedToAutoReconnect(
  projected: ProjectedSessionLifecycle,
  now: number,
  onReconnectCommand?: string
): TerminalAutoReconnectState | null {
  const { phase, attempt, delayMs } = projected.reconnect;
  const cmd = onReconnectCommand ? { onReconnectCommand } : {};
  if (phase === "waiting") {
    return {
      phase: "waiting",
      attempt,
      maxAttempts: displayBackoff.maxAttempts,
      delayMs,
      nextAttemptAt: now + delayMs,
      ...cmd,
    };
  }
  if (phase === "connecting") {
    return {
      phase: "connecting",
      attempt,
      maxAttempts: displayBackoff.maxAttempts,
      delayMs: 0,
      nextAttemptAt: 0,
      ...cmd,
    };
  }
  return null;
}

// ── Render cut: faithful-mirror gate + effective display record (#2204) ─────────

/**
 * The auto-reconnect display record the disconnect overlay renders, sourced
 * **purely** from the projected `session-lifecycle` region — the single source of
 * truth for the reconnect loop since the `appStore` engine was removed (#2205
 * PR-B). Delegates to {@link projectedToAutoReconnect}: the loop numbers (phase /
 * attempt / backoff delay / max attempts) come from the region, and the two
 * per-client presentation values the region does not carry are injected by the
 * caller — the wall-clock `nextAttemptAt` anchor (`now`, fixed once per attempt so
 * the countdown does not re-anchor per render) and the on-reconnect command
 * (read from the tab's connection config).
 *
 * `undefined` when no loop is active for the tab (idle / connected / gaveup).
 */
export function effectiveAutoReconnect(
  projected: ProjectedSessionLifecycle | undefined,
  now: number,
  onReconnectCommand?: string
): TerminalAutoReconnectState | undefined {
  if (!projected) return undefined;
  return projectedToAutoReconnect(projected, now, onReconnectCommand) ?? undefined;
}

// ── Render cut: status / disconnect-error fields (#2205 PR-A) ───────────────────
//
// Phase 4 step 4 (#2205) flips the terminal lifecycle *readers* — the overlays,
// the tab-strip status dot, the split-panel overlay gates and Open Connections —
// off the `appStore` status slices (`terminalConnecting`,
// `terminalReconnectingTabs`, `terminalDisconnectErrors`) and onto the projected
// `session-lifecycle` region. PR-A is the render cut only: the readers consult the
// region, `appStore` keeps its slices + the `driveAutoReconnect` engine + the
// client `session.*` dispatch, and the reducer / authority removal is PR-B.
//
// Each field uses the same faithful-mirror gate as {@link effectiveAutoReconnect}:
// the region sources the render only when its status agrees with `appStore`'s
// slice; otherwise the reader falls back to `appStore` verbatim. Because the gate
// guarantees agreement, the rendered value is byte-identical to the pre-cut path,
// independent of the deferred server-side folds (#2439) — a region that has not
// (yet) observed a drop / disconnect / connect-failure simply falls back to
// `appStore`.

/** The last-known reconciled `session-lifecycle` view (the `sessions` map), for a
 * consumer seeding before its first diff arrives. */
export function currentSessionView(): Record<string, ProjectedSessionLifecycle> {
  return lastSessions;
}

// ── Backend-reattach: resolve the backend session id to attach to (#2457) ───────

/**
 * Resolve the **backend** session id a tab should re-attach terminal I/O to for a
 * backend-driven reconnect (#2457), reading it from the projected
 * `session-lifecycle` region. The server-side reconnect redrive (#2454) publishes
 * the new backend session id to the region keyed by tab id; this awaits that id
 * so the terminal can subscribe output/exit + `setTabSessionId` **without**
 * calling `create_connection`.
 *
 * Resolves with the region's `sessionId` for `tabId` as soon as it is present and
 * not equal to `excludeSessionId` (the prior, now-dead session id, so a stale
 * region value is never mistaken for the fresh one — the store also clears the id
 * on drop, so this is belt-and-suspenders). Resolves to `null` on `isCanceled()`
 * (the effect torn down) or after `timeoutMs` with no id — the caller then falls
 * back to the client redrive, which keeps a not-yet-driven reconnect from
 * stranding the terminal. With #2454 present the redrive publishes the id
 * promptly, so the wait settles at once and the timeout never bites.
 *
 * The region subscription is (re-)ensured so diffs arrive; the listener is
 * registered before the fast-path read so no diff in between is missed.
 */
export function waitForBackendReattachSessionId(
  tabId: string,
  excludeSessionId: string | null | undefined,
  isCanceled: () => boolean,
  timeoutMs = 10000
): Promise<string | null> {
  const accept = (id: string | undefined): id is string =>
    !!id && !(excludeSessionId != null && id === excludeSessionId);

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      resolve(value);
    };

    // Register the listener first so a diff arriving between the fast-path read
    // and the subscription is not lost.
    cleanups.push(
      onSessionView((next) => {
        const id = next[tabId]?.sessionId;
        if (accept(id)) finish(id);
      })
    );

    // Ensure the region is subscribed; a subscribe failure leaves nothing to
    // source the id, so fall back (null) rather than hang.
    ensureSessionSubscribed().catch((err) => {
      logSessionBridgeFallback("subscribe", err);
      finish(null);
    });

    // Fast path: the id may already be in the last-known view.
    const immediate = currentSessionView()[tabId]?.sessionId;
    if (accept(immediate)) {
      finish(immediate);
      return;
    }
    if (isCanceled()) {
      finish(null);
      return;
    }

    const timer = setTimeout(() => finish(null), timeoutMs);
    cleanups.push(() => clearTimeout(timer));
    // Poll cancellation so a torn-down effect stops waiting promptly rather than
    // holding the promise open until the timeout.
    const cancelPoll = setInterval(() => {
      if (isCanceled()) finish(null);
    }, 100);
    cleanups.push(() => clearInterval(cancelPoll));
  });
}

/** The terminal outcome of a backend-driven **agent** reconnect wait (#2476). */
export type BackendAgentReconnectOutcome =
  /** The redrive re-established the transport and published a fresh backend
   * session id — re-attach terminal I/O to it. */
  | { kind: "reattach"; sessionId: string }
  /** The backend park/retry loop exhausted / the session was folded terminal —
   * settle the tab as disconnected (never fall through to the client engine). */
  | { kind: "giveup"; error?: string }
  /** The transport was re-established but the live agent session could not be
   * recovered (#2512): the tab folds to the explicit session-lost notice with a
   * manual "start new shell" action — never a silent replacement shell. */
  | { kind: "sessionLost"; error?: string }
  /** The effect was torn down (`isCanceled`) — abandon the wait, drive nothing. */
  | { kind: "canceled" };

/**
 * Wait for the terminal outcome of a **backend-driven agent reconnect** (#2476),
 * reading the projected `session-lifecycle` region keyed by tab id.
 *
 * This is the agent counterpart to {@link waitForBackendReattachSessionId}, and
 * the crux of the double-drive fix. The direct-SSH wait times out after ~10 s and
 * the caller then falls through to the client redrive — safe for a direct
 * connection, but for an **agent** tab that fall-through re-enters the
 * non-idempotent client agent engine (`connectRemoteAgent` + park + bounded
 * spawn retries), which double-drives the very transport the backend redrive is
 * re-establishing. A prolonged agent drop (the backend park/retry running for
 * minutes) makes that fall-through the common case, not an edge.
 *
 * So this wait instead **stays deferred to the backend loop for as long as the
 * loop is active**, resolving only on a genuine terminal outcome:
 *  - a fresh (non-excluded) `sessionId` appears  ⇒ `reattach` (success),
 *  - `reconnect.phase === "gaveup"` or `status === "failed"`  ⇒ `giveup`
 *    (the backend exhausted its retries),
 *  - `status === "disconnected"` (the loop was cancelled/stopped server-side)
 *    ⇒ `giveup` (settle the tab; no error banner),
 *  - `isCanceled()` (the effect torn down)  ⇒ `canceled`.
 *
 * There is deliberately **no short fall-through timeout** — the tab is never
 * stranded because the backend always reaches one of the terminal states above
 * (success, exhausted-give-up, or user cancel, each folded into the region), and
 * `isCanceled` polling frees the promise the instant the effect unmounts.
 */
export function waitForBackendAgentReconnectOutcome(
  tabId: string,
  excludeSessionId: string | null | undefined,
  isCanceled: () => boolean
): Promise<BackendAgentReconnectOutcome> {
  const acceptId = (id: string | undefined): id is string =>
    !!id && !(excludeSessionId != null && id === excludeSessionId);

  const classify = (
    life: ProjectedSessionLifecycle | undefined
  ): BackendAgentReconnectOutcome | null => {
    if (!life) return null;
    // Success takes precedence: a fresh backend session id means the transport is
    // back, even if a stale phase field has not yet been recomputed.
    if (acceptId(life.sessionId)) return { kind: "reattach", sessionId: life.sessionId };
    // The transport came back but the live agent session was unrecoverable
    // (#2512): a distinct terminal outcome from a plain give-up — the frontend
    // renders the explicit session-lost notice, never a silent new shell.
    if (life.status === "sessionLost") return { kind: "sessionLost", error: life.error };
    if (life.reconnect.phase === "gaveup" || life.status === "failed") {
      return { kind: "giveup", error: life.error };
    }
    if (life.status === "disconnected") return { kind: "giveup" };
    return null;
  };

  return new Promise<BackendAgentReconnectOutcome>((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (value: BackendAgentReconnectOutcome) => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      resolve(value);
    };

    // Register the listener before the fast-path read so no diff in between is lost.
    cleanups.push(
      onSessionView((next) => {
        const outcome = classify(next[tabId]);
        if (outcome) finish(outcome);
      })
    );

    // A subscribe failure leaves nothing to source the outcome — settle as
    // give-up rather than hang, so the tab is never stranded.
    ensureSessionSubscribed().catch((err) => {
      logSessionBridgeFallback("subscribe", err);
      finish({ kind: "giveup" });
    });

    const immediate = classify(currentSessionView()[tabId]);
    if (immediate) {
      finish(immediate);
      return;
    }
    if (isCanceled()) {
      finish({ kind: "canceled" });
      return;
    }

    // No fall-through timeout: wait across the whole backend loop. Poll only for
    // cancellation so a torn-down effect frees the promise promptly.
    const cancelPoll = setInterval(() => {
      if (isCanceled()) finish({ kind: "canceled" });
    }, 100);
    cleanups.push(() => clearInterval(cancelPoll));
  });
}

/**
 * Effective `terminalConnecting[tabId]` for rendering: `true` when the projected
 * status is `connecting` (the region is the sole authority, #2205 PR-B).
 */
export function effectiveConnecting(projected: ProjectedSessionLifecycle | undefined): boolean {
  return projected?.status === "connecting";
}

/**
 * Effective `terminalReconnectingTabs[tabId]` for rendering: `true` when the
 * projected status is `reconnecting` and it mirrors the local bool, otherwise the
 * local bool verbatim.
 */
export function effectiveReconnecting(projected: ProjectedSessionLifecycle | undefined): boolean {
  return projected?.status === "reconnecting";
}

/**
 * Effective `terminalDisconnectErrors[tabId]` for rendering: the projected error
 * when the status is `failed` and the error string mirrors the local one exactly,
 * otherwise the local error verbatim (`undefined` ⇒ no error).
 */
export function effectiveDisconnectError(
  local: string | undefined,
  projected: ProjectedSessionLifecycle | undefined
): string | undefined {
  const projectedError = projected?.status === "failed" ? projected.error : undefined;
  if (projectedError !== local) return local;
  return projectedError;
}

/**
 * Effective `terminalReconnectTriggerErrors[tabId]` for rendering (#2442): the
 * projected `reconnectError` when it mirrors the local trigger error exactly,
 * otherwise the local value verbatim (`undefined` ⇒ no error).
 *
 * Unlike the status-keyed gates above, this reads the region's `reconnectError`
 * field directly rather than off a status: the reconnect-trigger cause is written
 * by its own `session.reconnectTrigger` intent and is meaningful alongside the
 * agent-managed reconnecting phase (which the region does not itself model as a
 * status). The disconnect overlay only surfaces it inside the reconnecting
 * variant, so the value is byte-identical to the pre-cut `appStore` read.
 */
export function effectiveReconnectTriggerError(
  projected: ProjectedSessionLifecycle | undefined
): string | undefined {
  return projected?.reconnectError;
}

/**
 * Effective `terminalExitInfo[tabId]` for rendering (#2615): the projected exit
 * cause from the region when it faithfully mirrors the local slice (same
 * `reason` + `code`), otherwise the local value verbatim (`undefined` ⇒ no exit
 * info). The disconnect overlay reads this to branch its heading / subheading.
 *
 * The faithful-mirror gate guarantees the rendered wording is byte-identical to
 * the pre-cut `appStore` read: the region sources it only when it agrees exactly
 * with the local slice; before the `session.exited` diff lands (or in a non-Tauri
 * transport that cannot subscribe) it falls back to the local slice.
 */
export function effectiveExitInfo(
  local: TerminalExitInfo | undefined,
  projected: ProjectedSessionLifecycle | undefined
): TerminalExitInfo | undefined {
  const p = projected?.exit;
  if (p && local && p.reason === local.reason && p.code === local.code) return p;
  return local;
}

/**
 * Effective `terminalConnecting` map for the list consumers (the tab-strip status
 * dot, Open Connections, the split-panel overlay gates): each `true` key sourced
 * through {@link effectiveConnecting} against the projected view. Byte-identical to
 * `local` — the gate only ever sources a key the local map already carries.
 */
export function effectiveConnectingMap(
  view: Record<string, ProjectedSessionLifecycle>
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [id, life] of Object.entries(view)) {
    if (effectiveConnecting(life)) out[id] = true;
  }
  return out;
}

/** Effective `terminalReconnectingTabs` map, sourced through {@link effectiveReconnecting}. */
export function effectiveReconnectingMap(
  view: Record<string, ProjectedSessionLifecycle>
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [id, life] of Object.entries(view)) {
    if (effectiveReconnecting(life)) out[id] = true;
  }
  return out;
}

/** Effective `terminalDisconnectErrors` map, sourced through {@link effectiveDisconnectError}. */
export function effectiveDisconnectErrorMap(
  local: Record<string, string>,
  view: Record<string, ProjectedSessionLifecycle>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of Object.keys(local)) {
    const eff = effectiveDisconnectError(local[id], view[id]);
    if (eff !== undefined) out[id] = eff;
  }
  return out;
}

/** Log a bridge fallback so the local-path recovery is visible in the LogViewer. */
export function logSessionBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("session_bridge", `${kind} fell back to local lifecycle: ${message}`);
}
