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
            definition: Value,
        ) -> Result<AgentDefinitionInfo, TerminalError> {
            unimplemented!()
        }
        fn update_definition(
            &self,
            agent_id: &str,
            params: Value,
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
            params: Value,
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
            Duration::from_millis(10)
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

    async fn settle(ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    /// The happy path: with targets, a client, and instances remaining, the loop
    /// polls and applies samples every tick — and `stop` ends it.
    #[tokio::test]
    async fn polls_and_applies_until_stopped() {
        let poller = AgentStatusPoller::new();
        let (d, ticks, applied) = delegate(true);
        poller.ensure(d);

        settle(45).await;
        assert!(
            ticks.load(Ordering::SeqCst) >= 2,
            "loop should tick repeatedly"
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
    #[tokio::test]
    async fn self_reaps_when_no_instances_remain() {
        let poller = AgentStatusPoller::new();
        let (d, _ticks, applied) = delegate(true);
        d.any_remaining.store(false, Ordering::SeqCst);
        poller.ensure(d);

        settle(30).await;
        assert!(
            applied.lock().unwrap().is_empty(),
            "no instances remain → nothing polled"
        );
        assert!(!poller.is_running(), "the task should self-reap the slot");
    }

    /// A second `ensure` while the first task is live is a no-op: the second
    /// delegate never runs (proving a single task, not two).
    #[tokio::test]
    async fn ensure_is_idempotent_while_running() {
        let poller = AgentStatusPoller::new();
        // First delegate loops forever without a client (never applies).
        let (d1, _t1, _a1) = delegate(false);
        poller.ensure(d1);

        // Second delegate would apply markers if it ever ran.
        let (d2, ticks2, applied2) = delegate(true);
        poller.ensure(d2);

        settle(45).await;
        assert_eq!(
            ticks2.load(Ordering::SeqCst),
            0,
            "the second delegate must never run while the first holds the slot"
        );
        assert!(applied2.lock().unwrap().is_empty());

        poller.stop();
    }

    /// With no client resolvable, the loop keeps ticking but never polls/applies.
    #[tokio::test]
    async fn skips_ticks_when_no_client() {
        let poller = AgentStatusPoller::new();
        let (d, ticks, applied) = delegate(false);
        poller.ensure(d);

        settle(45).await;
        assert!(ticks.load(Ordering::SeqCst) >= 2, "loop keeps running");
        assert!(
            applied.lock().unwrap().is_empty(),
            "no client → poll/apply never reached"
        );
        assert!(poller.is_running());

        poller.stop();
    }

    /// Empty targets with instances still remaining skips only the tick — the
    /// poller stays alive and nothing is applied.
    #[tokio::test]
    async fn skips_tick_when_targets_empty_but_instances_remain() {
        let poller = AgentStatusPoller::new();
        let (d, ticks, applied) = delegate(true);
        d.targets_empty.store(true, Ordering::SeqCst);
        poller.ensure(d);

        settle(45).await;
        assert!(ticks.load(Ordering::SeqCst) >= 2, "loop stays alive");
        assert!(
            applied.lock().unwrap().is_empty(),
            "empty targets → poll/apply skipped this tick"
        );
        assert!(poller.is_running());

        poller.stop();
    }
}
