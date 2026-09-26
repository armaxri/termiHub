//! Per-session supervisor for graphical remote-desktop sessions (#3364).
//!
//! The supervisor owns one graphical session's pumps (frame, cursor and — for
//! RDP — cert-prompt) and drives the unified auto-reconnect engine
//! ([`reconnect_reducer`], SM-020) when the stream drops unexpectedly. It is the
//! graphical twin of the tunnel/agent reconnect loops: the same canonical
//! reducer and [`BackoffConfig`] schedule, not a second engine.
//!
//! # Lifecycle of a drop
//!
//! ```text
//! Active ──drop──▶ Reconnecting(n) ──backoff──▶ re-dial ──first frame──▶ Active
//!                        ▲                         │
//!                        └──── failure (budget) ◀──┘
//!                                    │ budget spent
//!                                    ▼
//!                              Disconnected (manual reconnect prompt)
//! ```
//!
//! - **Auto-Reconnect on** ([`auto_reconnect_enabled`], default on): the drop
//!   arms the backoff schedule ([`GRAPHICAL_BACKOFF`], 1 s doubling, at most
//!   [`MAX_RECONNECT_ATTEMPTS`] attempts). Each attempt re-dials a fresh backend
//!   instance with the session's original settings, swaps it into the shared
//!   connection slot (so input/resize/clipboard commands reach it), re-attaches
//!   the pumps and re-sends the last requested size.
//! - **An attempt succeeds only once the new stream paints a frame.** A re-dial
//!   whose `connect` returns but whose stream closes before any frame (RDP
//!   negotiates asynchronously in its sidecar, so an unreachable host looks like
//!   this) counts as a *failed* attempt. Otherwise such a flapping server would
//!   reset the budget on every dial and loop forever.
//! - **Auto-Reconnect off / budget spent**: rest in `Disconnected` (the manual
//!   reconnect prompt), as before.
//!
//! # Non-retryable ends (never auto-reconnect)
//!
//! - **User disconnect / Cancel** — the manager aborts this task, which also
//!   aborts the side pumps (they live in a [`JoinSet`]) and any in-flight
//!   backoff sleep or re-dial.
//! - **Authentication rejected** on a re-dial ([`SessionError::AuthFailed`]) →
//!   `AuthFailed`; an invalid configuration → `ConnectFailed`. The same
//!   settings can never succeed.
//! - **Authentication rejected after `connect()` returned** (#3390). The RDP
//!   sidecar negotiates asynchronously, so a rejected credential surfaces only
//!   as the stream closing — with the typed reason on
//!   [`GraphicalBackend::fatal_error`](termihub_core::connection::GraphicalBackend::fatal_error).
//!   A [`SessionError::AuthFailed`] there rests in `AuthFailed` on the first
//!   connect and on every re-dial alike, never consuming a retry.
//! - **First connect failed asynchronously** (#3390): when the initial
//!   generation ends before painting and the backend reports any other typed
//!   failure, the session rests in `ConnectFailed` — the same outcome a
//!   synchronous `connect()` error gets. (On a *re-dial* such a failure is an
//!   ordinary failed attempt, so an unreachable host is still retried.)
//! - **Hostile frame stream** (MOCK-011): when the [`FrameGuard`] aborts the
//!   pump after persistently invalid frames, the session is treated as
//!   **terminal** — `Disconnected` with [`REJECTED_FRAMES_MESSAGE`] and no
//!   retry. Re-dialling the same server would most likely replay the same
//!   hostile stream in a loop; the user can still reconnect manually.
//! - **Evicted** (SM-003) does not exist for graphical sessions: they have no
//!   daemon-side single-attach ownership, so there is nothing that can evict
//!   them. Should one ever be added it must join the list above.
//!
//! [`FrameGuard`]: crate::session::frame_guard::FrameGuard

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::task::JoinSet;
use tracing::{debug, info, warn};

use termihub_core::connection::{
    CertPromptReceiver, ConnectionType, ConnectionTypeRegistry, CursorReceiver, FrameReceiver,
    GraphicalState, SessionStateMachine, MAX_RECONNECT_ATTEMPTS,
};
use termihub_core::errors::SessionError;
use termihub_core::reconnect_backoff::{
    reconnect_reducer, BackoffConfig, ReconnectEvent, ReconnectPhase, ReconnectState,
    INITIAL_RECONNECT_STATE,
};

