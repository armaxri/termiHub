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
//! thread, and aborting the task on shutdown.
//!
//! What stays service-specific (the delegate): which instances to poll, the
//! `*.status` RPC + reply parse, and how a fresh sample is written back into the
//! per-service handle and bridged to the frontend (a Tauri event, or a projection
//! publish). The per-service start/stop control paths — whose event and error
//! semantics genuinely diverge — stay in their managers.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::terminal::agent_manager::AgentRpcClient;

/// Resolve the shared agent RPC client from Tauri managed state, if available.
///
/// `None` before the app is fully set up (e.g. in unit tests without a live Tauri
/// app, or when no agent is connected); the agent-routed paths treat that as
/// "agent unavailable" and no-op the tick. A free function so the periodic poller
/// task can resolve the client fresh each tick — an agent may connect after the
/// poller started — without holding a manager reference.
pub fn agent_rpc_client(app: &AppHandle) -> Option<Arc<dyn AgentRpcClient>> {
    app.try_state::<Arc<dyn AgentRpcClient>>()
        .map(|state| (*state).clone())
}

/// The service-specific parts of one agent status-poll tick.
///
/// The generic [`AgentStatusPoller`] drives the loop; the delegate supplies which
/// instances to poll, the blocking status RPC + parse, and how to apply the
/// results. A delegate typically owns `Arc` clones of its manager's agent-instance
/// map and an [`AppHandle`], so it can read/write handles and emit events from the
/// poller task without a `&self` manager reference.
pub trait AgentStatusPollDelegate: Send + 'static {
    /// One parsed status sample per still-running instance (e.g. a `ServerState`,
    /// a `(tunnel_id, TunnelStats)`, a `(monitor_id, HttpCheckResult)`).
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

    /// Snapshot the `(instance_id, agent_id)` targets to poll this tick, plus
    /// whether **any** agent-hosted instance remains at all.
    ///
    /// The pair decides the loop's fate: `any_remaining == false` stops the poller
    /// (nothing left to sample); an empty `targets` list with `any_remaining ==
    /// true` skips only this tick (e.g. every instance is paused) and keeps the
    /// poller alive. Managers without a paused state simply return
    /// `any_remaining = !targets.is_empty()`.
    fn snapshot_targets(&self) -> (Vec<(String, String)>, bool);

    /// Run the blocking `*.status` RPC batch for `targets` and return one sample
    /// per still-running instance. Runs on a `spawn_blocking` thread (the RPC is
    /// blocking), so it takes no `&self` — pass owned/`Arc` data only.
    fn poll(client: Arc<dyn AgentRpcClient>, targets: &[(String, String)]) -> Vec<Self::Sample>;

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
}

