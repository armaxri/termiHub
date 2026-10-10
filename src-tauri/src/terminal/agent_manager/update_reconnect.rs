//! Backend-driven reconnect after a coordinated agent update (#4489).
//!
//! When another host updates an agent, the agent broadcasts
//! `agent.update_pending` to this desktop. Disconnecting is the ack the
//! updating host waits for, and the agent comes back on the new binary after a
//! restart window whose length is only an estimate.
//!
//! #4311 put the reconnect in a per-window frontend loop, so every open window
//! ran its own timers and connect attempts. The backend owns it now, once per
//! agent for every window:
//!
//! 1. The notice arms an update reconnect in the [`UpdateReconnectRegistry`]
//!    (a duplicate notice for the running one is ignored; a newer one replaces
//!    it) and emits `remote-agent-update-pending`, which every window shows as
//!    the waiting notice.
//! 2. The update suspend tears the connection down with
//!    [`AgentEndReason::Suspend`] but **keeps the transport config**: the hosted
//!    tabs stay resumable and the config the agent was connected with is the
//!    one the reconnect uses.
//! 3. [`drive_update_reconnect`] waits the agent's restart window, then retries
//!    on the shared [`RECONNECT_POLICY`] backoff until
//!    [`AGENT_UPDATE_RECONNECT_DEADLINE`] has passed.
//! 4. The outcome goes to every window as one `agent-update-reconnect` event
//!    ([`AgentUpdateReconnectEvent`]): reconnected (with the version the agent
//!    now reports, so the frontend only claims the update when it is
//!    `requestedByVersion`), failed (the window offers a manual Reconnect),
//!    cancelled by the user, or superseded by a newer action.
//!
//! The user's Cancel and every newer action on the agent (a manual connect, a
//! disconnect or shutdown) stop the reconnect through its cancellation token,
//! which wakes the backoff wait and drops an attempt in flight at once.
//!
//! An attempt runs on its own task, so dropping it does not end the connect
//! underneath: that keeps the agent's connect reservation (#4304) until it
//! settles. A manual connect therefore takes the agent over (#4621) by
//! cancelling the attempt's connect and waiting for it to settle
//! ([`await_update_reconnect_takeover`]) before it reserves the agent itself,
//! so it is never refused as "already connecting".

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use termihub_core::protocol::methods::UpdatePendingNotification;
use termihub_core::reconnect_backoff::{
    reconnect_reducer, system_jitter, ReconnectEvent, ReconnectPhase, RECONNECT_POLICY,
};

use super::notifications::RemoteAgentUpdatePendingEvent;
use super::{AgentCapabilities, AgentConnectionManager, AgentRpcClient};
use crate::agents_projection::projection::fold_agent_transition;
use crate::terminal::agent_config_store::RetainedAgentConfig;
use crate::terminal::backend::AgentEndReason;

/// Overall budget for reconnecting after a coordinated update, from the notice
/// to giving up. Generous enough for a slow host to verify and swap the binary,
/// short enough that a failed update surfaces as an error instead of a spinner.
pub(crate) const AGENT_UPDATE_RECONNECT_DEADLINE: Duration = Duration::from_secs(120);

/// Extra time added to the agent's own restart estimate before the first
/// attempt. The agent only begins its restart once every host has disconnected
/// (or a 10 s window closes), so reconnecting exactly at the estimate would race
/// the process still coming up.
pub(crate) const AGENT_UPDATE_RESTART_BUFFER: Duration = Duration::from_secs(3);

/// How long a manual connect waits for a cancelled update-reconnect attempt to
/// settle before connecting anyway (#4621). A cancelled connect aborts at once,
/// so this only bounds a connect that ignores its cancel.
pub(crate) const UPDATE_ATTEMPT_SETTLE_TIMEOUT: Duration = Duration::from_secs(10);

/// The wait before the first attempt: the agent's restart estimate (at least
/// one second) plus [`AGENT_UPDATE_RESTART_BUFFER`].
pub(crate) fn update_reconnect_initial_delay(estimated_restart_secs: u64) -> Duration {
    Duration::from_secs(estimated_restart_secs.max(1)) + AGENT_UPDATE_RESTART_BUFFER
}

