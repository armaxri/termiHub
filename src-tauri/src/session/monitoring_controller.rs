//! Thin session-monitoring facade over a session's monitoring capability.
//!
//! Extracted from [`SessionManager`](super::manager::SessionManager) (#2110,
//! follow-up to the file-ops seam #2076) to keep the manager focused on session
//! lifecycle. Every method here is the exact logic that lived inline on the
//! manager: resolve the session's monitoring provider, forward the call, and map
//! errors to [`TerminalError`]. The behavior, error messages, event names
//! (`session-monitoring-stats` / `session-monitoring-status`), lock discipline,
//! and — crucially — the background push-task lifecycle (spawn / abort /
//! cancellation) are exactly what lived on the manager.
//!
//! Unlike [`FileOps`](super::file_ops::FileOps), which borrows only the
//! `sessions` map, this facade borrows a *second* map — the manager's
//! `monitoring_tasks` abort-handle registry — because
//! [`start_session_monitoring`](MonitoringController::start_session_monitoring)
//! spawns a background task and stores its [`AbortHandle`] there, and
//! [`stop_session_monitoring`](MonitoringController::stop_session_monitoring)
//! aborts it. It still carries no state of its own; the manager constructs one
//! on demand via `SessionManager::monitoring` borrowing both maps.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tauri::Emitter;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;
use tracing::{info, warn};

use termihub_core::monitoring::{MonitorStatus, MonitorStatusReceiver, MonitoringProvider};

use crate::run_location::{Locality, ResolvedLocation, RunLocation, RunLocationResolver};
use crate::session::remote_proxy::RemoteMonitoringProxy;
use crate::system_monitor_projection::projection::fold_monitor_transition;
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

use super::manager::{SessionEntry, SessionMonitoringStatsEvent, SessionMonitoringStatusEvent};

