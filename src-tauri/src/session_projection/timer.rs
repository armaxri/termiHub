//! Backend reconnect timer driver — Phase 4 step 2 of the stateless-UI migration
//! (#2203, part of #2152 / #2139).
//!
//! The auto-reconnect backoff loop used to time itself in the frontend: a
//! `setTimeout` in `appStore.autoReconnectTimers` fired the `Waiting → Connecting`
//! edge after each backoff window. Once the shadow [`SessionLifecycleStore`] is
//! authoritative for session status (step 2), the *timing* has to move
//! server-side too — otherwise a client that never re-dispatches would strand a
//! session in `Waiting` forever. This module is that one genuinely new mechanism:
//! a cancellable, per-session one-shot timer that fires the store's
//! `session.reconnectAttempt` transition itself, on the ported #2144 backoff
//! schedule.
//!
//! # How it drives the loop
//!
//! The store's reconnect sub-machine reports a `Waiting` phase whenever it is
//! counting down a backoff window, with the concrete jittered `delay_ms` to wait.
//! After every `session.*` transition the intent routes call
//! [`ReconnectTimerDriver::sync`], which reconciles the timer with that phase:
//!
//! - **`Waiting`** → arm (replacing any prior) a one-shot for `delay_ms`. When it
//!   elapses [`ReconnectTimerDriver::fire`] advances the store
//!   (`Waiting → Connecting`, attempt++) and fans the diff out. The frontend,
//!   reconciling the `Connecting` diff, redrives the actual connection; its
//!   success (`session.connected`) or failure (`session.reconnectFailed`) then
//!   drives the next transition — a failure re-enters `Waiting` and re-arms here.
//! - **anything else** (`Connecting`, `Idle`, `Gaveup`, connected, disconnected,
//!   removed) → cancel any pending timer. So a success, a user cancel, a
//!   give-up, or a tab close all stop the loop.
//!
//! The backend only times the `Waiting → Attempt` edge; the attempt's outcome
//! still comes from the client (which owns the transport). This keeps the retry
//! *count* and *schedule* authoritative server-side while the connection redrive
//! stays where the sockets live.
//!
//! # Deterministic timing (testability)
//!
//! The wall-clock is behind the [`ReconnectScheduler`] trait so tests are not
//! flaky: production uses [`TokioReconnectScheduler`] (a real
//! `tokio::time::sleep`), while unit tests inject a `ManualScheduler` that
//! records armed delays and fires on command, so a full reconnect sequence runs
//! synchronously with exact, injected-jitter delays.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use termihub_core::reconnect_backoff::ReconnectPhase;

use crate::session_projection::store::SessionLifecycleStore;

/// The action a fired timer runs: advance the store and fan the diff out.
type FireTask = Box<dyn FnOnce() + Send>;

/// The **backend-driven reconnect redrive** hook (#2454), invoked on the
/// `Waiting → Attempt` edge after the store has advanced to `Connecting`.
///
/// Where [`ReconnectTimerDriver`] owns only the loop's *timing*, this owns the
/// *transport*: for a tab that opted into backend reattach (the retained
/// request's `backend_reattach` gate, threaded from the client's
/// `sessionBackendReattach` flag), the production implementation re-establishes
/// the connection itself from the retained request, mints a new backend session,
/// folds the attempt's outcome (`connected` + the new `sessionId`, or
/// `reconnectFailed`) at the source, re-syncs this timer, and zeroizes the
/// retained request on give-up.
///
/// It is deliberately abstracted so the timer module stays free of the
/// `SessionManager` / `AppHandle` machinery (that lives in
/// [`crate::session_projection::redrive`]) and so tests can inject a recording
/// double. A tab that did **not** opt in is a no-op here: the fired attempt's
/// `Connecting` diff still fans out and the **client** drives the redrive exactly
/// as on `develop` — the sole gate that keeps the flag-off path byte-identical.
pub trait ReconnectRedrive: Send + Sync {
    /// Attempt a backend-driven reconnect for `tab_id`. Called from
    /// [`ReconnectTimerDriver::fire`] after the store advanced `Waiting →
    /// Connecting`. Must itself check the opt-in gate and no-op when the tab is
    /// client-driven. Cheap/non-blocking: any real connect work is spawned.
    fn redrive(&self, tab_id: &str);
}

/// A cancellable, per-key one-shot timer — the wall-clock behind the reconnect
/// loop, abstracted so tests inject a deterministic double.
///
/// `schedule` arms (replacing any existing timer for `key`) a one-shot that runs
/// `task` after `delay_ms`; `cancel` drops a pending timer. Both are idempotent
/// per key.
pub trait ReconnectScheduler: Send + Sync {
    /// Arm a one-shot for `key`, replacing any pending timer for the same key,
    /// to run `task` after `delay_ms` milliseconds.
    fn schedule(&self, key: String, delay_ms: u64, task: FireTask);
    /// Cancel any pending timer for `key`. A no-op if none is armed.
    fn cancel(&self, key: &str);
}