/// How a coordinated-update reconnect ended, as the frontend presents it.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum AgentUpdateReconnectOutcome {
    /// The agent is connected again (by this reconnect or by another connect).
    Reconnected,
    /// The deadline (or the policy's attempt budget) ran out.
    Failed,
    /// The user stopped the reconnect.
    Cancelled,
    /// A newer action on the agent (a manual connect, disconnect, shutdown or
    /// delete) took over; the notice simply goes away.
    Superseded,
}

/// Payload of the `agent-update-reconnect` Tauri event (#4489), broadcast to
/// every window when the backend's coordinated-update reconnect ends.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdateReconnectEvent {
    pub agent_id: String,
    /// Version of the desktop that requested the update, from the notice.
    pub requested_by_version: String,
    pub outcome: AgentUpdateReconnectOutcome,
    /// Connection attempts the reconnect made.
    pub attempts: u32,
    /// The version the reconnected agent reports (`reconnected` only, when it
    /// reported one).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub agent_version: Option<String>,
    /// Why the last attempt failed (`failed` only).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub error: Option<String>,
}

/// Why a running update reconnect was stopped from outside.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum UpdateReconnectStop {
    /// The user's Cancel: the windows offer a manual Reconnect.
    Cancelled,
    /// A newer action owns the agent: the notice goes away quietly.
    Superseded,
    /// A newer `agent.update_pending` notice restarted it: no event at all, the
    /// new reconnect's notice already replaced the old one.
    Replaced,
}

/// How [`drive_update_reconnect`] ended.
#[derive(Debug, PartialEq)]
pub(super) enum DriveOutcome<T> {
    /// An attempt succeeded with `value`, after `attempts` attempts.
    Reconnected { value: T, attempts: u32 },
    /// The deadline or the attempt budget ran out; `error` is the last failure.
    GaveUp { attempts: u32, error: String },
    /// The cancellation token fired.
    Stopped { attempts: u32 },
}

/// The coordinated-update reconnect loop: wait `initial_delay` (the agent's
/// restart window), then run `attempt` until it succeeds, backing off between
/// failures on the shared [`RECONNECT_POLICY`] (driven through
/// [`reconnect_reducer`]) and giving up once `deadline` (measured from the
/// call) has passed or the policy's attempt budget is spent.
///
/// No wait ever runs past the deadline: the last attempt lands on it. `cancel`
/// wakes every wait and drops an attempt in flight at once. `rand` is the jitter
/// source, injectable for tests.
pub(super) async fn drive_update_reconnect<T, A, Fut>(
    initial_delay: Duration,
    deadline: Duration,
    cancel: &CancellationToken,
    rand: &mut (dyn FnMut() -> f64 + Send),
    mut attempt: A,
) -> DriveOutcome<T>
where
    A: FnMut() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let deadline_at = Instant::now() + deadline;
    // A fresh drop arms the loop. Its first window is the agent's restart
    // window rather than the policy's first backoff.
    let mut state = reconnect_reducer(
        &Default::default(),
        ReconnectEvent::Drop,
        &RECONNECT_POLICY,
        rand,
    );
    let mut wait = initial_delay.min(deadline);
    let mut attempts: u32 = 0;
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return DriveOutcome::Stopped { attempts },
            _ = tokio::time::sleep(wait) => {}
        }
        state = reconnect_reducer(&state, ReconnectEvent::Attempt, &RECONNECT_POLICY, rand);
        attempts += 1;
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => return DriveOutcome::Stopped { attempts },
            result = attempt() => result,
        };
        let error = match result {
            Ok(value) => return DriveOutcome::Reconnected { value, attempts },
            Err(error) => error,
        };
        state = reconnect_reducer(&state, ReconnectEvent::Failure, &RECONNECT_POLICY, rand);
        let now = Instant::now();
        if state.phase != ReconnectPhase::Waiting || now >= deadline_at {
            return DriveOutcome::GaveUp { attempts, error };
        }
        wait = Duration::from_millis(state.delay_ms.max(0) as u64).min(deadline_at - now);
    }
}

/// One running update reconnect, as the registry tracks it.
struct RegistryEntry {
    generation: u64,
    requested_by_version: String,
    ticket: UpdateReconnectTicket,
}

