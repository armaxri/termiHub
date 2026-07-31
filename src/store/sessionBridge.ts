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
 * # Strangler safety — flag-gated, on by default, local fallback retained
 *
 * The cut is gated by {@link sessionIntentsEnabled} — **on by default** (#2152
 * Phase 4). When on, the transitions dispatch `session.*` intents and the backend
 * timer drives the reconnect schedule; the local path stays in place as the render
 * source and as a resilience fallback — any dispatch/subscription failure is
 * logged and the local behaviour continues, so a backend hiccup can never break
 * connect or reconnect. When off, `appStore` drives the lifecycle purely locally
 * (the local `setTimeout` reconnect loop included) — the rollback / resilience
 * path. The flip mirrors the layout mutation cut (#2184). Overridable at runtime
 * for rollback / tests via `window.__TERMIHUB_SESSION_INTENTS__` or
 * `localStorage["termihub.sessionIntents"]` (set `"false"` to restore the pre-cut
 * local-mutation path).
 */

import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type IntentAck,
  type Transport,
} from "@/services/transport";
import type { TerminalAutoReconnectState } from "@/types/terminal";
import { DEFAULT_BACKOFF, type BackoffConfig, type ReconnectPhase } from "@/utils/reconnectBackoff";
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
  | "failed";

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
  | "session.remove";

// ── Feature flag (runtime-flippable, off by default) ───────────────────────────

interface SessionFlagWindow {
  __TERMIHUB_SESSION_INTENTS__?: boolean;
  localStorage?: Storage;
}

let flagOverride: boolean | null = null;

/**
 * Programmatic override for the session-intents flag (tests, and a runtime
 * toggle). `null` clears the override and falls back to the window/localStorage
 * signal, then to the default (off).
 */
export function setSessionIntentsEnabled(value: boolean | null): void {
  flagOverride = value;
}

/**
 * Whether session-lifecycle transitions route through `session.*` intents
 * (step 2) — making the backend store authoritative for status and letting the
 * backend timer driver drive the reconnect loop — instead of `appStore` driving
 * the lifecycle purely locally.
 *
 * **On by default** (#2152 Phase 4). The backend `SessionLifecycleStore` is
 * authoritative for status and the backend timer drives the reconnect schedule;
 * the local path stays in place as the render source and as a resilience fallback
 * (any dispatch/subscription failure falls back to the local lifecycle). The flip
 * was taken on the automated tests — cut-vs-local parity plus deterministic
 * backend-timer coverage plus the instant local fallback — mirroring the layout
 * mutation cut (#2184). Overridable at runtime via
 * `window.__TERMIHUB_SESSION_INTENTS__` or
 * `localStorage["termihub.sessionIntents"]` (set `"false"` to restore the pre-cut
 * local-mutation path; `"true"` to force on).
 */
export function sessionIntentsEnabled(): boolean {
  if (flagOverride !== null) return flagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as SessionFlagWindow;
      if (typeof w.__TERMIHUB_SESSION_INTENTS__ === "boolean") {
        return w.__TERMIHUB_SESSION_INTENTS__;
      }
      const ls = w.localStorage?.getItem("termihub.sessionIntents");
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return true;
}

// ── Render-cut feature flag (step 3 #2204, on by default) ──────────────────────

let renderFlagOverride: boolean | null = null;

interface SessionRenderFlagWindow {
  __TERMIHUB_SESSION_RENDER_FROM_PROJECTION__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the render-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setSessionRenderFromProjectionEnabled(value: boolean | null): void {
  renderFlagOverride = value;
}

/**
 * Whether the terminal overlays render their session status from the projected
 * `session-lifecycle` region (step 3, #2204) instead of reading `appStore`'s
 * status fields directly.
 *
 * **On by default** — the render cut is parity-safe: the overlays render from the
 * region only when it faithfully mirrors `appStore`'s status
 * ({@link projectedReconnectMirrors}), and otherwise fall back to `appStore`
 * verbatim, so the output is byte-identical to the pre-cut path regardless of
 * {@link sessionIntentsEnabled}. Independent of the mutation flag: the local
 * reconnect record seeds the effective view, so it is always populated even when
 * nothing has written the backend region. Overridable at runtime for rollback /
 * tests via `window.__TERMIHUB_SESSION_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.sessionRenderFromProjection"]`.
 */
export function sessionRenderFromProjectionEnabled(): boolean {
  if (renderFlagOverride !== null) return renderFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as SessionRenderFlagWindow;
      if (typeof w.__TERMIHUB_SESSION_RENDER_FROM_PROJECTION__ === "boolean") {
        return w.__TERMIHUB_SESSION_RENDER_FROM_PROJECTION__;
      }
      const ls = w.localStorage?.getItem("termihub.sessionRenderFromProjection");
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return true;
}

// ── Transport + region client (lazy, mirrors the tunnel slice) ─────────────────

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

// A stable per-session client identity for dispatched intents (fan-out / audit
// only; the shared region's diff reaches every subscriber regardless of who
// dispatched it).
const clientId = newClientId();

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription. */
export function setSessionTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
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
 * fallback). Never throws. */
