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
}

impl SessionLifecycle {
    /// A session entering its initial connect.
    fn connecting() -> Self {
        Self {
            status: SessionStatus::Connecting,
            reconnect: INITIAL_RECONNECT_STATE,
            end_reason: None,
            error: None,
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
    fn reconnect_event(&mut self, current: ReconnectState, event: ReconnectEvent) -> ReconnectState {
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
                rand: Box::new(|| rand::random::<f64>()),
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
        }
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

    /// Install a specific lifecycle for a session — test-only seeding so intent
    /// tests can start from a populated region.
    #[cfg(test)]
    pub fn seed_for_test(&self, session_id: &str, lifecycle: SessionLifecycle) {
        self.lock()
            .sessions
            .insert(session_id.to_string(), lifecycle);
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