#[derive(Default)]
struct RegistryInner {
    next_generation: u64,
    entries: HashMap<String, RegistryEntry>,
}

/// The coordinated-update reconnects the backend is driving, keyed by agent id
/// (#4489). At most one per agent.
#[derive(Clone, Default)]
pub(super) struct UpdateReconnectRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

/// The handle a running update reconnect holds: its stop signal, why it was
/// stopped, and the attempt in flight.
#[derive(Clone)]
pub(super) struct UpdateReconnectTicket {
    pub(super) generation: u64,
    pub(super) token: CancellationToken,
    stop: Arc<Mutex<Option<UpdateReconnectStop>>>,
    /// The settled signal of the attempt in flight, if any (#4621). It fires
    /// once the attempt's task has ended, which is after its connect released
    /// the agent's connect reservation.
    attempt: Arc<Mutex<Option<CancellationToken>>>,
}

/// Marks an update-reconnect attempt as in flight for as long as it lives:
/// dropping it (the attempt's task ended, however it ended) clears the
/// ticket's attempt and fires its settled signal.
struct AttemptInFlight {
    slot: Arc<Mutex<Option<CancellationToken>>>,
    settled: CancellationToken,
}

impl Drop for AttemptInFlight {
    fn drop(&mut self) {
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.settled.cancel();
    }
}

impl UpdateReconnectTicket {
    /// Why the reconnect was stopped (the user's Cancel when nothing recorded a
    /// reason).
    pub(super) fn stop_reason(&self) -> UpdateReconnectStop {
        self.stop
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .unwrap_or(UpdateReconnectStop::Cancelled)
    }

    fn stop_with(&self, reason: UpdateReconnectStop) {
        *self.stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(reason);
        self.token.cancel();
    }

    /// Mark an attempt as in flight, unless the reconnect was already stopped.
    /// Checked under the attempt lock that [`Self::attempt_in_flight`] takes, so
    /// a stop (which cancels the token first) either prevents the attempt or
    /// sees it.
    fn start_attempt(&self) -> Option<AttemptInFlight> {
        let mut slot = self.attempt.lock().unwrap_or_else(|e| e.into_inner());
        if self.token.is_cancelled() {
            return None;
        }
        let settled = CancellationToken::new();
        *slot = Some(settled.clone());
        Some(AttemptInFlight {
            slot: Arc::clone(&self.attempt),
            settled,
        })
    }

