//! Shared "desktop controls a service hosted on a remote agent" control layer.
//!
//! Three subsystems host a service on a remote agent while the desktop keeps
//! only *control*: embedded servers ([`crate::embedded_servers`]), HTTP monitors
//! ([`crate::network`]), and SSH tunnels ([`crate::tunnel`]). Each resolves a
//! run-location, and — when it resolves to an agent — starts/stops the service
//! over the agent RPC, tracks the agent-hosted instances, and periodically
//! samples each one's status to bridge live updates back to the frontend.
//!
//! The **periodic status poller** was copy-pasted across all three managers
//! (embedded `ensure_agent_status_poller`, tunnel `ensure_agent_stats_poller`,
//! network `ensure_agent_status_poller`) with only the service-specific RPC/parse
//! and write-back/emit differing. This module extracts that shared lifecycle into
//! [`AgentStatusPoller`], parameterised by an [`AgentStatusPollDelegate`] that
//! supplies the service-specific pieces (DUP-020).
//!
//! What is shared (identical across the three): the idempotent single-task spawn
//! guard, the fixed-interval tick loop, snapshotting the poll targets, the
//! self-reap when no agent-hosted instance remains, resolving the agent RPC
//! client fresh each tick, running the blocking status batch on a `spawn_blocking`
//! thread, and aborting the task on shutdown. The task is owned by the app-wide
//! [`AppTasks`] tracker (ARCH-007, #3105): it breaks on the app cancellation
//! token and teardown awaits it, bounded.
//!
//! What stays service-specific (the delegate): which instances to poll, the
//! `*.status` RPC + reply parse, and how a fresh sample is written back into the
//! per-service handle and bridged to the frontend (a Tauri event, or a projection
//! publish). The per-service start/stop control paths — whose event and error
//! semantics genuinely diverge — stay in their managers.

pub mod events;
pub mod hosted;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Local};
use tauri::{AppHandle, Manager, Runtime};
use termihub_core::util::service_cause::ServiceCause;

use self::hosted::{Away, WaitFor};

use crate::app_tasks::AppTasks;
use crate::connection::manager::ConnectionManager;
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

/// Resolve the shared agent RPC client from Tauri managed state, if available.
///
/// `None` before the app is fully set up (e.g. in unit tests without a live Tauri
/// app, or when no agent is connected); the agent-routed paths treat that as
/// "agent unavailable" and no-op the tick. A free function so the periodic poller
/// task can resolve the client fresh each tick — an agent may connect after the
/// poller started — without holding a manager reference.
pub fn agent_rpc_client<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<dyn AgentRpcClient>> {
    app.try_state::<Arc<dyn AgentRpcClient>>()
        .map(|state| (*state).clone())
}

/// Why a service does not run: the sentence its row shows, and the kind of cause
/// its remedy is chosen by (#6063). The row names the machine once, beside the
/// service, so the sentences say "its agent".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reason {
    pub text: String,
    pub cause: Option<ServiceCause>,
}

impl Reason {
    pub fn new(text: impl Into<String>, cause: Option<ServiceCause>) -> Self {
        Self {
            text: text.into(),
            cause,
        }
    }
}

impl From<String> for Reason {
    fn from(text: String) -> Self {
        Self::new(text, None)
    }
}

impl From<&str> for Reason {
    fn from(text: &str) -> Self {
        Self::new(text, None)
    }
}

/// The reason a service whose stored host cannot be read is not started
/// (#6028). Shown on its row.
pub const HOST_UNREADABLE: &str =
    "Not started: termiHub cannot read where it runs. Edit it and choose a machine.";

/// What the saved agents say about an agent id.
enum SavedAgent {
    /// There are no saved agents to ask (a unit test, or a load failure).
    Unknown,
    /// No saved agent has this id.
    Removed,
    Saved,
}

fn saved_agent<R: Runtime>(app: &AppHandle<R>, agent_id: &str) -> SavedAgent {
    let Some(connections) = app.try_state::<ConnectionManager>() else {
        return SavedAgent::Unknown;
    };
    let Ok(all) = connections.get_all() else {
        return SavedAgent::Unknown;
    };
    match all.agents.into_iter().find(|agent| agent.id == agent_id) {
        Some(_) => SavedAgent::Saved,
        None => SavedAgent::Removed,
    }
}