use crate::session::frame_guard::REJECTED_FRAMES_MESSAGE;
use crate::session::graphical_manager::{
    cert_pump, cursor_pump, emit_state, frame_pump, GraphicalEventSink, PendingCert,
};
use crate::session::rdp_trust_store::RdpTrustStore;

#[cfg(doc)]
use termihub_core::connection::auto_reconnect_enabled;

/// Graphical auto-reconnect backoff on the canonical engine (#3364).
///
/// A 1 s first retry doubling up to a 30 s ceiling — the same shape as the
/// tunnel/agent schedules — capped at [`MAX_RECONNECT_ATTEMPTS`] attempts, the
/// "up to 3 times" the Auto-Reconnect toggle promises. Jitter is off: one
/// graphical tab does not stampede a server, and a deterministic schedule is
/// what the paused-time tests pin.
pub(crate) const GRAPHICAL_BACKOFF: BackoffConfig = BackoffConfig {
    base_delay_ms: 1_000.0,
    factor: 2.0,
    max_delay_ms: 30_000.0,
    max_attempts: MAX_RECONNECT_ATTEMPTS as i64,
    jitter_ratio: 0.0,
};

/// Upper bound on one re-dial, so a black-holed host cannot pin an attempt
/// (and the "attempt n/3" overlay) indefinitely.
pub(crate) const RECONNECT_DIAL_TIMEOUT: Duration = Duration::from_secs(30);

/// The pixel size most recently requested for a session, re-sent to the
/// backend after a reconnect so the remote matches the canvas again.
pub(crate) type LastSize = Arc<StdMutex<Option<(u16, u16)>>>;

/// The receivers of one connected backend instance ("generation").
pub(crate) struct Generation {
    pub(crate) frames: FrameReceiver,
    pub(crate) cursor: CursorReceiver,
    pub(crate) cert: Option<CertPromptReceiver>,
}

impl Generation {
    /// Subscribe to a freshly connected backend's framebuffer surface.
    pub(crate) fn subscribe(connection: &dyn ConnectionType) -> Result<Self, String> {
        let backend = connection.graphical().ok_or_else(|| {
            "connected graphical backend did not expose a framebuffer surface".to_string()
        })?;
        Ok(Self {
            frames: backend.subscribe_frames(),
            cursor: backend.subscribe_cursor(),
            cert: backend.subscribe_cert_prompts(),
        })
    }
}

/// How a generation's frame stream ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct PumpEnd {
    /// The [`FrameGuard`](crate::session::frame_guard::FrameGuard) cut off a
    /// persistently hostile stream.
    pub(crate) aborted: bool,
    /// At least one frame reached the frontend.
    pub(crate) painted: bool,
}

/// Why a re-dial failed.
enum DialError {
    /// Worth another attempt (transport error, timeout).
    Retryable(String),
    /// Never retry: rest in this state with this message.
    Terminal(GraphicalState, String),
}

/// Drives one graphical session's pumps and its auto-reconnect loop.
pub(crate) struct Supervisor<S: GraphicalEventSink> {
    pub(crate) session_id: String,
    pub(crate) type_id: String,
    /// Keys the RDP certificate trust store for the cert pump.
    pub(crate) host: String,
    /// The original connect settings — `Some` only when Auto-Reconnect is on,
    /// so a session that will never re-dial does not retain its credentials.
    pub(crate) redial_settings: Option<serde_json::Value>,
    pub(crate) registry: Arc<ConnectionTypeRegistry>,
    pub(crate) connection: Arc<Mutex<Box<dyn ConnectionType>>>,
    pub(crate) state: Arc<Mutex<SessionStateMachine>>,
    pub(crate) last_size: LastSize,
    pub(crate) trust_store: Arc<RdpTrustStore>,
    pub(crate) pending_cert: PendingCert,
    pub(crate) sink: S,
}

