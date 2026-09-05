//! The authoritative, shared session-lifecycle state machine behind the shadow
//! `session-lifecycle` projection region (#2152, Phase 4 step 1 of #2139).
//!
//! Models the connect / reconnect / disconnect / error state machine the
//! frontend currently drives per session (`appStore` `terminalConnecting`,
//! `terminalDisconnects`, `terminalAutoReconnect`, disconnect reasons and
//! errors), built on the pure, timer-free auto-reconnect engine ported in #2144
//! (`termihub_core::reconnect_backoff`). This module owns only the lifecycle
//! **status** per session — not tab content, not layout, not broadcast/restore
//! cohorts (those migrate in later phases and stay a clean per-domain boundary).
//!
//! # Shared region — Open Design Decision #4
//!
//! The real sessions already live backend-side and are shared infrastructure
//! (like SSH tunnels, [`crate::tunnel::projection`]): a session's
//! connection/lifecycle status is a property of the session itself, not of a
//! viewing client, so two clients observing the same session see the same
//! status. The region is therefore a single **shared** `session-lifecycle`
//! region, mirroring the tunnels pilot. Per-client presentation affordances (a
//! dismissed disconnect overlay, browsing scrollback in "view mode") are *not*
//! lifecycle and stay a frontend concern under partial projection.
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not authoritative**. The store exists, accepts
//! `session.*` intents, and projects diffs, but nothing in the live UI
//! subscribes to or renders the `session-lifecycle` region, and no frontend code
//! dispatches `session.*` intents yet. The existing `appStore` lifecycle
//! reducers and the terminal overlays remain authoritative. Later steps cut the
//! transitions over, then rendering, then remove the `appStore` state.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use termihub_core::reconnect_backoff::{
    reconnect_reducer, BackoffConfig, ReconnectEvent, ReconnectPhase, ReconnectState,
    DEFAULT_BACKOFF, INITIAL_RECONNECT_STATE,
};

/// Top-level lifecycle status of a single session — the coarse state the UI
/// renders (overlay / spinner / live). The fine-grained auto-reconnect detail
/// (attempt count, backoff delay, waiting-vs-connecting) lives in the composed
/// [`ReconnectState`], authored by the ported #2144 engine.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    /// An initial connect attempt is in flight (the "Connecting…" overlay).
    Connecting,
    /// A live session.
    Connected,
    /// The session ended and is idle (no retry loop running). `end_reason`
    /// says why; a user disconnect and an unexpected drop both land here.
    Disconnected,
    /// An auto-reconnect loop is active; see the composed `reconnect` detail.
    Reconnecting,
    /// A terminal failure: the initial connect errored, or the reconnect loop
    /// exhausted its attempts. `error` carries the message; the user may
    /// manually reconnect.
    Failed,
    /// A distinct terminal state (#2512): a resilient **agent**-hosted tab
    /// re-established its transport on reconnect, but the **live agent session**
    /// it was attached to (its running process, e.g. a compile) could not be
    /// recovered — the agent hard-restarted, the session aged out, or its daemon
    /// died. The desktop deliberately does **not** silently mint a new shell in
    /// its place (maintainer decision); it surfaces this explicit state so the
    /// frontend can render a clear "session lost" notice plus a manual "start new
    /// shell" action. Serialised as `sessionLost` for the frontend to key on.
    #[serde(rename = "sessionLost")]
    SessionLost,
}

/// Why a session left the `Connected` state — drives the disconnect-overlay
/// wording the frontend currently derives from `terminalDisconnectReasons`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EndReason {
    /// The user asked to disconnect (graceful).
    User,
    /// The link dropped without the user asking (a candidate for reconnect).
    Unexpected,
    /// A connect/reconnect attempt errored out.
    Error,
}

/// How a terminal session ended — the region twin of the frontend
/// `TerminalExitReason` (#2615, part of #2612/#2564). Serialised lowercase so the
/// frontend keys on `"clean"` / `"dropped"` / `"killed"` directly.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalExitReason {
    /// The process exited normally (exit code 0 / graceful logout).
    Clean,
    /// The process exited non-zero, or the peer/network connection was lost.
    Dropped,
    /// The user explicitly terminated the session (e.g. Open Connections panel).
    Killed,
}