impl AgentStatusPoller {
    /// Create an idle poller (no task running).
    pub fn new() -> Self {
        Self {
            slot: Arc::new(Mutex::new(None)),
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

        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;

                // Snapshot the targets, then decide the loop's fate before any
                // RPC so a slow agent never blocks a start/stop.
                let (targets, any_remaining) = delegate.snapshot_targets();
                // No agent-hosted instance left: stop polling and clear the slot so
                // a later start re-spawns the task.
                if !any_remaining {
                    break;
                }
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
                let samples = tokio::task::spawn_blocking(move || D::poll(client, &targets))
                    .await
                    .unwrap_or_default();

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
    fn is_running(&self) -> bool {
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
/// `contains` / `remove` / `ids` / `clear` / `agent_id` and status-poll-target
/// helpers around it, differing only in the per-protocol handle type. This wraps
/// that map once, keyed by instance id and generic over the handle `H`.
///
/// `Clone` shares the same underlying map (it clones the inner `Arc`), so a status
/// poller delegate can hold its own handle to the manager's live instances without
/// a `&self` reference — exactly the `Arc::clone` the delegates did by hand.
///
/// **Poison policy.** The convenience readers/mutators here
/// ([`remove`](Self::remove), [`ids`](Self::ids), [`clear`](Self::clear),
/// [`contains`](Self::contains), [`agent_id_of`](Self::agent_id_of),
/// [`snapshot_targets`](Self::snapshot_targets)) treat a poisoned lock as
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

    /// Whether an instance is tracked. A poisoned lock reads as absent.
    pub fn contains(&self, id: &str) -> bool {
        self.map.lock().map(|m| m.contains_key(id)).unwrap_or(false)
    }

    /// Remove and return an instance's handle. A poisoned lock returns `None`.
    pub fn remove(&self, id: &str) -> Option<H> {
        self.map.lock().ok()?.remove(id)
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

    /// Snapshot the `(instance_id, agent_id)` poll targets plus whether **any**
    /// instance remains, for [`AgentStatusPollDelegate::snapshot_targets`]. A
    /// poisoned lock returns `(empty, false)`, stopping the poller exactly as the
    /// old hand-rolled `break` did.
    pub fn snapshot_targets(&self) -> (Vec<(String, String)>, bool) {
        self.snapshot_targets_where(|_| true)
    }

    /// Like [`snapshot_targets`](Self::snapshot_targets) but polls only instances
    /// matching `include`; `any_remaining` still reflects **all** tracked
    /// instances, so an excluded-but-listed instance (e.g. a paused monitor) keeps
    /// the poller alive instead of stopping it.
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

    use crate::connection::config::AgentSettings;
    use crate::terminal::agent_manager::{
        AgentCapabilities, AgentConnectResult, AgentConnectionsData, AgentDefinitionInfo,
        AgentFolderInfo, AgentSessionInfo,
    };
    use crate::terminal::backend::{OutputSender, RemoteAgentConfig};
    use crate::utils::errors::TerminalError;
    use serde_json::Value;
    use termihub_core::monitoring::MonitoringSender;

    /// A do-nothing [`AgentRpcClient`]. The poller hands it to
    /// [`AgentStatusPollDelegate::poll`], which the test delegate ignores, so no
    /// method is ever called — every stub is `unimplemented!()`.
    struct NoopClient;

    // allow(unused_variables): test-only stub whose every method body is
    // `unimplemented!()`, so all trait-method parameters are intentionally unused.
    #[allow(unused_variables)]
    impl AgentRpcClient for NoopClient {
        fn connect_agent(
            &self,
            agent_id: &str,
            config: &RemoteAgentConfig,
            agent_settings: Option<&AgentSettings>,
        ) -> Result<AgentConnectResult, TerminalError> {
            unimplemented!()
        }
        fn cancel_connect(&self, agent_id: &str) -> bool {
            unimplemented!()
        }
        fn disconnect_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn is_connected(&self, agent_id: &str) -> bool {
            unimplemented!()
        }
        fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities> {
            unimplemented!()
        }
        fn shutdown_agent(
            &self,
            agent_id: &str,
            reason: Option<&str>,
        ) -> Result<u32, TerminalError> {
            unimplemented!()
        }
        fn send_request(
            &self,
            agent_id: &str,
            method: &str,
            params: Value,
        ) -> Result<Value, TerminalError> {
            unimplemented!()
        }
        #[allow(clippy::too_many_arguments)]
        fn create_session(
            &self,
            agent_id: &str,
            session_type: &str,
            config: Value,
            title: Option<&str>,
            definition_id: Option<&str>,
        ) -> Result<AgentSessionInfo, TerminalError> {
            unimplemented!()
        }
        fn attach_session(
            &self,
            agent_id: &str,
            remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn close_session(
            &self,
            agent_id: &str,
            remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn list_sessions(&self, agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
            unimplemented!()
        }
        fn list_connections_and_folders(
            &self,
            agent_id: &str,
        ) -> Result<AgentConnectionsData, TerminalError> {
            unimplemented!()
        }
        fn list_definitions(
            &self,
            agent_id: &str,
        ) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
            unimplemented!()
        }
        fn save_definition(
            &self,
            agent_id: &str,
            definition: termihub_core::protocol::methods::ConnectionCreateParams,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn update_definition(
            &self,
            agent_id: &str,
            params: termihub_core::protocol::methods::ConnectionUpdateParams,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn delete_definition(&self, agent_id: &str, def_id: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn create_folder(
            &self,
            agent_id: &str,
            name: &str,
            parent_id: Option<&str>,
        ) -> Result<AgentFolderInfo, TerminalError> {
            unimplemented!()
        }
        fn update_folder(
            &self,
            agent_id: &str,
            params: termihub_core::protocol::methods::FolderUpdateParams,
        ) -> Result<AgentFolderInfo, TerminalError> {
            unimplemented!()
        }
        fn delete_folder(&self, agent_id: &str, folder_id: &str) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn register_session_output(
            &self,
            agent_id: &str,
            remote_session_id: &str,
            output_tx: OutputSender,
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn unregister_session_output(
            &self,
            agent_id: &str,
            remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn register_monitoring_output(
            &self,
            agent_id: &str,
            remote_session_id: &str,
            monitoring_tx: MonitoringSender,
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn unregister_monitoring_output(
            &self,
            agent_id: &str,
            remote_session_id: &str,
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn send_session_input(
            &self,
            agent_id: &str,
            remote_session_id: &str,
            data: &[u8],
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn resize_session(
            &self,
            agent_id: &str,
            remote_session_id: &str,
            cols: u16,
            rows: u16,
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
        fn apply_agent_settings(
            &self,
            agent_id: &str,
            settings: &AgentSettings,
        ) -> Result<(), TerminalError> {
            unimplemented!()
        }
    }

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
        /// When true, `client` resolves to a `NoopClient`; otherwise `None`.
        with_client: bool,
    }

    impl AgentStatusPollDelegate for TestDelegate {
        type Sample = u32;

        fn interval(&self) -> Duration {
            TICK
        }

        fn client(&self) -> Option<Arc<dyn AgentRpcClient>> {
            if self.with_client {
                Some(Arc::new(NoopClient))
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
    fn agent_instances_insert_contains_remove_ids_clear() {
        let instances = AgentInstances::<Handle>::new();
        assert!(!instances.contains("a"));

        instances
            .lock()
            .unwrap()
            .insert("a".into(), handle("h1", false));
        instances
            .lock()
            .unwrap()
            .insert("b".into(), handle("h2", false));
        assert!(instances.contains("a"));
        assert!(!instances.contains("z"));

        let mut ids = instances.ids();
        ids.sort();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);

        let removed = instances.remove("a").expect("handle present");
        assert_eq!(removed.agent_id(), "h1");
        assert!(!instances.contains("a"));
        assert!(instances.remove("a").is_none(), "second remove is None");

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
    fn agent_instances_snapshot_targets_reports_all_pairs() {
        let instances = AgentInstances::<Handle>::new();
        assert_eq!(instances.snapshot_targets(), (Vec::new(), false));

        instances
            .lock()
            .unwrap()
            .insert("t1".into(), handle("h1", false));
        let (mut targets, any_remaining) = instances.snapshot_targets();
        targets.sort();
        assert_eq!(targets, vec![("t1".to_string(), "h1".to_string())]);
        assert!(any_remaining);
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