export function mirrorSessionIntent(
  kind: SessionIntentKind,
  sessionId: string,
  error?: string
): void {
  void dispatchSessionIntent(kind, sessionId, error)
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

/**
 * Ensure the `session-lifecycle` region client is subscribed so projected diffs
 * are received and fanned out to the {@link onSessionView} listeners. Idempotent
 * and de-duplicated across concurrent callers; a transport/subscribe failure is
 * logged and rethrown so the caller can fall back to the local path.
 */
export function ensureSessionSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), SESSION_LIFECYCLE_REGION);
    client.onChange((state) => {
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
    });
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
  regionClient?.stop();
  regionClient = null;
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
 * Whether a projected lifecycle's `reconnect` detail faithfully mirrors the
 * local auto-reconnect display `record` — the gate that decides if the overlay
 * may render the countdown from the projection (true) or must fall back to
 * `appStore` (false). Compares the loop's coarse status the region carries
 * (phase / attempt / backoff delay); the per-client presentation the region does
 * not carry (the wall-clock anchor, the on-reconnect command) is out of scope
 * for the gate and re-attached from the local record when composing.
 *
 * The twin of the layout render cut's {@link import("./layoutBridge").viewMatchesTree}.
 */
export function projectedReconnectMirrors(
  projected: ProjectedSessionLifecycle | undefined,
  record: TerminalAutoReconnectState | undefined
): boolean {
  if (!projected || !record) return false;
  const r = projected.reconnect;
  return r.phase === record.phase && r.attempt === record.attempt && r.delayMs === record.delayMs;
}

/**
 * The auto-reconnect display record the disconnect overlay renders, sourced from
 * the projected `session-lifecycle` region when it faithfully mirrors `appStore`
 * ({@link projectedReconnectMirrors}), and otherwise the local `record` verbatim
 * — so the countdown is byte-identical to the pre-cut path.
 *
 * When the region mirrors, the loop numbers (phase / attempt / backoff delay /
 * max attempts) come from the projection via {@link projectedToAutoReconnect},
 * and the per-client presentation the region does not carry — the wall-clock
 * `nextAttemptAt` anchor and the on-reconnect command — is re-attached from the
 * local record (the partial-projection seam, exactly as the layout render cut
 * re-attaches per-tab content onto the projected structure, #2151). Because the
 * gate guarantees the loop numbers already agree, the composed record equals the
 * local one; the projection merely becomes the source of record.
 *
 * `undefined` in ⇒ `undefined` out: no active loop, nothing to render.
 */
export function effectiveAutoReconnect(
  record: TerminalAutoReconnectState | undefined,
  projected: ProjectedSessionLifecycle | undefined
): TerminalAutoReconnectState | undefined {
  if (!record) return undefined;
  if (!sessionRenderFromProjectionEnabled()) return record;
  if (!projectedReconnectMirrors(projected, record)) return record;
  // `now0` reproduces the local anchor exactly: with `nextAttemptAt = now0 +
  // delayMs` and the gate guaranteeing `projected.reconnect.delayMs ===
  // record.delayMs`, the composed `nextAttemptAt` equals the local record's, so
  // the live countdown keeps its fixed wall-clock deadline (never re-anchored per
  // render).
  const now0 = record.nextAttemptAt - projected!.reconnect.delayMs;
  return projectedToAutoReconnect(projected!, now0, record.onReconnectCommand) ?? record;
}

/** Log a bridge fallback so the local-path recovery is visible in the LogViewer. */
export function logSessionBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("session_bridge", `${kind} fell back to local lifecycle: ${message}`);
}