/// The exit cause + code of a terminal session — the region-authoritative analog
/// of the frontend `TerminalExitInfo` slice (`terminalExitInfo`, #1121). Carried
/// on the shared record so the disconnect overlay can derive its heading /
/// subheading wording from the region rather than the per-client `appStore` slice
/// (#2615). The exit classification is a property of how the session ended (every
/// client observing it sees the same cause), not a per-client presentation
/// affordance, so it belongs on the shared region like [`EndReason`].
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    /// The classified cause used to branch the overlay's wording.
    pub reason: TerminalExitReason,
    /// The process exit code, or `None` when unknown (e.g. a dropped connection).
    /// Serialised as JSON `null` (the frontend twin is `code: number | null`), so
    /// it is **not** skipped when absent — the overlay distinguishes "no code"
    /// (`null`) from a real code.
    pub code: Option<i64>,
}

/// The authoritative lifecycle record for one session.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionLifecycle {
    pub status: SessionStatus,
    /// The composed auto-reconnect loop state (ported #2144 engine). `Idle`
    /// whenever no loop is running.
    pub reconnect: ReconnectState,
    /// Set whenever `status` is `Disconnected` (why it ended); `None` otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<EndReason>,
    /// A human-readable failure message when `status` is `Failed` (or a dropped
    /// session carried one); `None` otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The cause that *triggered* the current reconnect — the error an agent
    /// reported when its link dropped and started re-establishing the session
    /// (#2442). Distinct from [`error`](Self::error): that is the terminal
    /// `Failed` / dropped message, whereas this is the supplementary "why we are
    /// reconnecting" note the disconnect overlay shows *while* a session is
    /// reconnecting. Carried on the shared record because the drop cause is a
    /// property of the session (every client observing it sees the same cause),
    /// not a per-client presentation affordance. Cleared by any lifecycle
    /// resolution (connect / connected / disconnect / dropped / …); `None`
    /// otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconnect_error: Option<String>,
    /// The **backend** session id the frontend should currently be attached to
    /// for this tab, when known (#2457). The region is keyed by the frontend
    /// *tab* id (stable across a reconnect); this carries the *backend* session
    /// id that id currently maps to, so a backend-driven reconnect redrive
    /// (#2454) — which mints a **new** backend session id after tearing the old
    /// `SessionEntry` down — can hand the frontend the id to re-attach terminal
    /// I/O to, without the client calling `create_connection`. Set on a
    /// successful (re)connect via
    /// [`SessionLifecycleStore::set_backend_session_id`]; cleared the moment the
    /// session is torn down (drop / disconnect / reconnect-loop start /
    /// connect-failure / cancel) so the region never advertises a dead id.
    /// `None` whenever there is no live backend session for the tab.
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub backend_session_id: Option<String>,
    /// How this session ended (#2615): the exit cause + code the disconnect
    /// overlay derives its wording from. Set by [`SessionLifecycleStore::set_exit`]
    /// when a terminal session exits (the frontend classifies clean / dropped /
    /// killed at the `terminal-exit` source and mirrors it via `session.exited`);
    /// cleared on any fresh (re)connect (`connect` / `connected` / `reconnect`) so
    /// the region never carries a stale exit for a live session. `None` whenever
    /// the session has not exited. Pure metadata — it does not touch `status`, the
    /// reconnect engine or the backend timer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<TerminalExit>,
}

impl SessionLifecycle {
    /// A session entering its initial connect.
    fn connecting() -> Self {
        Self {
            status: SessionStatus::Connecting,
            reconnect: INITIAL_RECONNECT_STATE,
            end_reason: None,
            error: None,
            reconnect_error: None,
            backend_session_id: None,
            exit: None,
        }
    }
}

/// The rand source used for backoff jitter. Injectable so tests are
/// deterministic; production uses `rand`.
type RandFn = Box<dyn FnMut() -> f64 + Send>;

/// The private mutable core: the per-session map plus the backoff config and the
/// (injectable) jitter source. One mutex guards it so intents never interleave —
/// the substrate's single-writer contract also holds within the store.
struct Inner {
    sessions: HashMap<String, SessionLifecycle>,
    config: BackoffConfig,
    rand: RandFn,
}

impl Inner {
    /// Run one reconnect-engine event for a session, returning the next
    /// [`ReconnectState`]. Reads the session's current reconnect state (Copy) and
    /// the config before borrowing `rand`, so the field borrows stay disjoint.
    fn reconnect_event(
        &mut self,
        current: ReconnectState,
        event: ReconnectEvent,
    ) -> ReconnectState {
        let config = self.config;
        let rand = &mut self.rand;
        let mut adapter = || (*rand)();
        reconnect_reducer(&current, event, &config, &mut adapter)
    }
}