/// Whether the agent that a service runs on was removed.
pub fn agent_is_removed<R: Runtime>(app: &AppHandle<R>, agent_id: &str) -> bool {
    matches!(saved_agent(app, agent_id), SavedAgent::Removed)
}

/// Whether agent `agent_id` can be asked to start a service now.
pub fn agent_is_ready<R: Runtime>(app: &AppHandle<R>, agent_id: &str) -> bool {
    agent_rpc_client(app).is_some_and(|client| client.is_reachable(agent_id))
}

/// The client to start a service on agent `agent_id`, or the reason to show on
/// the service's row when that agent cannot be asked (#6028). The caller starts
/// nothing then, least of all on this computer.
pub fn agent_for_start<R: Runtime>(
    app: &AppHandle<R>,
    agent_id: &str,
) -> Result<Arc<dyn AgentRpcClient>, Reason> {
    if agent_is_removed(app, agent_id) {
        return Err(
            "Not started: the agent it runs on was removed. Edit it and choose a machine.".into(),
        );
    }
    agent_rpc_client(app)
        .filter(|client| client.is_reachable(agent_id))
        .ok_or_else(|| {
            Reason::new(
                "Not started: its agent is not connected.",
                Some(ServiceCause::AgentOffline),
            )
        })
}

/// The reason to show on a service's row when its agent did not start it
/// (#6028). Not for an [unanswered](hosted::is_unanswered) start: that one may
/// run there.
pub fn agent_start_error(error: &TerminalError) -> Reason {
    match error {
        TerminalError::AgentUnsupported(_) => {
            "Not started: its agent is too old to run it. Update the agent.".into()
        }
        error => format!("Not started: its agent could not start it: {error}").into(),
    }
}

/// What the row of a service on this computer says whose port is taken.
pub fn port_in_use_here(port: u16) -> String {
    format!("Port {port} is already in use on this computer.")
}

/// What a waiting service's row says: until when, and what comes after.
pub fn waiting_reason(on: &WaitFor, until: DateTime<Local>) -> Reason {
    let until = until.format("%H:%M");
    let (when, cause) = match on {
        WaitFor::Agent(_) => ("when its agent connects", ServiceCause::AgentOffline),
        WaitFor::CredentialStore => (
            "when you unlock the credential store",
            ServiceCause::StoreLocked,
        ),
    };
    Reason::new(
        format!("Starts {when}, until {until}. After that, start it yourself."),
        Some(cause),
    )
}

/// What the row of a service says whose wait is over.
pub fn waited_too_long(on: &WaitFor) -> Reason {
    let minutes = hosted::WAIT_LIMIT.as_secs() / 60;
    match on {
        WaitFor::Agent(_) => Reason::new(
            format!("Not started: its agent was not connected within {minutes} minutes. Connect it, then start it again."),
            Some(ServiceCause::AgentOffline),
        ),
        WaitFor::CredentialStore => Reason::new(
            format!("Not started: the credential store stayed locked for {minutes} minutes. Unlock it, then start it again."),
            Some(ServiceCause::StoreLocked),
        ),
    }
}

/// What the row of a service says that is not reachable.
pub fn not_reachable_reason<R: Runtime>(app: &AppHandle<R>, agent_id: &str, why: Away) -> Reason {
    if agent_is_removed(app, agent_id) {
        return "Its agent was removed from termiHub. It may still run there.".into();
    }
    let (what, then, cause) = match why {
        Away::Offline => (
            "is offline. It may still run there",
            "termiHub cannot tell",
            ServiceCause::AgentOffline,
        ),
        Away::Silent => (
            "does not answer. It may still run there",
            "termiHub keeps asking",
            ServiceCause::AgentSilent,
        ),
        Away::StartUnanswered => (
            "did not answer the start. It may run there",
            "termiHub keeps asking",
            ServiceCause::AgentSilent,
        ),
    };
    // Nobody can be asked while it is gone.
    if agent_is_ready(app, agent_id) || cause == ServiceCause::AgentOffline {
        Reason::new(format!("Its agent {what}; {then}."), Some(cause))
    } else {
        Reason::new(
            format!("Its agent {what}; termiHub cannot tell."),
            Some(ServiceCause::AgentOffline),
        )
    }
}