    /// The settled signal of the attempt in flight, if one is.
    fn attempt_in_flight(&self) -> Option<CancellationToken> {
        self.attempt
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

impl UpdateReconnectRegistry {
    fn lock(&self) -> MutexGuard<'_, RegistryInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Arm an update reconnect for `agent_id`. Returns `None` for a duplicate
    /// notice (the same update is already being reconnected); a reconnect for a
    /// different update is stopped as [`UpdateReconnectStop::Replaced`] first.
    pub(super) fn begin(
        &self,
        agent_id: &str,
        requested_by_version: &str,
    ) -> Option<UpdateReconnectTicket> {
        let mut inner = self.lock();
        if let Some(existing) = inner.entries.get(agent_id) {
            if existing.requested_by_version == requested_by_version {
                return None;
            }
        }
        if let Some(old) = inner.entries.remove(agent_id) {
            old.ticket.stop_with(UpdateReconnectStop::Replaced);
        }
        inner.next_generation += 1;
        let ticket = UpdateReconnectTicket {
            generation: inner.next_generation,
            token: CancellationToken::new(),
            stop: Arc::new(Mutex::new(None)),
            attempt: Arc::new(Mutex::new(None)),
        };
        inner.entries.insert(
            agent_id.to_string(),
            RegistryEntry {
                generation: ticket.generation,
                requested_by_version: requested_by_version.to_string(),
                ticket: ticket.clone(),
            },
        );
        Some(ticket)
    }

    /// Stop the reconnect for `agent_id` with `reason`. Returns the stopped
    /// ticket, or `None` when none was running.
    pub(super) fn stop(
        &self,
        agent_id: &str,
        reason: UpdateReconnectStop,
    ) -> Option<UpdateReconnectTicket> {
        let entry = self.lock().entries.remove(agent_id)?;
        entry.ticket.stop_with(reason);
        Some(entry.ticket)
    }

    /// Drop the finished reconnect `generation` for `agent_id` (a newer one that
    /// replaced it is left alone).
    pub(super) fn finish(&self, agent_id: &str, generation: u64) {
        let mut inner = self.lock();
        if inner
            .entries
            .get(agent_id)
            .is_some_and(|e| e.generation == generation)
        {
            inner.entries.remove(agent_id);
        }
    }

    /// Whether an update reconnect is running for `agent_id`.
    #[cfg(test)]
    pub(super) fn is_active(&self, agent_id: &str) -> bool {
        self.lock().entries.contains_key(agent_id)
    }
}

/// Handle an `agent.update_pending` notice from `agent_id`'s I/O task: hand the
/// reconnect to the agent manager, which suspends the agent and reconnects it
/// once for every window. A malformed payload is logged and dropped (the agent
/// restart is then handled by the normal transport-loss reconnect).
pub(super) fn handle_update_pending_notice<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    params: &Value,
) {
    let Ok(notice) = serde_json::from_value::<UpdatePendingNotification>(params.clone()) else {
        warn!("Agent {agent_id}: malformed agent.update_pending notification dropped");
        return;
    };
    match app_handle.try_state::<Arc<dyn AgentRpcClient>>() {
        Some(manager) => {
            let started = Arc::clone(manager.inner()).begin_update_reconnect(
                agent_id,
                &notice.requested_by_version,
                notice.estimated_restart_secs,
            );
            if !started {
                info!(agent_id, "duplicate agent.update_pending notice ignored");
            }
        }
        None => warn!("Agent {agent_id}: no agent manager to handle agent.update_pending"),
    }
}

/// One connect attempt of the update reconnect: the agent's own connect path
/// with the kept transport config, on the blocking pool (it wraps a blocking
/// SSH connect). An agent that is already connected (another window or a tab
/// redrive reconnected it) counts as reconnected.
async fn connect_for_update<R: Runtime>(
    manager: Arc<AgentConnectionManager<R>>,
    agent_id: String,
    retained: RetainedAgentConfig,
) -> Result<Option<AgentCapabilities>, String> {
    let joined = tokio::task::spawn_blocking(move || {
        let result = manager.connect_agent(&agent_id, &retained.config, Some(&retained.settings));
        match result {
            Ok(connected) => Ok(Some(connected.capabilities)),
            Err(_) if manager.is_connected(&agent_id) => Ok(manager.get_capabilities(&agent_id)),
            Err(e) => Err(e.to_string()),
        }
    })
    .await;
    joined.unwrap_or_else(|e| Err(format!("connect task failed: {e}")))
}

/// Wait for a manual connect's takeover of an update reconnect (#4621): stop
/// the reconnect for `agent_id` and, when one of its attempts is in flight,
/// cancel it and wait (at most [`UPDATE_ATTEMPT_SETTLE_TIMEOUT`]) until it has
/// released the agent's connect reservation. The connect that follows is then
/// not refused as "already connecting".
pub(crate) async fn await_update_reconnect_takeover(manager: &dyn AgentRpcClient, agent_id: &str) {
    let Some(settled) = manager.take_over_update_reconnect(agent_id) else {
        return;
    };
    info!(
        agent_id,
        "manual connect: waiting for the update-reconnect attempt to stop"
    );
    if tokio::time::timeout(UPDATE_ATTEMPT_SETTLE_TIMEOUT, settled.cancelled())
        .await
        .is_err()
    {
        warn!(
            agent_id,
            "manual connect: the update-reconnect attempt did not stop in time"
        );
    }
}

/// Spawn on the current tokio runtime when there is one (the I/O task, a test's
/// paused runtime), else on Tauri's.
fn spawn_detached<F>(fut: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(fut);
        }
        Err(_) => {
            tauri::async_runtime::spawn(fut);
        }
    }
}