/// Receive from an optional status receiver for use inside `tokio::select!`.
///
/// When the receiver is `None`, the future never resolves (`pending`), so the
/// select arm is inert and the other arm drives the loop. This lets the status
/// arm be disabled after its channel closes without spinning on repeated
/// `None`s.
async fn recv_optional(rx: &mut Option<MonitorStatusReceiver>) -> Option<MonitorStatus> {
    match rx.as_mut() {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

/// Borrowing facade exposing a session's monitoring operations.
///
/// Holds only borrows of the manager's `sessions` and `monitoring_tasks` maps,
/// so it carries no state of its own; the manager constructs one on demand via
/// [`SessionManager::monitoring`](super::manager::SessionManager). Each method
/// mirrors the corresponding monitoring provider operation.
pub(super) struct MonitoringController<'a> {
    sessions: &'a Mutex<HashMap<String, SessionEntry>>,
    monitoring_tasks: &'a Mutex<HashMap<String, AbortHandle>>,
    /// Standalone monitoring providers for session monitors whose run-location
    /// resolved to an agent (#2593). Keyed by session id, these agent-self
    /// proxies are **not** owned by the session's connection, so pause /
    /// interval / stop / cancel consult this map first before falling back to
    /// the session provider.
    monitoring_overrides: &'a Mutex<HashMap<String, Arc<dyn MonitoringProvider + Send + Sync>>>,
}

impl<'a> MonitoringController<'a> {
    /// Wrap the manager's `sessions`, `monitoring_tasks` and
    /// `monitoring_overrides` maps.
    pub(super) fn new(
        sessions: &'a Mutex<HashMap<String, SessionEntry>>,
        monitoring_tasks: &'a Mutex<HashMap<String, AbortHandle>>,
        monitoring_overrides: &'a Mutex<HashMap<String, Arc<dyn MonitoringProvider + Send + Sync>>>,
    ) -> Self {
        Self {
            sessions,
            monitoring_tasks,
            monitoring_overrides,
        }
    }

    /// The agent-self monitoring provider override for a session, if its monitor
    /// was routed to an agent (#2593). A cloned `Arc` so the caller can await a
    /// provider method without holding the overrides lock.
    async fn override_provider(
        &self,
        session_id: &str,
    ) -> Option<Arc<dyn MonitoringProvider + Send + Sync>> {
        self.monitoring_overrides
            .lock()
            .await
            .get(session_id)
            .cloned()
    }

    /// Subscribe to a session's monitoring provider and forward stats and
    /// status as Tauri events.
    ///
    /// Spawns a background task that reads the subscription's stats and status
    /// channels and emits `session-monitoring-stats` and
    /// `session-monitoring-status` events to the frontend. The status stream
    /// lets the UI surface an explicit `Stale` arm on a mid-stream drop instead
    /// of rendering frozen stats as live (#1229, audit gap G1). Call
    /// [`stop_session_monitoring`](Self::stop_session_monitoring) to cancel the
    /// task and unsubscribe.
    pub(super) async fn start_session_monitoring<R: tauri::Runtime>(
        &self,
        session_id: &str,
        interval_ms: Option<u64>,
        run_location: RunLocation,
        app_handle: tauri::AppHandle<R>,
    ) -> Result<(), TerminalError> {
        // Resolve *where* this monitor runs (#2593). System monitoring may run on
        // the desktop or a chosen agent (`Locality::LocalOrAgent`); the default
        // `ThisComputer` resolves to the session's own provider, so existing
        // behaviour is unchanged.
        let resolved = RunLocationResolver::new()
            .resolve(session_id, Locality::LocalOrAgent, &run_location)
            .map_err(|e| TerminalError::RemoteError(e.to_string()))?;

        let subscription = match &resolved {
            ResolvedLocation::Local => {
                let subscription = {
                    let sessions = self.sessions.lock().await;
                    let entry = sessions
                        .get(session_id)
                        .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
                    let provider = entry.connection.monitoring().ok_or_else(|| {
                        TerminalError::RemoteError("No monitoring capability".to_string())
                    })?;
                    provider
                        .subscribe()
                        .await
                        .map_err(|e| TerminalError::RemoteError(e.to_string()))?
                };

                // Apply the caller's chosen refresh interval to the now-running
                // loop (#1233). Done after the subscribe block so the provider
                // reference is not held across this await. Takes effect on the
                // next tick; omitted → provider default.
                if let Some(ms) = interval_ms {
                    self.set_session_monitoring_interval(session_id, ms).await?;
                }
                subscription
            }
            ResolvedLocation::Agent(agent_id) => {
                // Route the subscription through the chosen agent's own host via
                // a standalone proxy that is not owned by the session's
                // connection (#2593). Stored as an override so pause / interval /
                // stop / cancel reach this proxy rather than the session provider.
                let client = agent_rpc_client(&app_handle).ok_or_else(|| {
                    TerminalError::RemoteError("Agent manager is not available".to_string())
                })?;
                let proxy: Arc<dyn MonitoringProvider + Send + Sync> = Arc::new(
                    RemoteMonitoringProxy::for_agent_self(agent_id.clone(), client),
                );
                // Set the interval before subscribing so the agent's initial ask
                // uses the chosen cadence (the proxy reads it in `subscribe`).
                if let Some(ms) = interval_ms {
                    proxy.set_interval(Duration::from_millis(ms.max(1))).await;
                }
                let subscription = proxy
                    .subscribe()
                    .await
                    .map_err(|e| TerminalError::RemoteError(e.to_string()))?;
                self.monitoring_overrides
                    .lock()
                    .await
                    .insert(session_id.to_string(), proxy);
                subscription
            }
        };

        let sid = session_id.to_string();
        let push_task = async move {
            let mut stats_rx = subscription.stats;
            // `Option` so a closed status channel stops being polled instead of
            // spinning the select loop hot on repeated `None` (the agent path
            // sends a single `Live` then drops its status sender).
            let mut status_rx = Some(subscription.status);
            loop {
                tokio::select! {
                    stats = stats_rx.recv() => {
                        match stats {
                            Some(stats) => {
                                // Server-authority fold (#2376): update the shared
                                // `SystemMonitorStore` at the source — the instant
                                // the collector loop produces the sample — and fan
                                // the region diff out. Additive: the Tauri event
                                // below and the client `monitor.stats` mirror stay
                                // in place, so no user-facing behavior changes.
                                fold_monitor_transition(&app_handle, |store| {
                                    store.stats(&sid, stats.clone());
                                });
                                let event = SessionMonitoringStatsEvent {
                                    session_id: sid.clone(),
                                    stats,
                                };
                                if app_handle.emit("session-monitoring-stats", &event).is_err() {
                                    break;
                                }
                            }
                            // Stats channel closed: the collector loop ended.
                            None => break,
                        }
                    }
                    status = recv_optional(&mut status_rx) => {
                        match status {
                            Some(status) => {
                                // Server-authority fold (#2376): mirror the
                                // collector-produced status transition into the
                                // shared store at the source (additive; see the
                                // stats arm above).
                                fold_monitor_transition(&app_handle, |store| {
                                    store.set_status(&sid, status);
                                });
                                let event = SessionMonitoringStatusEvent {
                                    session_id: sid.clone(),
                                    status,
                                };
                                if app_handle.emit("session-monitoring-status", &event).is_err() {
                                    break;
                                }
                            }
                            // Status channel closed: stop polling it, keep
                            // forwarding stats. Only a closed stats channel ends
                            // the task.
                            None => status_rx = None,
                        }
                    }
                }
            }
            info!(session_id = %sid, "Session monitoring push task ended");
        };

        self.spawn_and_register(session_id, push_task).await;
        Ok(())
    }

    /// Spawn the monitoring push task and register its [`AbortHandle`]
    /// atomically (CONC-006).
    ///
    /// Holds the `monitoring_tasks` lock across the spawn **and** the insert so a
    /// concurrent [`stop_session_monitoring`](Self::stop_session_monitoring)
    /// cannot slip into the gap between spawning the task and registering its
    /// handle — a stop that arrives during startup now always finds the handle
    /// and aborts the task. The lock is held with no `.await` inside the critical
    /// section (`tokio::spawn` is synchronous), so it is released immediately.
    ///
    /// The swap is also abort-then-replace: if a task was already registered for
    /// this session (a double start from a re-subscribe or a run-location
    /// change), the previous task is aborted before being replaced, so the old
    /// collector cannot leak and race the new one on the same region.
    async fn spawn_and_register<F>(&self, session_id: &str, task: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let mut tasks = self.monitoring_tasks.lock().await;
        let handle = tokio::spawn(task);
        if let Some(previous) = tasks.insert(session_id.to_string(), handle.abort_handle()) {
            previous.abort();
        }
    }

    /// Stop session-based monitoring: abort the push task and unsubscribe.
    pub(super) async fn stop_session_monitoring(
        &self,
        session_id: &str,
    ) -> Result<(), TerminalError> {
        if let Some(handle) = self.monitoring_tasks.lock().await.remove(session_id) {
            handle.abort();
        }

        // An agent-hosted monitor (#2593) is driven by a standalone override
        // proxy, not the session's connection — unsubscribe and drop it here.
        if let Some(proxy) = self.monitoring_overrides.lock().await.remove(session_id) {
            if let Err(e) = proxy.unsubscribe().await {
                warn!(session_id, error = %e, "Agent monitor unsubscribe error");
            }
            return Ok(());
        }

        let sessions = self.sessions.lock().await;
        if let Some(entry) = sessions.get(session_id) {
            if let Some(provider) = entry.connection.monitoring() {
                if let Err(e) = provider.unsubscribe().await {
                    warn!(session_id, error = %e, "Session monitoring unsubscribe error");
                }
            }
        }
        Ok(())
    }

    /// Pause or resume a session's monitoring loop (#1233).
    ///
    /// A paused loop keeps its transport open but stops collecting, emitting a
    /// `Paused` status event; resuming emits `Live`.
    pub(super) async fn set_session_monitoring_paused(
        &self,
        session_id: &str,
        paused: bool,
    ) -> Result<(), TerminalError> {
        if let Some(proxy) = self.override_provider(session_id).await {
            proxy.set_paused(paused).await;
            return Ok(());
        }
        let sessions = self.sessions.lock().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        let provider = entry
            .connection
            .monitoring()
            .ok_or_else(|| TerminalError::RemoteError("No monitoring capability".to_string()))?;
        provider.set_paused(paused).await;
        Ok(())
    }

    /// Change a session monitoring loop's refresh interval (#1233).
    pub(super) async fn set_session_monitoring_interval(
        &self,
        session_id: &str,
        interval_ms: u64,
    ) -> Result<(), TerminalError> {
        if let Some(proxy) = self.override_provider(session_id).await {
            proxy
                .set_interval(Duration::from_millis(interval_ms.max(1)))
                .await;
            return Ok(());
        }
        let sessions = self.sessions.lock().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        let provider = entry
            .connection
            .monitoring()
            .ok_or_else(|| TerminalError::RemoteError("No monitoring capability".to_string()))?;
        provider
            .set_interval(std::time::Duration::from_millis(interval_ms.max(1)))
            .await;
        Ok(())
    }

    /// Abort a session monitoring loop's in-flight connect / collect (#1233).
    ///
    /// Best-effort: a missing session or provider is treated as already gone.
    pub(super) async fn cancel_session_monitoring(
        &self,
        session_id: &str,
    ) -> Result<(), TerminalError> {
        if let Some(proxy) = self.override_provider(session_id).await {
            proxy.cancel_connect().await;
            return Ok(());
        }
        let sessions = self.sessions.lock().await;
        if let Some(entry) = sessions.get(session_id) {
            if let Some(provider) = entry.connection.monitoring() {
                provider.cancel_connect().await;
            }
        }
        Ok(())
    }
}

/// The agent RPC client from Tauri managed state, if available (#2593).
///
/// `None` before the app is fully set up (e.g. unit tests without a live Tauri
/// app), which the agent-routed path treats as "agent unavailable".
fn agent_rpc_client<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<Arc<dyn AgentRpcClient>> {
    use tauri::Manager;
    app.try_state::<Arc<dyn AgentRpcClient>>()
        .map(|state| (*state).clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use termihub_core::errors::CoreError;
    use termihub_core::monitoring::MonitoringSubscription;

    use super::super::manager::SessionEntry;

    /// A monitoring provider that records the control calls routed to it, so a
    /// test can assert an agent-hosted session monitor's controls hit its
    /// override proxy rather than the session's own connection (#2593).
    #[derive(Default)]
    struct RecordingProvider {
        paused: AtomicBool,
        interval_ms: AtomicU64,
        unsubscribed: AtomicBool,
        cancelled: AtomicBool,
    }

    #[async_trait::async_trait]
    impl MonitoringProvider for RecordingProvider {
        async fn subscribe(&self) -> Result<MonitoringSubscription, CoreError> {
            unreachable!("subscribe is exercised by the live agent path, not this routing test")
        }
        async fn unsubscribe(&self) -> Result<(), CoreError> {
            self.unsubscribed.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn set_interval(&self, interval: std::time::Duration) {
            self.interval_ms
                .store(interval.as_millis() as u64, Ordering::SeqCst);
        }
        async fn set_paused(&self, paused: bool) {
            self.paused.store(paused, Ordering::SeqCst);
        }
        async fn cancel_connect(&self) {
            self.cancelled.store(true, Ordering::SeqCst);
        }
    }

    type Sessions = Mutex<HashMap<String, SessionEntry>>;
    type Tasks = Mutex<HashMap<String, AbortHandle>>;
    type Overrides = Mutex<HashMap<String, Arc<dyn MonitoringProvider + Send + Sync>>>;

    fn empty_maps() -> (Sessions, Tasks, Overrides) {
        (
            Mutex::new(HashMap::new()),
            Mutex::new(HashMap::new()),
            Mutex::new(HashMap::new()),
        )
    }

    /// pause / interval / cancel / stop of an agent-hosted monitor are routed to
    /// the standalone override provider — never the (absent) session provider.
    #[tokio::test]
    async fn agent_override_routes_all_controls_to_the_proxy() {
        let (sessions, tasks, overrides) = empty_maps();
        let proxy = Arc::new(RecordingProvider::default());
        overrides.lock().await.insert(
            "sess1".to_string(),
            proxy.clone() as Arc<dyn MonitoringProvider + Send + Sync>,
        );

        let controller = MonitoringController::new(&sessions, &tasks, &overrides);

        // pause + interval reach the proxy even though no session exists.
        controller
            .set_session_monitoring_paused("sess1", true)
            .await
            .expect("pause should route to the override");
        controller
            .set_session_monitoring_interval("sess1", 5000)
            .await
            .expect("interval should route to the override");
        controller
            .cancel_session_monitoring("sess1")
            .await
            .expect("cancel should route to the override");

        assert!(proxy.paused.load(Ordering::SeqCst), "pause routed to proxy");
        assert_eq!(proxy.interval_ms.load(Ordering::SeqCst), 5000);
        assert!(
            proxy.cancelled.load(Ordering::SeqCst),
            "cancel routed to proxy"
        );

        // stop unsubscribes the proxy and drops the override.
        controller
            .stop_session_monitoring("sess1")
            .await
            .expect("stop should unsubscribe the override");
        assert!(
            proxy.unsubscribed.load(Ordering::SeqCst),
            "stop unsubscribed proxy"
        );
        assert!(
            overrides.lock().await.get("sess1").is_none(),
            "override removed after stop"
        );
    }

    /// A push-task stand-in that runs until aborted. It parks on `pending()`,
    /// so it never completes on its own; the returned receiver resolves (with
    /// `Err`, the sender having been dropped) exactly when the task is dropped —
    /// i.e. when its abort handle is fired — giving a deterministic abort signal
    /// with no sleeps.
    fn pending_task() -> (
        impl std::future::Future<Output = ()> + Send + 'static,
        tokio::sync::oneshot::Receiver<()>,
    ) {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let task = async move {
            let _tx = tx;
            std::future::pending::<()>().await;
        };
        (task, rx)
    }

    /// Starting monitoring twice for one session (re-subscribe / run-location
    /// change) must abort the previous push task rather than silently orphaning
    /// it, and leave exactly one handle registered (CONC-006, problem 1).
    #[tokio::test]
    async fn double_start_aborts_the_previous_push_task() {
        use std::time::Duration;

        let (sessions, tasks, overrides) = empty_maps();
        let controller = MonitoringController::new(&sessions, &tasks, &overrides);

        let (task1, rx1) = pending_task();
        controller.spawn_and_register("sess", task1).await;

        let (task2, mut rx2) = pending_task();
        controller.spawn_and_register("sess", task2).await;

        // The first task was aborted: its future is dropped, dropping the sender,
        // so the receiver resolves with `Err` (nothing was ever sent).
        tokio::time::timeout(Duration::from_secs(3), rx1)
            .await
            .expect("first task should be aborted promptly")
            .expect_err("an aborted task drops its sender without sending");

        // Exactly one handle survives for the session.
        assert_eq!(tasks.lock().await.len(), 1, "only one task registered");

        // The second task is still running (its channel is open, not closed).
        assert!(
            matches!(
                rx2.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ),
            "the replacement task must still be alive"
        );

        controller
            .stop_session_monitoring("sess")
            .await
            .expect("cleanup stop");
    }

    /// A stop arriving right after start still aborts the push task — the handle
    /// is registered atomically with the spawn, so there is no spawn→register
    /// window in which a stop returns without aborting (CONC-006, problem 2).
    #[tokio::test]
    async fn stop_right_after_start_aborts_the_push_task() {
        use std::time::Duration;

        let (sessions, tasks, overrides) = empty_maps();
        let controller = MonitoringController::new(&sessions, &tasks, &overrides);

        let (task, rx) = pending_task();
        controller.spawn_and_register("sess", task).await;

        controller
            .stop_session_monitoring("sess")
            .await
            .expect("stop should abort the registered task");

        tokio::time::timeout(Duration::from_secs(3), rx)
            .await
            .expect("task should be aborted promptly")
            .expect_err("an aborted task drops its sender without sending");

        assert!(
            tasks.lock().await.is_empty(),
            "the handle is removed on stop"
        );
    }

    /// With no override recorded, a missing session is treated as already gone —
    /// the desktop default path is unchanged for a session that never subscribed.
    #[tokio::test]
    async fn no_override_falls_back_to_session_path() {
        let (sessions, tasks, overrides) = empty_maps();
        let controller = MonitoringController::new(&sessions, &tasks, &overrides);

        // No session, no override: cancel/stop are best-effort no-ops (Ok).
        controller
            .cancel_session_monitoring("ghost")
            .await
            .expect("cancel of an unknown monitor is a no-op");
        controller
            .stop_session_monitoring("ghost")
            .await
            .expect("stop of an unknown monitor is a no-op");
    }
}