/// Production [`ReconnectScheduler`] backed by `tokio::time::sleep`. Each armed
/// timer is a spawned task; cancelling aborts it.
///
/// Spawns onto Tauri's **managed** async runtime via
/// [`tauri::async_runtime::spawn`] rather than the free `tokio::spawn`. This is
/// load-bearing (#2503): `schedule` is reached **synchronously** from the sync
/// Tauri command `intent_dispatch`, which runs on the main/webview thread
/// *outside* any Tokio runtime context — the free `tokio::spawn` panics there
/// ("must be called from the context of a Tokio 1.x runtime") and aborts the
/// process on the reconnect hot path. The managed handle is thread-agnostic, so
/// arming is safe from the sync-command thread (and from a plain unit test).
pub struct TokioReconnectScheduler {
    handles: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

impl TokioReconnectScheduler {
    pub fn new() -> Self {
        Self {
            handles: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, tauri::async_runtime::JoinHandle<()>>> {
        self.handles.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Default for TokioReconnectScheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl ReconnectScheduler for TokioReconnectScheduler {
    fn schedule(&self, key: String, delay_ms: u64, task: FireTask) {
        // Replace any prior timer for this key so a re-arm never leaves two live.
        self.cancel(&key);
        // Managed runtime (not the free `tokio::spawn`): this is reached from a
        // sync Tauri command that runs off the Tokio runtime — see the struct
        // doc and #2503.
        let handle = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            task();
        });
        self.lock().insert(key, handle);
    }

    fn cancel(&self, key: &str) {
        if let Some(handle) = self.lock().remove(key) {
            handle.abort();
        }
    }
}

/// Drives the reconnect backoff loop's timing for the shadow
/// [`SessionLifecycleStore`]. Holds the store, the injectable scheduler, and a
/// publish hook (in production: fan the `session-lifecycle` region out via the
/// projector). Managed as Tauri state and resolved by the `session.*` intent
/// routes, which call [`Self::sync`] after each transition.
pub struct ReconnectTimerDriver {
    store: Arc<SessionLifecycleStore>,
    scheduler: Arc<dyn ReconnectScheduler>,
    /// Fan the advanced region out after a fired timer mutates the store. In
    /// production this republishes the shared `session-lifecycle` region.
    publish: Arc<dyn Fn() + Send + Sync>,
    /// The optional backend-driven reconnect redrive (#2454). Present once the
    /// production wiring ([`crate::session_projection::redrive`]) is installed;
    /// `None` in shadow-only setups and plain timer unit tests, where a fired
    /// timer only advances the store + publishes and the client drives the
    /// redrive. When present, it is invoked on every fired attempt but no-ops for
    /// a tab that did not opt into backend reattach.
    redrive: Option<Arc<dyn ReconnectRedrive>>,
}

impl ReconnectTimerDriver {
    /// Build a driver over a store, a scheduler, and a publish hook.
    ///
    /// The backend redrive hook is absent by default (client-driven / shadow);
    /// install it with [`Self::with_redrive`].
    pub fn new(
        store: Arc<SessionLifecycleStore>,
        scheduler: Arc<dyn ReconnectScheduler>,
        publish: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            store,
            scheduler,
            publish,
            redrive: None,
        }
    }

    /// Install the backend-driven reconnect redrive hook (#2454). Consuming
    /// builder so the driver can be constructed and then `manage`d as-is in
    /// `setup()`.
    pub fn with_redrive(mut self, redrive: Arc<dyn ReconnectRedrive>) -> Self {
        self.redrive = Some(redrive);
        self
    }

    /// Reconcile the timer for `session_id` with the store's current reconnect
    /// phase: arm a one-shot for a `Waiting` phase's `delay_ms`, else cancel any
    /// pending timer. Idempotent and cheap, so the routes call it after every
    /// `session.*` transition regardless of kind.
    pub fn sync(self: &Arc<Self>, session_id: &str) {
        match self.store.reconnect_state(session_id) {
            Some(state) if state.phase == ReconnectPhase::Waiting => {
                let delay = state.delay_ms.max(0) as u64;
                let this = Arc::clone(self);
                let id = session_id.to_string();
                self.scheduler.schedule(
                    session_id.to_string(),
                    delay,
                    Box::new(move || this.fire(&id)),
                );
            }
            _ => self.scheduler.cancel(session_id),
        }
    }

    /// The backoff timer for `session_id` elapsed: advance the store's reconnect
    /// sub-machine one attempt (`Waiting → Connecting`, attempt++) and fan the
    /// diff out. The frontend, reconciling the `Connecting` status, performs the
    /// real connection redrive; its outcome drives the next transition.
    ///
    /// The store transition is itself atomic (guarded by the store's own mutex),
    /// so this runs correctly off the dispatcher's write path without corrupting
    /// state — a fired timer and a concurrent intent each publish a consistent,
    /// monotonically-versioned diff.
    fn fire(&self, session_id: &str) {
        self.store.reconnect_attempt(session_id);
        (self.publish)();
        // Backend-driven redrive (#2454): with the hook installed, re-establish
        // the transport for a tab that opted into backend reattach. The hook
        // itself checks the opt-in gate and no-ops for a client-driven tab, so a
        // flag-off tab sees exactly the pre-#2454 behavior (advance + publish;
        // the client drives the attempt). Ordered after the publish so a
        // subscriber sees the `Connecting` edge before the redrive's own
        // outcome diff lands.
        if let Some(redrive) = &self.redrive {
            redrive.redrive(session_id);
        }
    }
}

#[cfg(test)]
#[path = "timer_tests.rs"]
mod tests;