impl<R: Runtime> AgentConnectionManager<R> {
    /// Start the coordinated-update reconnect for `agent_id` (#4489). See the
    /// module docs. Returns `false` for a duplicate notice.
    pub fn begin_update_reconnect(
        self: &Arc<Self>,
        agent_id: &str,
        requested_by_version: &str,
        estimated_restart_secs: u64,
    ) -> bool {
        let manager = Arc::clone(self);
        self.begin_update_reconnect_with(
            agent_id,
            requested_by_version,
            estimated_restart_secs,
            move |agent_id, retained| connect_for_update(Arc::clone(&manager), agent_id, retained),
        )
    }

    /// [`begin_update_reconnect`](Self::begin_update_reconnect) with the
    /// connect attempt injected (tests substitute a scripted one).
    pub(super) fn begin_update_reconnect_with<A, Fut>(
        self: &Arc<Self>,
        agent_id: &str,
        requested_by_version: &str,
        estimated_restart_secs: u64,
        attempt: A,
    ) -> bool
    where
        A: Fn(String, RetainedAgentConfig) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Option<AgentCapabilities>, String>> + Send + 'static,
    {
        let Some(ticket) = self.update_reconnects.begin(agent_id, requested_by_version) else {
            return false;
        };
        info!(
            agent_id,
            requested_by_version, estimated_restart_secs, "coordinated agent update: reconnecting"
        );
        // Every window shows the waiting notice. Emitted before the reconnect
        // runs, so it always precedes the outcome event.
        let notice = serde_json::to_value(RemoteAgentUpdatePendingEvent {
            agent_id,
            requested_by_version,
            estimated_restart_secs,
        });
        if let Ok(notice) = notice {
            let _ = self.app_handle.emit("remote-agent-update-pending", notice);
        }

        let manager = Arc::clone(self);
        let agent_id = agent_id.to_string();
        let requested_by_version = requested_by_version.to_string();
        // Not app-owned (#3105): bounded by the deadline and stopped by its
        // token on Cancel or any newer action on the agent.
        spawn_detached(async move {
            let outcome = manager
                .run_update_reconnect(&agent_id, estimated_restart_secs, &ticket, attempt)
                .await;
            manager
                .update_reconnects
                .finish(&agent_id, ticket.generation);
            manager.report_update_reconnect(&agent_id, &requested_by_version, outcome, &ticket);
        });
        true
    }

    /// Suspend the agent (keeping its transport config), then drive the
    /// reconnect. `None` when it was stopped before the suspend, or there was no
    /// live connection to suspend.
    async fn run_update_reconnect<A, Fut>(
        &self,
        agent_id: &str,
        estimated_restart_secs: u64,
        ticket: &UpdateReconnectTicket,
        attempt: A,
    ) -> Option<DriveOutcome<Option<AgentCapabilities>>>
    where
        A: Fn(String, RetainedAgentConfig) -> Fut,
        Fut: Future<Output = Result<Option<AgentCapabilities>, String>> + Send + 'static,
    {
        if ticket.token.is_cancelled() {
            return Some(DriveOutcome::Stopped { attempts: 0 });
        }
        // The update suspend: disconnecting is the ack the updating host waits
        // for. The hosted tabs stay resumable, and the transport config is kept
        // for the reconnect instead of being scrubbed like a user end.
        let retained = match self.end_agent_connection(agent_id, AgentEndReason::Suspend, false) {
            Ok(Some(retained)) => retained,
            Ok(None) | Err(_) => {
                warn!(
                    agent_id,
                    "coordinated agent update: no live connection to suspend"
                );
                return None;
            }
        };
        let mut jitter = system_jitter;
        let outcome = drive_update_reconnect(
            update_reconnect_initial_delay(estimated_restart_secs),
            AGENT_UPDATE_RECONNECT_DEADLINE,
            &ticket.token,
            &mut jitter,
            || {
                let pending = attempt(agent_id.to_string(), retained.clone());
                let ticket = ticket.clone();
                async move {
                    let Some(in_flight) = ticket.start_attempt() else {
                        return Err("The update reconnect was stopped.".to_string());
                    };
                    // On its own task so that a stop dropping this future still
                    // lets the attempt settle and mark it settled (#4621): the
                    // connect underneath holds the agent's reservation until then.
                    let task = tokio::spawn(async move {
                        let _in_flight = in_flight;
                        pending.await
                    });
                    task.await
                        .unwrap_or_else(|e| Err(format!("update reconnect attempt failed: {e}")))
                }
            },
        )
        .await;
        Some(outcome)
    }