/// The shadow session-lifecycle authority. Owns one [`SessionLifecycle`] per live
/// session, keyed by `sessionId`; an unknown session is created lazily on first
/// touch. The single shared `session-lifecycle` region projects this map.
pub struct SessionLifecycleStore {
    inner: Mutex<Inner>,
}

impl Default for SessionLifecycleStore {
    fn default() -> Self {
        Self::with_config(DEFAULT_BACKOFF)
    }
}

impl SessionLifecycleStore {
    /// A store with no sessions yet, using the default backoff schedule and a
    /// real jitter source.
    pub fn new() -> Self {
        Self::default()
    }

    /// A store with a specific backoff schedule (production wiring may tune this
    /// per the persisted reconnect settings later).
    pub fn with_config(config: BackoffConfig) -> Self {
        Self {
            inner: Mutex::new(Inner {
                sessions: HashMap::new(),
                config,
                rand: Box::new(rand::random::<f64>),
            }),
        }
    }

    /// The render-ready view model for the whole region:
    /// `{ "sessions": { "<sessionId>": SessionLifecycle, ... } }`.
    ///
    /// Pure with respect to lifecycle state (never mutates), so the projector can
    /// safely diff two consecutive snapshots.
    pub fn snapshot(&self) -> Value {
        let inner = self.lock();
        let mut map = Map::with_capacity(inner.sessions.len());
        for (id, lifecycle) in &inner.sessions {
            if let Ok(value) = serde_json::to_value(lifecycle) {
                map.insert(id.clone(), value);
            }
        }
        json!({ "sessions": Value::Object(map) })
    }

    /// `session.connect` — begin an initial connect. Resets any prior state for
    /// the session id (a fresh connect clears a stale error / reconnect loop).
    pub fn connect(&self, session_id: &str) {
        self.lock()
            .sessions
            .insert(session_id.to_string(), SessionLifecycle::connecting());
    }

    /// `session.connected` — a connect or reconnect attempt succeeded. Settles
    /// the session live and, when a reconnect loop was in flight, feeds the
    /// engine a `Success` so the attempt counter resets.
    pub fn connected(&self, session_id: &str) {
        let mut inner = self.lock();
        let current = reconnect_of(&inner, session_id);
        // Only the engine's Connecting sub-phase accepts Success; from a plain
        // initial connect the loop is Idle and the reducer is a no-op.
        let reconnect = if current.phase == ReconnectPhase::Connecting {
            inner.reconnect_event(current, ReconnectEvent::Success)
        } else {
            INITIAL_RECONNECT_STATE
        };
        let entry = inner
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(SessionLifecycle::connecting);
        entry.status = SessionStatus::Connected;
        entry.reconnect = reconnect;
        entry.end_reason = None;
        entry.error = None;
        entry.reconnect_error = None;
        // A fresh live session clears any stale exit cause (#2615) so the region
        // never carries an exit for a connected tab.
        entry.exit = None;
    }

    /// `session.connectFailed` — the initial connect errored. Terminal `Failed`
    /// with the message; the user may retry.
    pub fn connect_failed(&self, session_id: &str, error: Option<String>) {
        let mut inner = self.lock();
        let entry = inner
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(SessionLifecycle::connecting);
        entry.status = SessionStatus::Failed;
        entry.reconnect = INITIAL_RECONNECT_STATE;
        entry.end_reason = Some(EndReason::Error);
        entry.error = error;
        entry.reconnect_error = None;
        // The connect never established a session; nothing to re-attach to (#2457).
        entry.backend_session_id = None;
    }

    /// `session.disconnect` — a user-initiated graceful disconnect. Stops any
    /// reconnect loop and lands in idle `Disconnected` with reason `User`.
    pub fn disconnect(&self, session_id: &str) {
        let mut inner = self.lock();
        let entry = inner
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(SessionLifecycle::connecting);
        entry.status = SessionStatus::Disconnected;
        entry.reconnect = INITIAL_RECONNECT_STATE;
        entry.end_reason = Some(EndReason::User);
        entry.error = None;
        entry.reconnect_error = None;
        // The session is torn down; drop the re-attach id so the region never
        // advertises a dead backend session (#2457).
        entry.backend_session_id = None;
    }