/// What the row of a service says whose stop the agent has not confirmed.
pub fn stopping_reason<R: Runtime>(app: &AppHandle<R>, agent_id: &str) -> Reason {
    if agent_is_ready(app, agent_id) {
        "Waiting for its agent to stop it.".into()
    } else {
        Reason::new(
            "Its agent is offline. It may still run there; it will be stopped when the agent is back.",
            Some(ServiceCause::AgentOffline),
        )
    }
}

/// What the row of a service says whose unanswered start turned out not to run.
pub fn unanswered_start_failed() -> Reason {
    "Not started: its agent did not answer the start, and it does not run there.".into()
}

/// Ask the agents once, now ("Check again", #6068). Blocking.
pub fn poll_now<D: AgentStatusPollDelegate>(delegate: &D) {
    let Some(client) = delegate.client() else {
        return;
    };
    let (targets, _) = delegate.snapshot_targets();
    delegate.apply(D::poll(client, &targets));
}

/// The service-specific parts of one agent status-poll tick.
///
/// The generic [`AgentStatusPoller`] drives the loop; the delegate supplies which
/// instances to poll, the blocking status RPC + parse, and how to apply the
/// results. A delegate typically owns `Arc` clones of its manager's agent-instance
/// map and an [`AppHandle`], so it can read/write handles and emit events from the
/// poller task without a `&self` manager reference.
pub trait AgentStatusPollDelegate: Send + 'static {
    /// One instance to poll, e.g. its `(instance_id, agent_id)`.
    type Target: Send + 'static;

    /// One answer to apply (e.g. a `(monitor_id, HttpCheckResult)`).
    type Sample: Send + 'static;

    /// How often to sample. Defaults to one second (the cadence all three
    /// managers use).
    fn interval(&self) -> Duration {
        Duration::from_secs(1)
    }

    /// Resolve the agent RPC client for this tick, or `None` to skip it (an agent
    /// may connect after the poller started). Typically
    /// [`agent_rpc_client`]`(&app)`.
    fn client(&self) -> Option<Arc<dyn AgentRpcClient>>;

    /// Snapshot the targets to poll this tick, plus
    /// whether **any** agent-hosted instance remains at all.
    ///
    /// The pair decides the loop's fate: `any_remaining == false` stops the poller
    /// (nothing left to sample); an empty `targets` list with `any_remaining ==
    /// true` skips only this tick (e.g. every instance is paused) and keeps the
    /// poller alive. Managers without a paused state simply return
    /// `any_remaining = !targets.is_empty()`.
    fn snapshot_targets(&self) -> (Vec<Self::Target>, bool);

    /// Runs at the start of every tick that polls or keeps waiting, on the
    /// poller's async task: it must not block.
    fn on_tick(&self) {}

    /// Run the blocking `*.status` RPC batch for `targets` and return the
    /// samples. Runs on a `spawn_blocking` thread (the RPC is
    /// blocking), so it takes no `&self` — pass owned/`Arc` data only.
    fn poll(client: Arc<dyn AgentRpcClient>, targets: &[Self::Target]) -> Vec<Self::Sample>;

    /// Apply the polled samples: write them back into the per-service handles and
    /// bridge any fresh update to the frontend. Runs on the poller's async task
    /// (not the blocking thread), so it may lock the instance map and emit.
    fn apply(&self, samples: Vec<Self::Sample>);
}

/// A single periodic agent `*.status` poller task with an idempotent lifecycle.
///
/// Holds the task handle in a shared slot so the task can self-reap (clear the
/// slot) when no agent-hosted instance remains, and so a later start re-spawns it.
/// One of these replaces each manager's hand-rolled `agent_status_poller`
/// `Arc<Mutex<Option<JoinHandle<()>>>>` plus its `ensure_*`/`stop_*` methods.
pub struct AgentStatusPoller {
    /// `Some` while the task is running; the task self-reaps this to `None` once no
    /// instance remains, and [`stop`](Self::stop) aborts it on shutdown.
    slot: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Owner of the poller task (ARCH-007, #3105): the task is spawned through
    /// it and breaks on its cancellation token, so app teardown stops and
    /// awaits it. A standalone (never shut down) registry for [`new`](Self::new).
    tasks: AppTasks,
}

impl AgentStatusPoller {
    /// Create an idle poller (no task running) with a standalone task owner —
    /// for unit tests and managers built before the app's [`AppTasks`] exists.
    pub fn new() -> Self {
        Self::with_tasks(AppTasks::new())
    }