impl<S: GraphicalEventSink> Supervisor<S> {
    /// Run the session until it ends for good: pump `first`, and after each
    /// unexpected drop either reconnect (and pump the new generation) or rest
    /// in a terminal / manual-prompt state.
    pub(crate) async fn run(self, first: Generation) {
        let mut no_jitter = || 0.0;
        let mut engine = INITIAL_RECONNECT_STATE;
        let mut generation = first;
        let mut retrying = false;
        loop {
            let end = self.run_generation(generation, retrying).await;
            if let Some((state, message)) = self.fatal_rest(end, retrying).await {
                warn!(session_id = %self.session_id, ?state, %message, "graphical session ended with a typed failure; not auto-reconnecting");
                self.rest(state, Some(message)).await;
                return;
            }
            if end.aborted {
                warn!(session_id = %self.session_id, "hostile frame stream; not auto-reconnecting");
                self.rest(
                    GraphicalState::Disconnected,
                    Some(REJECTED_FRAMES_MESSAGE.into()),
                )
                .await;
                return;
            }
            if self.redial_settings.is_none() {
                self.rest(GraphicalState::Disconnected, None).await;
                return;
            }
            // A reconnected stream that painted proved its attempt; one that
            // closed before any frame is a failed attempt, not a fresh drop.
            let event = if retrying && !end.painted {
                ReconnectEvent::Failure
            } else {
                if retrying {
                    engine = self.step(&engine, ReconnectEvent::Success, &mut no_jitter);
                }
                ReconnectEvent::Drop
            };
            engine = self.step(&engine, event, &mut no_jitter);
            match self.reconnect(engine).await {
                Some((next, state)) => {
                    generation = next;
                    engine = state;
                    retrying = true;
                }
                None => return,
            }
        }
    }

    /// Whether the generation that just ended carries a typed, non-retryable
    /// failure (#3390): the resting state and message, or `None` to fall through
    /// to the ordinary drop / reconnect handling.
    ///
    /// - [`SessionError::AuthFailed`] always rests in `AuthFailed`.
    /// - Any other typed failure rests in `ConnectFailed` only for the first
    ///   generation that never painted — the asynchronous twin of a failed
    ///   initial `connect()`.
    async fn fatal_rest(&self, end: PumpEnd, retrying: bool) -> Option<(GraphicalState, String)> {
        let fatal = {
            let slot = self.connection.lock().await;
            slot.graphical().and_then(|backend| backend.fatal_error())
        }?;
        match fatal {
            SessionError::AuthFailed => Some((GraphicalState::AuthFailed, fatal.to_string())),
            other if !retrying && !end.painted && !end.aborted => {
                Some((GraphicalState::ConnectFailed, other.to_string()))
            }
            _ => None,
        }
    }

    /// One transition of the canonical reconnect engine.
    fn step(
        &self,
        state: &ReconnectState,
        event: ReconnectEvent,
        rand: &mut dyn FnMut() -> f64,
    ) -> ReconnectState {
        reconnect_reducer(state, event, &GRAPHICAL_BACKOFF, rand)
    }

    /// Pump one generation until its frame stream ends. The cursor and cert
    /// pumps live in a [`JoinSet`], so they are aborted with the generation —
    /// and with this task, when a user disconnect aborts it.
    async fn run_generation(&self, generation: Generation, reconnecting: bool) -> PumpEnd {
        let mut side = JoinSet::new();
        side.spawn(cursor_pump(
            self.session_id.clone(),
            generation.cursor,
            self.sink.clone(),
        ));
        if let Some(cert) = generation.cert {
            side.spawn(cert_pump(
                self.session_id.clone(),
                self.host.clone(),
                cert,
                self.sink.clone(),
                self.connection.clone(),
                self.trust_store.clone(),
                self.pending_cert.clone(),
            ));
        }
        let activate = reconnecting.then(|| self.state.clone());
        let end = frame_pump(
            self.session_id.clone(),
            generation.frames,
            self.sink.clone(),
            activate,
        )
        .await;
        side.abort_all();
        end
    }

    /// Walk the backoff schedule from `engine` (which a drop or failure just
    /// armed), re-dialling until one attempt connects. Returns the new
    /// generation plus the engine state to resolve once it paints, or `None`
    /// when the session came to rest (budget spent, terminal error, closed).
    async fn reconnect(&self, mut engine: ReconnectState) -> Option<(Generation, ReconnectState)> {
        let mut no_jitter = || 0.0;
        let mut last_error: Option<String> = None;
        while engine.phase == ReconnectPhase::Waiting {
            let delay = Duration::from_millis(engine.delay_ms.max(0) as u64);
            engine = self.step(&engine, ReconnectEvent::Attempt, &mut no_jitter);
            if !self.begin_attempt(engine.attempt).await {
                return None;
            }
            tokio::time::sleep(delay).await;
            match self.dial().await {
                Ok(generation) => {
                    info!(session_id = %self.session_id, attempt = engine.attempt, "graphical re-dial connected");
                    return Some((generation, engine));
                }
                Err(DialError::Terminal(state, message)) => {
                    warn!(session_id = %self.session_id, %message, "graphical re-dial hit a non-retryable error");
                    self.rest(state, Some(message)).await;
                    return None;
                }
                Err(DialError::Retryable(message)) => {
                    debug!(session_id = %self.session_id, attempt = engine.attempt, %message, "graphical re-dial failed");
                    last_error = Some(message);
                    engine = self.step(&engine, ReconnectEvent::Failure, &mut no_jitter);
                }
            }
        }
        let message = match last_error {
            Some(err) => format!("Reconnect failed after {} attempts: {err}", engine.attempt),
            None => format!("Reconnect failed after {} attempts", engine.attempt),
        };
        self.rest(GraphicalState::Disconnected, Some(message)).await;
        None
    }