    /// `session.dropped` — the link dropped without the user asking. Lands in
    /// idle `Disconnected` with reason `Unexpected`; arming an auto-reconnect
    /// loop is a separate, opt-in `session.reconnect` (mirrors #1962, where the
    /// disconnect overlay and the resilient-reconnect loop are distinct).
    pub fn dropped(&self, session_id: &str, error: Option<String>) {
        let mut inner = self.lock();
        let entry = inner
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(SessionLifecycle::connecting);
        entry.status = SessionStatus::Disconnected;
        entry.reconnect = INITIAL_RECONNECT_STATE;
        entry.end_reason = Some(EndReason::Unexpected);
        entry.error = error;
        entry.reconnect_error = None;
        // The backend session is gone on a genuine drop; drop the re-attach id
        // (#2457). A backend-driven redrive sets the new id once it reconnects.
        entry.backend_session_id = None;
    }

    /// `session.reconnect` — begin (or restart) the auto-reconnect loop. Feeds
    /// the engine a `Drop`, arming the first backoff window; `status` becomes
    /// `Reconnecting`. A `Drop` from a mid-loop `Waiting`/`Connecting` phase is a
    /// no-op in the engine (the loop is already running).
    pub fn reconnect(&self, session_id: &str) {
        let mut inner = self.lock();
        let current = reconnect_of(&inner, session_id);
        let reconnect = inner.reconnect_event(current, ReconnectEvent::Drop);
        let entry = inner
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(SessionLifecycle::connecting);
        entry.status = SessionStatus::Reconnecting;
        entry.reconnect = reconnect;
        entry.end_reason = None;
        entry.reconnect_error = None;
        // The loop is (re)starting from a dead session; drop the stale re-attach
        // id so the frontend never re-attaches to a corpse (#2457). The redrive
        // repopulates it via `set_backend_session_id` once an attempt succeeds.
        entry.backend_session_id = None;
        // A restart supersedes any prior exit cause (#2615): the tab is coming
        // back, not exited.
        entry.exit = None;
    }

    /// Transient agent-transport-break reconnecting fold (#2555, moved to the
    /// backend source in #2556) — an **agent-hosted** tab's transport hit a
    /// **transient** break that the agent I/O task's own in-task reconnect loop
    /// (`agent_io_task::reconnect_agent`) is re-establishing in place, recovering
    /// the hosted session without tearing it down. Folded at the source via
    /// [`crate::session_projection::projection::fold_agent_transport_reconnecting`]
    /// (no client intent — #2556 retired the `session.agentTransportReconnecting`
    /// mirror).
    ///
    /// Surfaces `Reconnecting` (so the disconnect overlay + tab-strip dot show
    /// honest feedback — the regression #2554 left, where the region-only readers
    /// had no reconnecting source for this case) while deliberately keeping the
    /// reconnect engine **`Idle`**: the transient break is owned by the agent I/O
    /// task, so the client-driven backoff loop must NOT run. Because the backend
    /// timer driver arms only on a `Waiting` phase, an idle loop means the redrive
    /// never starts and never double-drives the transport the agent is already
    /// re-establishing.
    ///
    /// Distinct from [`reconnect`](Self::reconnect), which feeds the engine a
    /// `Drop` (→ `Waiting`, arming the loop): this is a status-only fold. The live
    /// session survives the break in place, so the re-attach id
    /// ([`backend_session_id`](SessionLifecycle::backend_session_id)) is **kept**
    /// (unlike every drop/reconnect path, which clears it). `error` records the
    /// trigger cause the overlay shows while reconnecting. Resolved by the existing
    /// routes: [`connected`](Self::connected) on in-place recovery, or
    /// [`dropped`](Self::dropped) / [`session_lost`](Self::session_lost) / the
    /// backoff loop when the live session did not survive — the region is never
    /// left stuck reconnecting. Creates the entry lazily (mirrors the other folds).
    pub fn agent_transport_reconnecting(&self, session_id: &str, error: Option<String>) {
        let mut inner = self.lock();
        let entry = inner
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(SessionLifecycle::connecting);
        entry.status = SessionStatus::Reconnecting;
        // Idle loop — the agent I/O task owns the transient reconnect; the backend
        // timer (which arms only on `Waiting`) must never start a redrive here.
        entry.reconnect = INITIAL_RECONNECT_STATE;
        entry.end_reason = None;
        entry.reconnect_error = error;
        // The live agent session survives the transient break in place, so its
        // re-attach id stays valid — deliberately NOT cleared (contrast the
        // drop/reconnect paths, whose session is gone).
    }