    /// Create an idle poller whose task is owned by the app-wide `tasks`
    /// registry, so app teardown cancels and (bounded) awaits it (#3105).
    pub fn with_tasks(tasks: AppTasks) -> Self {
        Self {
            slot: Arc::new(Mutex::new(None)),
            tasks,
        }
    }

    /// Ensure the poller task is running, spawning it if not.
    ///
    /// Idempotent: if a task is already tracked and not yet finished, the passed
    /// `delegate` is dropped and nothing is spawned. Otherwise a task is spawned
    /// that, every [`delegate.interval`](AgentStatusPollDelegate::interval),
    /// snapshots the targets, stops when none remain, resolves the client fresh,
    /// runs [`D::poll`](AgentStatusPollDelegate::poll) on a blocking thread, and
    /// applies the samples — then self-reaps once no instance remains.
    pub fn ensure<D: AgentStatusPollDelegate>(&self, delegate: D) {
        let mut slot = match self.slot.lock() {
            Ok(slot) => slot,
            Err(_) => return,
        };
        // Already running (and not yet finished) — nothing to do.
        if slot.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return;
        }

        let poller_slot = Arc::clone(&self.slot);
        let interval = delegate.interval();
        let cancel = self.tasks.cancellation_token();

        let handle = self.tasks.spawn(async move {
            loop {
                // App teardown (ARCH-007) wins over the next tick: the loop has
                // nothing in flight between ticks, so breaking here is safe.
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(interval) => {}
                }

                // Snapshot the targets, then decide the loop's fate before any
                // RPC so a slow agent never blocks a start/stop.
                let (targets, any_remaining) = delegate.snapshot_targets();
                // No agent-hosted instance left: stop polling and clear the slot so
                // a later start re-spawns the task. Decided under the slot lock:
                // an instance added meanwhile either is seen here, or its
                // `ensure` finds the slot empty and spawns a new task (#6028).
                if !any_remaining {
                    let Ok(mut slot) = poller_slot.lock() else {
                        return;
                    };
                    if !delegate.snapshot_targets().1 {
                        *slot = None;
                        return;
                    }
                }
                delegate.on_tick();
                // Instances remain but none is pollable this tick (e.g. all
                // paused): keep the poller alive, skip the tick.
                if targets.is_empty() {
                    continue;
                }

                // Resolve the client fresh each tick (an agent may connect after
                // the poller started). Absent → skip this tick.
                let Some(client) = delegate.client() else {
                    continue;
                };

                // The `*.status` RPC is blocking; run the whole batch on a blocking
                // thread so no async worker is stalled.
                let poll = tokio::task::spawn_blocking(move || D::poll(client, &targets));
                // A slow agent must not hold app teardown: on cancellation the
                // in-flight read-only status batch is abandoned (its samples are
                // discarded — nothing is written back after shutdown).
                let samples = tokio::select! {
                    _ = cancel.cancelled() => break,
                    samples = poll => samples.unwrap_or_default(),
                };

                delegate.apply(samples);
            }

            // Self-reap: drop our own handle so a later start re-spawns the task.
            if let Ok(mut slot) = poller_slot.lock() {
                *slot = None;
            }
        });

        *slot = Some(handle);
    }

    /// Abort the poller task (if any) and clear its slot. Called on manager
    /// shutdown / `stop_all`.
    pub fn stop(&self) {
        if let Ok(mut slot) = self.slot.lock() {
            if let Some(handle) = slot.take() {
                handle.abort();
            }
        }
    }

    /// Whether a task is currently tracked and not yet finished.
    #[cfg(test)]
    pub(crate) fn is_running(&self) -> bool {
        self.slot
            .lock()
            .map(|slot| slot.as_ref().is_some_and(|handle| !handle.is_finished()))
            .unwrap_or(false)
    }
}

impl Default for AgentStatusPoller {
    fn default() -> Self {
        Self::new()
    }
}

/// A service instance hosted on a remote agent, as tracked by the desktop.
///
/// The three agent-hosted managers (embedded servers, HTTP monitors, SSH tunnels)
/// each keep a per-instance handle whose contents differ, but every one records
/// **which agent hosts the instance** — the one field the shared tracker needs to
/// target the `*.status` poll and the teardown RPC. Implementing this lets
/// [`AgentInstances`] read the hosting agent without knowing the handle type
/// (#2884).
pub trait AgentHosted {
    /// The id of the agent hosting this instance.
    fn agent_id(&self) -> &str;
}