    /// Enter `Reconnecting` for `attempt` and tell the frontend. Returns
    /// `false` when the session was closed meanwhile.
    async fn begin_attempt(&self, attempt: i64) -> bool {
        let mut sm = self.state.lock().await;
        if sm.state() == GraphicalState::Closed {
            return false;
        }
        sm.connection_dropped();
        sm.reconnect_attempt_failed();
        sm.begin_reconnect();
        emit_state(
            &self.sink,
            &self.session_id,
            GraphicalState::Reconnecting,
            u32::try_from(attempt).unwrap_or(u32::MAX),
            None,
        );
        true
    }

    /// Settle the session in a resting state (no retry running).
    async fn rest(&self, target: GraphicalState, message: Option<String>) {
        let mut sm = self.state.lock().await;
        if sm.state() == GraphicalState::Closed {
            return;
        }
        let state = match target {
            GraphicalState::AuthFailed => sm.auth_failed(),
            GraphicalState::ConnectFailed => sm.connect_failed(),
            _ => {
                sm.connection_dropped();
                sm.reconnect_attempt_failed()
            }
        };
        emit_state(
            &self.sink,
            &self.session_id,
            state,
            sm.reconnect_attempts(),
            message,
        );
    }

    /// Re-dial a fresh backend instance with the original settings, swap it
    /// into the shared connection slot, retire the dead one, and re-send the
    /// last requested size.
    async fn dial(&self) -> Result<Generation, DialError> {
        let Some(settings) = self.redial_settings.clone() else {
            return Err(DialError::Terminal(
                GraphicalState::Disconnected,
                "auto-reconnect is off".to_string(),
            ));
        };
        let mut fresh = self
            .registry
            .create(&self.type_id)
            .map_err(|e| DialError::Terminal(GraphicalState::ConnectFailed, e.to_string()))?;
        match tokio::time::timeout(RECONNECT_DIAL_TIMEOUT, fresh.connect(settings)).await {
            Err(_) => {
                return Err(DialError::Retryable(format!(
                    "connect timed out after {}s",
                    RECONNECT_DIAL_TIMEOUT.as_secs()
                )))
            }
            Ok(Err(e @ SessionError::AuthFailed)) => {
                return Err(DialError::Terminal(
                    GraphicalState::AuthFailed,
                    e.to_string(),
                ))
            }
            Ok(Err(e @ SessionError::InvalidConfig(_))) => {
                return Err(DialError::Terminal(
                    GraphicalState::ConnectFailed,
                    e.to_string(),
                ))
            }
            Ok(Err(e)) => return Err(DialError::Retryable(e.to_string())),
            Ok(Ok(())) => {}
        }
        let generation = Generation::subscribe(fresh.as_ref()).map_err(DialError::Retryable)?;

        let mut dead = {
            let mut slot = self.connection.lock().await;
            std::mem::replace(&mut *slot, fresh)
        };
        if let Err(e) = dead.disconnect().await {
            debug!(session_id = %self.session_id, error = %e, "retiring dropped graphical connection");
        }

        let size = self.last_size.lock().ok().and_then(|g| *g);
        if let Some((width, height)) = size {
            let slot = self.connection.lock().await;
            if let Some(backend) = slot.graphical() {
                if let Err(e) = backend.resize(width, height).await {
                    debug!(session_id = %self.session_id, error = %e, "re-sending size after reconnect failed");
                }
            }
        }
        Ok(generation)
    }
}

#[cfg(test)]
#[path = "graphical_supervisor_tests.rs"]
mod tests;