    /// `session.reconnectAttempt` — the backoff timer fired; start an attempt.
    /// Feeds the engine an `Attempt` (Waiting → Connecting, attempt++). A no-op
    /// outside the `Waiting` phase.
    pub fn reconnect_attempt(&self, session_id: &str) {
        let mut inner = self.lock();
        let current = reconnect_of(&inner, session_id);
        let reconnect = inner.reconnect_event(current, ReconnectEvent::Attempt);
        if let Some(entry) = inner.sessions.get_mut(session_id) {
            entry.reconnect = reconnect;
            // Attempt keeps the loop active; status stays Reconnecting.
            if reconnect.phase != ReconnectPhase::Idle {
                entry.status = SessionStatus::Reconnecting;
            }
        }
    }

    /// `session.reconnectFailed` — the in-flight attempt failed. Feeds the engine
    /// a `Failure`: it either arms the next backoff window (stay `Reconnecting`)
    /// or gives up (terminal `Failed` with the message).
    pub fn reconnect_failed(&self, session_id: &str, error: Option<String>) {
        let mut inner = self.lock();
        let current = reconnect_of(&inner, session_id);
        let reconnect = inner.reconnect_event(current, ReconnectEvent::Failure);
        if let Some(entry) = inner.sessions.get_mut(session_id) {
            entry.reconnect = reconnect;
            if reconnect.phase == ReconnectPhase::Gaveup {
                entry.status = SessionStatus::Failed;
                entry.end_reason = Some(EndReason::Error);
                entry.error = error;
            } else {
                entry.status = SessionStatus::Reconnecting;
            }
        }
    }

    /// `session.cancelReconnect` — the user stopped the retry loop. Feeds the
    /// engine a `Cancel` (→ Gaveup) and drops back to idle `Disconnected` so the
    /// user can browse scrollback or reconnect manually (mirrors #1962 Cancel).
    pub fn cancel_reconnect(&self, session_id: &str) {
        let mut inner = self.lock();
        let current = reconnect_of(&inner, session_id);
        let _ = inner.reconnect_event(current, ReconnectEvent::Cancel);
        if let Some(entry) = inner.sessions.get_mut(session_id) {
            entry.status = SessionStatus::Disconnected;
            entry.reconnect = INITIAL_RECONNECT_STATE;
            entry.end_reason = Some(EndReason::User);
            entry.reconnect_error = None;
            // Loop cancelled; the session is not coming back — drop the re-attach
            // id (#2457).
            entry.backend_session_id = None;
        }
    }

    /// `session.reconnectTrigger` — record (or clear) the cause that triggered a
    /// reconnect for a session (#2442). `Some(msg)` sets the supplementary
    /// "why we are reconnecting" note the disconnect overlay shows while a session
    /// is reconnecting; `None` clears it. This is a pure metadata write: it does
    /// **not** touch `status`, the reconnect engine or the backend timer — the
    /// agent-managed reconnect it accompanies is distinct from the agentless
    /// backoff loop (`reconnect` / `reconnectAttempt`), and every lifecycle
    /// resolution already clears `reconnect_error`. A no-op for an unknown session
    /// (mirrors [`reconnect_attempt`](Self::reconnect_attempt) /
    /// [`reconnect_failed`](Self::reconnect_failed)): the record is only ever set
    /// for a session that has already connected.
    pub fn set_reconnect_trigger(&self, session_id: &str, error: Option<String>) {
        let mut inner = self.lock();
        if let Some(entry) = inner.sessions.get_mut(session_id) {
            entry.reconnect_error = error;
        }
    }

    /// Record (or clear) the **backend** session id the frontend should attach
    /// terminal I/O to for a tab (#2457). `session_id` is the region key (the
    /// frontend tab id); `backend_session_id` is the id of the live backend
    /// session that tab currently maps to (`None` clears it). This is a pure
    /// metadata write — it does not touch `status`, the reconnect engine or the
    /// backend timer.
    ///
    /// Called at the source the instant a (re)connect establishes a session: the
    /// initial-connect fold (`create_connection`) and, later, the backend
    /// reconnect redrive (#2454). A no-op for an unknown session (mirrors
    /// [`set_reconnect_trigger`](Self::set_reconnect_trigger)): the id is only
    /// ever set for a tab whose lifecycle the store already tracks.
    pub fn set_backend_session_id(&self, session_id: &str, backend_session_id: Option<String>) {
        let mut inner = self.lock();
        if let Some(entry) = inner.sessions.get_mut(session_id) {
            entry.backend_session_id = backend_session_id;
        }
    }