/// The shared agent-hosted-instance tracking map (DUP-020 follow-up, #2884).
///
/// Each of the three managers kept an identical
/// `Arc<Mutex<HashMap<instance_id, Handle>>>` plus the same hand-rolled
/// `ids` / `clear` / `agent_id` and status-poll-target
/// helpers around it, differing only in the per-protocol handle type. This wraps
/// that map once, keyed by instance id and generic over the handle `H`.
///
/// `Clone` shares the same underlying map (it clones the inner `Arc`), so a status
/// poller delegate can hold its own handle to the manager's live instances without
/// a `&self` reference — exactly the `Arc::clone` the delegates did by hand.
///
/// **Poison policy.** The convenience readers/mutators here
/// ([`ids`](Self::ids), [`clear`](Self::clear),
/// [`agent_id_of`](Self::agent_id_of),
/// [`snapshot_targets_where`](Self::snapshot_targets_where)) treat a poisoned lock as
/// "empty/absent/no-op", matching what every teardown, lookup and poll-snapshot
/// site already did. The guarded *start* paths (the double-start check and the
/// insert) instead surface a poisoned lock as the manager's own error, so they use
/// [`lock`](Self::lock), which returns the std [`LockResult`](std::sync::LockResult)
/// for the caller to map.
pub struct AgentInstances<H> {
    map: Arc<Mutex<HashMap<String, H>>>,
}