    /// Tell every window how the reconnect ended, and record a reconnected
    /// agent's capabilities in the agents region so its version is current.
    fn report_update_reconnect(
        &self,
        agent_id: &str,
        requested_by_version: &str,
        outcome: Option<DriveOutcome<Option<AgentCapabilities>>>,
        ticket: &UpdateReconnectTicket,
    ) {
        let event = |outcome, attempts, agent_version, error| AgentUpdateReconnectEvent {
            agent_id: agent_id.to_string(),
            requested_by_version: requested_by_version.to_string(),
            outcome,
            attempts,
            agent_version,
            error,
        };
        let event = match outcome {
            None => event(
                AgentUpdateReconnectOutcome::Failed,
                0,
                None,
                Some("The agent was not connected.".to_string()),
            ),
            Some(DriveOutcome::Reconnected {
                value: capabilities,
                attempts,
            }) => {
                let agent_version = capabilities
                    .as_ref()
                    .map(|c| c.agent_version.clone())
                    .filter(|v| !v.is_empty());
                if let Some(value) = capabilities.and_then(|c| serde_json::to_value(c).ok()) {
                    fold_agent_transition(&self.app_handle, move |store| {
                        store.set_capabilities(agent_id, value);
                    });
                }
                info!(
                    agent_id,
                    attempts,
                    ?agent_version,
                    "coordinated agent update: reconnected"
                );
                event(
                    AgentUpdateReconnectOutcome::Reconnected,
                    attempts,
                    agent_version,
                    None,
                )
            }
            Some(DriveOutcome::GaveUp { attempts, error }) => {
                warn!(agent_id, attempts, %error, "coordinated agent update: gave up reconnecting");
                event(
                    AgentUpdateReconnectOutcome::Failed,
                    attempts,
                    None,
                    Some(error),
                )
            }
            Some(DriveOutcome::Stopped { attempts }) => match ticket.stop_reason() {
                UpdateReconnectStop::Cancelled => {
                    event(AgentUpdateReconnectOutcome::Cancelled, attempts, None, None)
                }
                UpdateReconnectStop::Superseded => event(
                    AgentUpdateReconnectOutcome::Superseded,
                    attempts,
                    None,
                    None,
                ),
                UpdateReconnectStop::Replaced => return,
            },
        };
        let _ = self.app_handle.emit("agent-update-reconnect", event);
    }

    /// Stop the coordinated-update reconnect for `agent_id` (#4489): the user's
    /// Cancel, or (`superseded`) a newer action that owns the agent from here
    /// on. The user's Cancel also aborts an attempt in flight. Returns whether
    /// one was running.
    pub fn cancel_update_reconnect(&self, agent_id: &str, superseded: bool) -> bool {
        let reason = if superseded {
            UpdateReconnectStop::Superseded
        } else {
            UpdateReconnectStop::Cancelled
        };
        let Some(ticket) = self.update_reconnects.stop(agent_id, reason) else {
            return false;
        };
        if !superseded && ticket.attempt_in_flight().is_some() {
            self.cancel_connect(agent_id);
        }
        true
    }

    /// A manual connect takes the agent over (#4621): stop the reconnect as
    /// superseded and cancel an attempt in flight. Returns that attempt's
    /// settled signal, or `None` when none was in flight (or no reconnect was
    /// running). See [`await_update_reconnect_takeover`].
    pub fn take_over_update_reconnect(&self, agent_id: &str) -> Option<CancellationToken> {
        let ticket = self
            .update_reconnects
            .stop(agent_id, UpdateReconnectStop::Superseded)?;
        let settled = ticket.attempt_in_flight()?;
        self.cancel_connect(agent_id);
        Some(settled)
    }

    /// A newer action supersedes a running coordinated-update reconnect.
    pub(super) fn supersede_update_reconnect(&self, agent_id: &str) {
        self.cancel_update_reconnect(agent_id, true);
    }
}

#[cfg(test)]
#[path = "update_reconnect_tests.rs"]
mod tests;