    /// `session.exited` — record (or clear) how a terminal session ended (#2615):
    /// the exit cause + code the disconnect overlay derives its heading /
    /// subheading wording from. `session_id` is the region key (the frontend tab
    /// id); `exit` is the classified cause (`None` clears it). This is a pure
    /// metadata write — like [`set_reconnect_trigger`](Self::set_reconnect_trigger)
    /// / [`set_backend_session_id`](Self::set_backend_session_id) it does **not**
    /// touch `status`, the reconnect engine or the backend timer, so it never
    /// perturbs the coarse lifecycle other readers render.
    ///
    /// Creates the entry lazily (mirrors the fold routes): a clean exit is folded
    /// for a tab whose live session had no prior region entry (the frontend
    /// classifies the exit at the `terminal-exit` source before any status intent
    /// for that variant), so the record must exist to carry the cause.
    pub fn set_exit(&self, session_id: &str, exit: Option<TerminalExit>) {
        let mut inner = self.lock();
        let entry = inner
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(SessionLifecycle::connecting);
        entry.exit = exit;
    }

    /// `session.sessionLost` (#2512) — a resilient **agent** tab re-established
    /// its transport on reconnect, but the **live agent session** it was attached
    /// to could not be recovered (agent hard-restart / aged out / daemon died).
    /// Lands in the terminal [`SessionStatus::SessionLost`] state carrying
    /// `error`, so the frontend renders an explicit "session lost" notice with a
    /// manual "start new shell" action rather than the backend silently minting a
    /// replacement shell. Resets the reconnect loop to idle, clears the
    /// re-attach id (the backend session is gone), and records `Unexpected` as the
    /// end reason (the live process was lost, not user-ended). Creates the entry
    /// lazily so the redrive can fold it for a tab the store is already tracking.
    pub fn session_lost(&self, session_id: &str, error: Option<String>) {
        let mut inner = self.lock();
        let entry = inner
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(SessionLifecycle::connecting);
        entry.status = SessionStatus::SessionLost;
        entry.reconnect = INITIAL_RECONNECT_STATE;
        entry.end_reason = Some(EndReason::Unexpected);
        entry.error = error;
        entry.reconnect_error = None;
        // The live agent session could not be recovered; there is no backend
        // session to re-attach to (#2512).
        entry.backend_session_id = None;
    }

    /// `session.remove` — the session/tab is gone; drop it from the region.
    /// Idempotent: removing an unknown session is a no-op.
    pub fn remove(&self, session_id: &str) {
        self.lock().sessions.remove(session_id);
    }

    /// Read a session's current lifecycle (test / diagnostics helper).
    #[cfg(test)]
    pub fn get(&self, session_id: &str) -> Option<SessionLifecycle> {
        self.lock().sessions.get(session_id).cloned()
    }

    /// The current auto-reconnect loop state for a session, or `None` if the
    /// session is unknown. Read by the backend timer driver ([`crate::session_projection::timer`],
    /// #2203) to decide whether to arm a backoff timer (a `Waiting` phase) and
    /// for how long (`delay_ms`).
    pub fn reconnect_state(&self, session_id: &str) -> Option<ReconnectState> {
        self.lock().sessions.get(session_id).map(|s| s.reconnect)
    }

    /// Replace the jitter source — test-only, for a deterministic backoff
    /// schedule.
    #[cfg(test)]
    pub fn set_rand_for_test(&self, rand: RandFn) {
        self.lock().rand = rand;
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Short critical sections only; a poisoned lock means another thread
        // panicked mid-mutation (a bug) — recover rather than cascade.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The current reconnect-engine state for a session, or `Idle` when unknown.
fn reconnect_of(inner: &Inner, session_id: &str) -> ReconnectState {
    inner
        .sessions
        .get(session_id)
        .map(|s| s.reconnect)
        .unwrap_or(INITIAL_RECONNECT_STATE)
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