impl<H> AgentInstances<H> {
    /// Create an empty tracker.
    pub fn new() -> Self {
        Self {
            map: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Lock the underlying map, returning the std
    /// [`LockResult`](std::sync::LockResult) so a caller on a start path can map a
    /// poisoned lock to its own manager error (the double-start guard and the
    /// insert), and a mutator/list path can read/write handles directly.
    /// Poison-tolerant callers should prefer the convenience methods below.
    #[allow(clippy::type_complexity)]
    pub fn lock(&self) -> std::sync::LockResult<std::sync::MutexGuard<'_, HashMap<String, H>>> {
        self.map.lock()
    }

    /// A snapshot of every tracked instance id. A poisoned lock returns empty.
    /// Used by each manager's `stop_all` teardown loop.
    pub fn ids(&self) -> Vec<String> {
        self.map
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Drop every tracked instance. A poisoned lock is a no-op.
    pub fn clear(&self) {
        if let Ok(mut m) = self.map.lock() {
            m.clear();
        }
    }
}

impl<H: AgentHosted> AgentInstances<H> {
    /// The agent hosting `id`, if it is tracked. A poisoned lock returns `None`.
    pub fn agent_id_of(&self, id: &str) -> Option<String> {
        self.map
            .lock()
            .ok()?
            .get(id)
            .map(|h| h.agent_id().to_string())
    }

    /// Snapshot the `(instance_id, agent_id)` targets of the instances matching
    /// `include`, plus whether **any** instance remains at all, so an
    /// excluded-but-listed instance (e.g. a paused monitor) keeps the poller alive
    /// instead of stopping it. A poisoned lock returns `(empty, false)`, stopping
    /// the poller.
    pub fn snapshot_targets_where(
        &self,
        include: impl Fn(&H) -> bool,
    ) -> (Vec<(String, String)>, bool) {
        match self.map.lock() {
            Ok(map) => {
                let targets = map
                    .iter()
                    .filter(|(_, h)| include(h))
                    .map(|(id, h)| (id.clone(), h.agent_id().to_string()))
                    .collect();
                (targets, !map.is_empty())
            }
            Err(_) => (Vec::new(), false),
        }
    }
}

impl<H> Clone for AgentInstances<H> {
    fn clone(&self) -> Self {
        Self {
            map: Arc::clone(&self.map),
        }
    }
}

impl<H> Default for AgentInstances<H> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use crate::test_support::FakeAgent;

    /// A controllable delegate that records ticks and applied samples, so the
    /// generic loop's behaviour can be observed without a real service.
    struct TestDelegate {
        /// Bumped once per `snapshot_targets` call (i.e. once per tick body).
        ticks: Arc<AtomicUsize>,
        /// Samples handed to `apply`, in order.
        applied: Arc<Mutex<Vec<u32>>>,
        /// Value returned as `any_remaining`.
        any_remaining: Arc<AtomicBool>,
        /// When true, `snapshot_targets` returns no targets (skip the tick).
        targets_empty: Arc<AtomicBool>,
        /// When true, `client` resolves to an offline [`FakeAgent`] (the test
        /// delegate ignores it, so it is never called); otherwise `None`.
        with_client: bool,
    }

    impl AgentStatusPollDelegate for TestDelegate {
        type Target = (String, String);
        type Sample = u32;

        fn interval(&self) -> Duration {
            TICK
        }

        fn client(&self) -> Option<Arc<dyn AgentRpcClient>> {
            if self.with_client {
                Some(Arc::new(FakeAgent::offline()))
            } else {
                None
            }
        }

        fn snapshot_targets(&self) -> (Vec<(String, String)>, bool) {
            self.ticks.fetch_add(1, Ordering::SeqCst);
            let remaining = self.any_remaining.load(Ordering::SeqCst);
            let targets = if self.targets_empty.load(Ordering::SeqCst) {
                Vec::new()
            } else {
                vec![("instance".to_string(), "agent".to_string())]
            };
            (targets, remaining)
        }

        fn poll(_client: Arc<dyn AgentRpcClient>, targets: &[(String, String)]) -> Vec<u32> {
            // Ignore the (noop) client; synthesise one sample per target.
            targets.iter().map(|_| 1u32).collect()
        }

        fn apply(&self, samples: Vec<u32>) {
            self.applied.lock().unwrap().extend(samples);
        }
    }

    fn delegate(with_client: bool) -> (TestDelegate, Arc<AtomicUsize>, Arc<Mutex<Vec<u32>>>) {
        let ticks = Arc::new(AtomicUsize::new(0));
        let applied = Arc::new(Mutex::new(Vec::new()));
        let d = TestDelegate {
            ticks: Arc::clone(&ticks),
            applied: Arc::clone(&applied),
            any_remaining: Arc::new(AtomicBool::new(true)),
            targets_empty: Arc::new(AtomicBool::new(false)),
            with_client,
        };
        (d, ticks, applied)
    }

    /// The poll interval the [`TestDelegate`] reports. Kept small so the paused
    /// clock only ever advances by tiny virtual steps.
    const TICK: Duration = Duration::from_millis(10);

    /// Deterministically drive the spawned poll loop exactly `n` ticks under
    /// paused time: advance the virtual clock one interval per tick and yield so
    /// the loop task is polled once between advances. No wall-clock wait and no
    /// scheduler race — the resulting tick count is exact regardless of runner
    /// load. Only valid for delegates whose tick body has no inner `.await`
    /// (i.e. no client / empty targets), so one yield fully drains each tick.
    async fn advance_ticks(n: usize) {
        // Let the freshly-spawned loop task reach its first `sleep` before the
        // clock moves, so the first advance actually fires a pending timer.
        tokio::task::yield_now().await;
        for _ in 0..n {
            tokio::time::advance(TICK).await;
            tokio::task::yield_now().await;
        }
    }

    /// Advance the paused clock one interval at a time until `cond` holds,
    /// yielding after each step so the loop task is polled. Deterministic and
    /// load-independent; used where a tick body awaits (client poll) or self-
    /// reaps, so an exact tick count is not meaningful. Panics if the condition
    /// never holds within a generous bound.
    async fn advance_until(mut cond: impl FnMut() -> bool) {
        for _ in 0..1_000 {
            if cond() {
                return;
            }
            tokio::time::advance(TICK).await;
            tokio::task::yield_now().await;
        }
        panic!("condition not met within bound");
    }

    /// The happy path: with targets, a client, and instances remaining, the loop
    /// polls and applies samples every tick — and `stop` ends it.
    #[tokio::test(start_paused = true)]
    async fn polls_and_applies_until_stopped() {
        let poller = AgentStatusPoller::new();
        let (d, ticks, applied) = delegate(true);
        poller.ensure(d);

        // Drive the clock until a sample lands (the tick body awaits a blocking
        // poll, so wait for the signal rather than a fixed tick count).
        advance_until(|| !applied.lock().unwrap().is_empty()).await;
        assert!(
            ticks.load(Ordering::SeqCst) >= 1,
            "loop should tick and poll"
        );
        assert!(
            !applied.lock().unwrap().is_empty(),
            "samples should be applied when a client and targets are present"
        );
        assert!(poller.is_running());

        poller.stop();
        assert!(!poller.is_running(), "stop must abort the task");
    }

    /// `any_remaining == false` makes the loop break and self-reap the slot, so a
    /// later `ensure` can spawn a fresh task.
    #[tokio::test(start_paused = true)]
    async fn self_reaps_when_no_instances_remain() {
        let poller = AgentStatusPoller::new();
        let (d, _ticks, applied) = delegate(true);
        d.any_remaining.store(false, Ordering::SeqCst);
        poller.ensure(d);

        // The first tick observes no instances, breaks, and clears the slot.
        advance_until(|| !poller.is_running()).await;
        assert!(
            applied.lock().unwrap().is_empty(),
            "no instances remain → nothing polled"
        );
        assert!(!poller.is_running(), "the task should self-reap the slot");
    }

    /// A second `ensure` while the first task is live is a no-op: the second
    /// delegate never runs (proving a single task, not two).
    #[tokio::test(start_paused = true)]
    async fn ensure_is_idempotent_while_running() {
        let poller = AgentStatusPoller::new();
        // First delegate loops forever without a client (never applies).
        let (d1, _t1, _a1) = delegate(false);
        poller.ensure(d1);

        // Second delegate would apply markers if it ever ran.
        let (d2, ticks2, applied2) = delegate(true);
        poller.ensure(d2);

        // Only the first delegate's (client-less) loop runs, so ticks stay
        // await-free and the drive is exact.
        advance_ticks(4).await;
        assert_eq!(
            ticks2.load(Ordering::SeqCst),
            0,
            "the second delegate must never run while the first holds the slot"
        );
        assert!(applied2.lock().unwrap().is_empty());
        assert!(poller.is_running());

        poller.stop();
    }

    /// With no client resolvable, the loop keeps ticking but never polls/applies.
    #[tokio::test(start_paused = true)]
    async fn skips_ticks_when_no_client() {
        let poller = AgentStatusPoller::new();
        let (d, ticks, applied) = delegate(false);
        poller.ensure(d);

        // No client → the tick body has no inner await, so exactly one tick
        // elapses per advanced interval.
        advance_ticks(4).await;
        assert_eq!(
            ticks.load(Ordering::SeqCst),
            4,
            "loop keeps running — one tick per interval"
        );
        assert!(
            applied.lock().unwrap().is_empty(),
            "no client → poll/apply never reached"
        );
        assert!(poller.is_running());

        poller.stop();
    }

    /// Empty targets with instances still remaining skips only the tick — the
    /// poller stays alive and nothing is applied.
    #[tokio::test(start_paused = true)]
    async fn skips_tick_when_targets_empty_but_instances_remain() {
        let poller = AgentStatusPoller::new();
        let (d, ticks, applied) = delegate(true);
        d.targets_empty.store(true, Ordering::SeqCst);
        poller.ensure(d);

        // Empty targets short-circuit before the (awaiting) client poll, so the
        // tick body has no inner await and the drive is exact.
        advance_ticks(4).await;
        assert_eq!(
            ticks.load(Ordering::SeqCst),
            4,
            "loop stays alive — one tick per interval"
        );
        assert!(
            applied.lock().unwrap().is_empty(),
            "empty targets → poll/apply skipped this tick"
        );
        assert!(poller.is_running());

        poller.stop();
    }

    /// App teardown (ARCH-007, #3105): a poller owned by the app's [`AppTasks`]
    /// breaks on the app cancellation token — mid-sleep, without waiting for its
    /// next tick — and `shutdown` completes well within its bound.
    #[tokio::test(start_paused = true)]
    async fn stops_on_app_cancellation_and_teardown_completes_within_bound() {
        let tasks = AppTasks::new();
        let poller = AgentStatusPoller::with_tasks(tasks.clone());
        // Client-less delegate: loops forever, never self-reaps.
        let (d, ticks, _applied) = delegate(false);
        poller.ensure(d);
        advance_ticks(2).await;
        assert_eq!(ticks.load(Ordering::SeqCst), 2);
        assert!(poller.is_running());

        let started = tokio::time::Instant::now();
        let outcome = tasks
            .shutdown(crate::app_tasks::DEFAULT_SHUTDOWN_TIMEOUT)
            .await;

        assert_eq!(outcome, crate::app_tasks::ShutdownOutcome::Completed);
        assert!(
            started.elapsed() < TICK,
            "the loop must stop on cancellation, not on its next tick"
        );
        assert!(
            !poller.is_running(),
            "the cancelled loop self-reaps its slot"
        );
        // No further tick runs after teardown.
        tokio::time::advance(TICK * 3).await;
        tokio::task::yield_now().await;
        assert_eq!(ticks.load(Ordering::SeqCst), 2);
    }

    /// Once the app token is cancelled, a late `ensure` (e.g. an agent-hosted
    /// instance started during teardown) spawns a task that exits immediately
    /// instead of polling past shutdown.
    #[tokio::test(start_paused = true)]
    async fn ensure_after_app_cancellation_does_not_poll() {
        let tasks = AppTasks::new();
        let poller = AgentStatusPoller::with_tasks(tasks.clone());
        let outcome = tasks
            .shutdown(crate::app_tasks::DEFAULT_SHUTDOWN_TIMEOUT)
            .await;
        assert_eq!(outcome, crate::app_tasks::ShutdownOutcome::Completed);

        let (d, ticks, _applied) = delegate(true);
        poller.ensure(d);
        advance_until(|| !poller.is_running()).await;
        assert_eq!(ticks.load(Ordering::SeqCst), 0, "no tick after shutdown");
    }

    /// #6028: an instance added between a tick's empty snapshot and the end of
    /// the task is polled on, not left without a poller.
    #[tokio::test(start_paused = true)]
    async fn an_instance_added_while_the_poller_ends_is_polled_on() {
        struct Late {
            calls: Arc<AtomicUsize>,
            until: usize,
        }
        impl AgentStatusPollDelegate for Late {
            type Target = ();
            type Sample = ();
            fn interval(&self) -> Duration {
                TICK
            }
            fn client(&self) -> Option<Arc<dyn AgentRpcClient>> {
                None
            }
            fn snapshot_targets(&self) -> (Vec<()>, bool) {
                let call = self.calls.fetch_add(1, Ordering::SeqCst);
                // Nothing left on the first look, something on the second.
                (Vec::new(), call > 0 && call < self.until)
            }
            fn poll(_: Arc<dyn AgentRpcClient>, _: &[()]) -> Vec<()> {
                Vec::new()
            }
            fn apply(&self, _: Vec<()>) {}
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let poller = AgentStatusPoller::new();
        poller.ensure(Late {
            calls: Arc::clone(&calls),
            until: 5,
        });
        advance_ticks(1).await;
        assert!(poller.is_running(), "polls on");
        advance_until(|| !poller.is_running()).await;
        assert!(calls.load(Ordering::SeqCst) > 5);
    }

    /// A minimal [`AgentHosted`] handle for the tracker tests.
    struct Handle {
        agent_id: String,
        paused: bool,
    }

    impl AgentHosted for Handle {
        fn agent_id(&self) -> &str {
            &self.agent_id
        }
    }

    fn handle(agent: &str, paused: bool) -> Handle {
        Handle {
            agent_id: agent.to_string(),
            paused,
        }
    }

    #[test]
    fn agent_instances_insert_ids_clear() {
        let instances = AgentInstances::<Handle>::new();
        instances
            .lock()
            .unwrap()
            .insert("a".into(), handle("h1", false));
        instances
            .lock()
            .unwrap()
            .insert("b".into(), handle("h2", false));

        let mut ids = instances.ids();
        ids.sort();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);

        instances.clear();
        assert!(instances.ids().is_empty());
    }

    #[test]
    fn agent_instances_agent_id_of() {
        let instances = AgentInstances::<Handle>::new();
        instances
            .lock()
            .unwrap()
            .insert("m".into(), handle("edge", false));
        assert_eq!(instances.agent_id_of("m").as_deref(), Some("edge"));
        assert_eq!(instances.agent_id_of("missing"), None);
    }

    #[test]
    fn agent_instances_snapshot_targets_where_excludes_but_keeps_alive() {
        let instances = AgentInstances::<Handle>::new();
        instances
            .lock()
            .unwrap()
            .insert("live".into(), handle("h1", false));
        instances
            .lock()
            .unwrap()
            .insert("paused".into(), handle("h2", true));

        // A paused instance is excluded from the poll targets, but `any_remaining`
        // still reflects it so the poller is kept alive rather than stopped.
        let (targets, any_remaining) = instances.snapshot_targets_where(|h| !h.paused);
        assert_eq!(targets, vec![("live".to_string(), "h1".to_string())]);
        assert!(any_remaining);
    }
}
