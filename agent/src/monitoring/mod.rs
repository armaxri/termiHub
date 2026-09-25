//! System monitoring: periodic stats collection and notification streaming.
//!
//! Supports monitoring the agent's own host ("self") and remote SSH
//! jump targets (by connection ID). Stats are collected at a configurable
//! interval and sent as `connection.monitoring.data` JSON-RPC notifications.
//! Every collect-loop status transition is also sent as a
//! `connection.monitoring.status` notification (#3321), so the desktop can
//! mirror the agent's own status instead of inferring it from missing samples.

pub mod collector;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use termihub_core::errors::CoreError;
use termihub_core::monitoring::{
    BackoffSchedule, CollectLoopState, MonitorStatus, BACKOFF_CAP, DEFAULT_BACKOFF_BASE,
    DEFAULT_COLLECT_TIMEOUT, DEFAULT_MAX_RECONNECT_ATTEMPTS, DEFAULT_MONITORING_INTERVAL_MS,
};

use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::{
    MonitoringData, MonitoringStatusNotification, SshSessionConfig, CONNECTION_MONITORING_DATA,
    CONNECTION_MONITORING_STATUS,
};
use crate::session::definitions::ConnectionStore;

use self::collector::{LocalCollector, SshCollector, StatsCollector};

/// Opens a fresh [`StatsCollector`], re-dialing the transport for remote hosts.
///
/// Shared (`Arc`) so the monitoring task can invoke it both for the initial
/// connect and for each bounded reconnect attempt after a sustained drop
/// (#1230, gap G2). Each call runs on a blocking thread (SSH connect is
/// blocking).
type CollectorFactory = Arc<dyn Fn() -> Result<Box<dyn StatsCollector>> + Send + Sync + 'static>;

/// Minimum allowed collection interval in milliseconds.
const MIN_INTERVAL_MS: u64 = 500;

/// Maximum time a single collect may take before it is treated as a failure.
///
/// Bounds a stalled SSH collect (half-dropped TCP, unresponsive remote) so the
/// task returns to its `select!` — where cancellation is honored — instead of
/// awaiting the collect forever (#1228, gap G3). The sequential loop is the
/// in-flight guard: the next tick's collect never starts until this one
/// resolves or times out. Shared with the desktop via core, which sizes its
/// `Stale` bound from it (#3321).
const COLLECT_TIMEOUT: Duration = DEFAULT_COLLECT_TIMEOUT;

// ── MonitoringManagerApi trait ─────────────────────────────────────

/// Abstract interface over the monitoring manager.
///
/// Implemented by [`MonitoringManager`] in production and by mock structs
/// in tests. [`crate::handler::dispatch::Dispatcher`] depends on this trait
/// so it can be tested without spawning real background tasks.
#[async_trait::async_trait]
pub trait MonitoringManagerApi: Send + Sync + 'static {
    /// Start monitoring a host (or replace an existing subscription).
    async fn subscribe(&self, host: &str, interval_ms: Option<u64>) -> Result<()>;

    /// Stop monitoring a host.
    async fn unsubscribe(&self, host: &str);

    /// Cancel all subscriptions (called on agent shutdown).
    async fn shutdown(&self);
}

/// Manages active monitoring subscriptions.
///
/// Each subscription spawns a background tokio task that periodically
/// collects system stats and sends `connection.monitoring.data` notifications.
pub struct MonitoringManager {
    subscriptions: Mutex<HashMap<String, Subscription>>,
    notification_tx: NotificationSender,
    connection_store: Arc<ConnectionStore>,
}

/// An active monitoring subscription.
struct Subscription {
    cancel: CancellationToken,
    join_handle: JoinHandle<()>,
}

impl MonitoringManager {
    pub fn new(
        notification_tx: NotificationSender,
        connection_store: Arc<ConnectionStore>,
    ) -> Self {
        Self {
            subscriptions: Mutex::new(HashMap::new()),
            notification_tx,
            connection_store,
        }
    }

    /// Start monitoring a host.
    ///
    /// - `host = "self"`: monitor the agent's own host
    /// - `host = "<connection_id>"`: monitor a remote host via SSH
    ///
    /// If already subscribed to this host, the existing subscription is
    /// replaced (unsubscribed then re-subscribed).
    pub async fn subscribe(&self, host: &str, interval_ms: Option<u64>) -> Result<()> {
        let interval = interval_ms
            .unwrap_or(DEFAULT_MONITORING_INTERVAL_MS)
            .max(MIN_INTERVAL_MS);

        // If already subscribed, cancel the old subscription first
        {
            let mut subs = self.subscriptions.lock().await;
            if let Some(old) = subs.remove(host) {
                old.cancel.cancel();
                old.join_handle.abort();
                debug!("Replaced existing monitoring subscription for '{host}'");
            }
        }

        // Build a collector *factory* so the monitoring task can re-dial the
        // transport in place after a sustained drop (#1230, gap G2). The
        // factory captures the connection details; each call opens a fresh
        // collector (a new SSH session for remote hosts). It is `Arc`-shared so
        // both the initial open and later reconnects can run it inside
        // `spawn_blocking` without moving it out of the task.
        let factory: CollectorFactory = if host == "self" {
            Arc::new(|| Ok(Box::new(LocalCollector::new()) as Box<dyn StatsCollector>))
        } else {
            // Look up the connection to get SSH config
            let connection = self
                .connection_store
                .get(host)
                .await
                .ok_or_else(|| anyhow::anyhow!("Connection not found: {host}"))?;

            if connection.session_type != "ssh" {
                bail!(
                    "Monitoring is only supported for SSH connections (got '{}')",
                    connection.session_type
                );
            }

            let ssh_config: SshSessionConfig = serde_json::from_value(connection.config)
                .map_err(|e| anyhow::anyhow!("Invalid SSH config for connection '{host}': {e}"))?;

            Arc::new(move || {
                SshCollector::new(&ssh_config)
                    .map(|c| Box::new(c) as Box<dyn StatsCollector>)
                    .map_err(|e| anyhow::anyhow!("SSH monitoring reconnect failed: {e}"))
            })
        };

        // Open the first collector up front so a connect failure surfaces as an
        // `Err` from `subscribe` (honest connect, #1228 gap G4) rather than a
        // task that silently retries.
        let first = {
            let factory = factory.clone();
            tokio::task::spawn_blocking(move || factory())
                .await
                .map_err(|e| anyhow::anyhow!("Failed to spawn collector task: {e}"))??
        };

        let cancel = CancellationToken::new();
        let host_label = host.to_string();
        let tx = self.notification_tx.clone();

        let reconnect_backoff = BackoffSchedule::new(
            DEFAULT_BACKOFF_BASE,
            BACKOFF_CAP,
            DEFAULT_MAX_RECONNECT_ATTEMPTS,
        );

        let join_handle = tokio::spawn(monitoring_task(
            host_label.clone(),
            first,
            factory,
            Duration::from_millis(interval),
            reconnect_backoff,
            tx,
            cancel.clone(),
        ));

        info!(
            "Started monitoring subscription for '{}' (interval: {}ms)",
            host, interval
        );

        let mut subs = self.subscriptions.lock().await;
        subs.insert(
            host.to_string(),
            Subscription {
                cancel,
                join_handle,
            },
        );

        Ok(())
    }

    /// Stop monitoring a host. Returns `true` if a subscription existed.
    pub async fn unsubscribe(&self, host: &str) -> bool {
        let mut subs = self.subscriptions.lock().await;
        if let Some(sub) = subs.remove(host) {
            sub.cancel.cancel();
            sub.join_handle.abort();
            info!("Stopped monitoring subscription for '{host}'");
            true
        } else {
            false
        }
    }

    /// Cancel all active subscriptions (called during agent shutdown).
    pub async fn shutdown(&self) {
        let mut subs = self.subscriptions.lock().await;
        for (host, sub) in subs.drain() {
            sub.cancel.cancel();
            sub.join_handle.abort();
            debug!("Shutdown: cancelled monitoring for '{host}'");
        }
    }
}

// ── MonitoringManagerApi impl ──────────────────────────────────────

#[async_trait::async_trait]
impl MonitoringManagerApi for MonitoringManager {
    async fn subscribe(&self, host: &str, interval_ms: Option<u64>) -> Result<()> {
        MonitoringManager::subscribe(self, host, interval_ms).await
    }

    async fn unsubscribe(&self, host: &str) {
        MonitoringManager::unsubscribe(self, host).await;
    }

    async fn shutdown(&self) {
        MonitoringManager::shutdown(self).await;
    }
}

/// The classified outcome of a single collect tick.
enum CollectOutcome {
    /// A fresh sample was produced.
    Sample(Box<termihub_core::monitoring::SystemStats>),
    /// The collect failed (error, timeout, or panic) — no fresh sample.
    Failed,
    /// The transport answered, but its output could not be parsed (#3300).
    Unparseable,
}

/// Run one bounded collect against the shared collector.
async fn collect_tick(
    host: &str,
    collector: &Arc<std::sync::Mutex<Box<dyn StatsCollector>>>,
) -> CollectOutcome {
    let collector = collector.clone();
    let host_label = host.to_string();
    let collect = tokio::task::spawn_blocking(move || {
        // A poisoned lock means a prior collect panicked; treat the poisoned
        // guard's inner value as usable rather than propagating the panic.
        let mut c = match collector.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        c.collect(&host_label)
    });

    // Bound the collect so a stalled remote cannot pin the loop and keep it
    // from ever re-checking cancellation (#1228, G3).
    match tokio::time::timeout(COLLECT_TIMEOUT, collect).await {
        Ok(Ok(Ok(stats))) => CollectOutcome::Sample(Box::new(stats)),
        Ok(Ok(Err(CoreError::Unparseable(e)))) => {
            warn!("Monitoring output unparseable for '{host}': {e}");
            CollectOutcome::Unparseable
        }
        Ok(Ok(Err(e))) => {
            warn!("Monitoring collection failed for '{host}': {e}");
            CollectOutcome::Failed
        }
        Ok(Err(e)) => {
            warn!("Monitoring collect task panicked for '{host}': {e}");
            CollectOutcome::Failed
        }
        Err(_elapsed) => {
            warn!("Monitoring collection timed out for '{host}'");
            CollectOutcome::Failed
        }
    }
}

/// Re-open the collector under a bounded exponential backoff (#1230, gap G2).
///
/// Returns the fresh collector on the first successful re-dial, or `None` when
/// the [`BackoffSchedule`] budget is exhausted (or the task is cancelled),
/// signalling the caller to stop as `Offline`.
async fn reconnect_collector(
    host: &str,
    factory: &CollectorFactory,
    mut backoff: BackoffSchedule,
    cancel: &CancellationToken,
) -> Option<Box<dyn StatsCollector>> {
    while let Some(delay) = backoff.next_delay() {
        tokio::select! {
            _ = cancel.cancelled() => return None,
            _ = tokio::time::sleep(delay) => {}
        }
        let factory = factory.clone();
        match tokio::task::spawn_blocking(move || factory()).await {
            Ok(Ok(collector)) => {
                debug!("Monitoring reconnected for '{host}'");
                return Some(collector);
            }
            Ok(Err(e)) => debug!("Monitoring reconnect attempt failed for '{host}': {e}"),
            Err(e) => debug!("Monitoring reconnect task panicked for '{host}': {e}"),
        }
    }
    None
}

/// Report a collect-loop status transition to the desktop as a
/// `connection.monitoring.status` notification (#3321).
///
/// Best-effort: a closed notification channel is detected (and ends the task)
/// on the next data send, so a failed status send is only logged.
fn emit_status(tx: &NotificationSender, host: &str, loop_state: &CollectLoopState) {
    let payload = MonitoringStatusNotification {
        host: host.to_string(),
        status: loop_state.status(),
        reason: loop_state.reason(),
    };
    debug!(
        "Monitoring status for '{host}': {:?} ({:?})",
        payload.status, payload.reason
    );
    match serde_json::to_value(&payload) {
        Ok(value) => {
            let notification = JsonRpcNotification::new(CONNECTION_MONITORING_STATUS, value);
            if tx.send(notification).is_err() {
                debug!("Notification channel closed; status for '{host}' not sent");
            }
        }
        Err(e) => warn!("Failed to serialize monitoring status for '{host}': {e}"),
    }
}

/// Background task that periodically collects stats and sends notifications.
///
/// The collector is wrapped in `Arc<std::sync::Mutex>` so it can be shared with
/// `spawn_blocking` calls (collection involves blocking I/O). After
/// [`DEFAULT_STALE_THRESHOLD`](termihub_core::monitoring::DEFAULT_STALE_THRESHOLD)
/// consecutive failures the task re-dials the transport via `factory` under a
/// bounded exponential backoff, resolving to a recovered stream or stopping
/// once the reconnect budget is exhausted (#1230, gap G2).
async fn monitoring_task(
    host: String,
    collector: Box<dyn StatsCollector>,
    factory: CollectorFactory,
    interval: Duration,
    reconnect_backoff: BackoffSchedule,
    tx: NotificationSender,
    cancel: CancellationToken,
) {
    let collector = Arc::new(std::sync::Mutex::new(collector));
    let mut ticker = tokio::time::interval(interval);
    let mut loop_state = CollectLoopState::new();
    let backoff = reconnect_backoff;

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                debug!("Monitoring task for '{}' cancelled", host);
                break;
            }
            _ = ticker.tick() => {
                match collect_tick(&host, &collector).await {
                    CollectOutcome::Sample(stats) => {
                        // Status before data, so the desktop has applied `Live`
                        // by the time it sees the sample.
                        if loop_state.on_success().is_some() {
                            emit_status(&tx, &host, &loop_state);
                        }
                        let data = MonitoringData::new(host.clone(), *stats);
                        match serde_json::to_value(&data) {
                            Ok(value) => {
                                let notification =
                                    JsonRpcNotification::new(CONNECTION_MONITORING_DATA, value);
                                if tx.send(notification).is_err() {
                                    debug!("Notification channel closed, stopping monitoring for '{host}'");
                                    break;
                                }
                            }
                            Err(e) => warn!("Failed to serialize monitoring data for '{host}': {e}"),
                        }
                    }
                    CollectOutcome::Failed => {
                        if loop_state.on_failure().is_some() {
                            emit_status(&tx, &host, &loop_state);
                        }
                    }
                    CollectOutcome::Unparseable => {
                        if loop_state.on_parse_failure().is_some() {
                            emit_status(&tx, &host, &loop_state);
                        }
                    }
                }

                // No sample since (re)connecting within the bounded pre-Live
                // failure run (parse: `stale_threshold`; transport: the more
                // generous `pre_live_failure_limit`): `Offline` is terminal, so
                // stop streaming. The transition was already reported to the
                // desktop above (#3321); an older desktop infers the same bound
                // from the missing samples (#3300).
                if loop_state.is_offline() {
                    warn!("Monitoring for '{host}' never produced a sample: Offline");
                    break;
                }

                // A sustained drop triggers a bounded reconnect campaign that
                // re-dials the transport in place (#1230, gap G2).
                if loop_state.should_begin_reconnect() {
                    if loop_state.begin_reconnect().is_some() {
                        emit_status(&tx, &host, &loop_state);
                    }
                    match reconnect_collector(&host, &factory, backoff.clone(), &cancel).await {
                        Some(fresh) => {
                            *collector.lock().unwrap_or_else(|p| p.into_inner()) = fresh;
                        }
                        None => {
                            if let Some(status @ MonitorStatus::Offline) = loop_state.exhaust_reconnect() {
                                warn!("Monitoring for '{host}' exhausted reconnect budget: {status:?}");
                                emit_status(&tx, &host, &loop_state);
                            }
                            break;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscribe_self_and_unsubscribe() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp =
            std::env::temp_dir().join(format!("termihub-mon-test-{}.json", uuid::Uuid::new_v4()));
        let store = Arc::new(ConnectionStore::new_temp(tmp));
        let manager = MonitoringManager::new(tx, store);

        // Subscribe to self
        let result = manager.subscribe("self", Some(1000)).await;
        assert!(result.is_ok());

        // Should have one subscription
        assert_eq!(manager.subscriptions.lock().await.len(), 1);

        // Unsubscribe
        assert!(manager.unsubscribe("self").await);
        assert_eq!(manager.subscriptions.lock().await.len(), 0);

        // Unsubscribe again returns false
        assert!(!manager.unsubscribe("self").await);
    }

    #[tokio::test]
    async fn subscribe_replaces_existing() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp =
            std::env::temp_dir().join(format!("termihub-mon-test-{}.json", uuid::Uuid::new_v4()));
        let store = Arc::new(ConnectionStore::new_temp(tmp));
        let manager = MonitoringManager::new(tx, store);

        manager.subscribe("self", Some(2000)).await.unwrap();
        manager.subscribe("self", Some(5000)).await.unwrap();

        // Should still be one subscription (replaced)
        assert_eq!(manager.subscriptions.lock().await.len(), 1);

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn subscribe_unknown_connection_fails() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp =
            std::env::temp_dir().join(format!("termihub-mon-test-{}.json", uuid::Uuid::new_v4()));
        let store = Arc::new(ConnectionStore::new_temp(tmp));
        let manager = MonitoringManager::new(tx, store);

        let result = manager.subscribe("nonexistent-conn", None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn shutdown_clears_all() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp =
            std::env::temp_dir().join(format!("termihub-mon-test-{}.json", uuid::Uuid::new_v4()));
        let store = Arc::new(ConnectionStore::new_temp(tmp));
        let manager = MonitoringManager::new(tx, store);

        manager.subscribe("self", Some(1000)).await.unwrap();
        assert_eq!(manager.subscriptions.lock().await.len(), 1);

        manager.shutdown().await;
        assert_eq!(manager.subscriptions.lock().await.len(), 0);
    }

    // ── Reconnect behavior (#1230, gap G2) ─────────────────────────────

    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use termihub_core::monitoring::{MonitorStatusReason, SystemStats};

    type Received = tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>;

    /// Everything queued on the notification channel right now.
    fn drain(rx: &mut Received) -> Vec<JsonRpcNotification> {
        let mut out = Vec::new();
        while let Ok(n) = rx.try_recv() {
            out.push(n);
        }
        out
    }

    /// The `connection.monitoring.status` payloads, in order (#3321).
    fn statuses(notifs: &[JsonRpcNotification]) -> Vec<MonitoringStatusNotification> {
        notifs
            .iter()
            .filter(|n| n.method == CONNECTION_MONITORING_STATUS)
            .map(|n| serde_json::from_value(n.params.clone()).expect("status payload"))
            .collect()
    }

    /// Number of `connection.monitoring.data` samples.
    fn data_count(notifs: &[JsonRpcNotification]) -> usize {
        notifs
            .iter()
            .filter(|n| n.method == CONNECTION_MONITORING_DATA)
            .count()
    }

    fn status(
        status: MonitorStatus,
        reason: Option<MonitorStatusReason>,
    ) -> MonitoringStatusNotification {
        MonitoringStatusNotification {
            host: "fake".into(),
            status,
            reason,
        }
    }

    fn sample_stats() -> SystemStats {
        SystemStats {
            hostname: "fake".into(),
            uptime_seconds: 1.0,
            load_average: [0.0, 0.0, 0.0],
            cpu_usage_percent: 1.0,
            memory_total_kb: 1000,
            memory_available_kb: 500,
            memory_used_percent: 50.0,
            disk_total_kb: 1000,
            disk_used_kb: 500,
            disk_used_percent: 50.0,
            os_info: "test".into(),
            swap_total_kb: 1000,
            swap_used_kb: 250,
            swap_used_percent: 25.0,
            net_rx_bytes_per_sec: 128.0,
            net_tx_bytes_per_sec: 64.0,
            per_core_cpu_percent: vec![40.0, 60.0],
        }
    }

    /// A collector whose collects fail once a shared flag is set (a mid-stream
    /// drop), used to exercise the reconnect campaign without a real transport.
    struct FakeCollector {
        fail: Arc<AtomicBool>,
    }

    impl StatsCollector for FakeCollector {
        fn collect(&mut self, _host_label: &str) -> Result<SystemStats, CoreError> {
            if self.fail.load(Ordering::SeqCst) {
                Err(CoreError::Other("collect dropped".into()))
            } else {
                Ok(sample_stats())
            }
        }
    }

    /// A monitoring task with a short interval that recovers after a drop
    /// re-dials once and resumes sending stats.
    #[tokio::test]
    async fn monitoring_task_reconnects_and_resumes() {
        let fail = Arc::new(AtomicBool::new(false));
        let redial_calls = Arc::new(AtomicUsize::new(0));

        let factory: CollectorFactory = {
            let redial_calls = redial_calls.clone();
            Arc::new(move || {
                redial_calls.fetch_add(1, Ordering::SeqCst);
                // A re-dialed collector always succeeds (drop was transient).
                Ok(Box::new(FakeCollector {
                    fail: Arc::new(AtomicBool::new(false)),
                }) as Box<dyn StatsCollector>)
            })
        };

        let first = Box::new(FakeCollector { fail: fail.clone() }) as Box<dyn StatsCollector>;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancellationToken::new();

        let handle = tokio::spawn(monitoring_task(
            "fake".into(),
            first,
            factory,
            Duration::from_millis(20),
            BackoffSchedule::new(Duration::from_millis(5), Duration::from_millis(20), 8),
            tx,
            cancel.clone(),
        ));

        // First sample arrives.
        let first_notif = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("first sample before timeout");
        assert!(first_notif.is_some(), "a live sample must be sent");

        // Drop the stream; the collector's collects now fail.
        fail.store(true, Ordering::SeqCst);

        // After the reconnect campaign re-dials, fresh samples flow again.
        let mut got_post_reconnect_sample = false;
        for _ in 0..50 {
            match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
                Ok(Some(_)) if redial_calls.load(Ordering::SeqCst) > 0 => {
                    got_post_reconnect_sample = true;
                    break;
                }
                Ok(Some(_)) => {}
                _ => {}
            }
        }
        assert!(
            redial_calls.load(Ordering::SeqCst) > 0,
            "the task must re-dial via the factory after a sustained drop"
        );
        assert!(
            got_post_reconnect_sample,
            "fresh samples must resume after a successful reconnect"
        );

        cancel.cancel();
        let _ = handle.await;
    }

    /// When every re-dial fails, the task exhausts its backoff budget and stops.
    #[tokio::test]
    async fn monitoring_task_stops_when_reconnect_exhausted() {
        // Start healthy (so the loop reaches `Live`), then drop mid-stream: the
        // failure run flips it to `Stale` and triggers the reconnect campaign.
        let fail = Arc::new(AtomicBool::new(false));
        let redial_calls = Arc::new(AtomicUsize::new(0));

        let factory: CollectorFactory = {
            let redial_calls = redial_calls.clone();
            Arc::new(move || {
                redial_calls.fetch_add(1, Ordering::SeqCst);
                Err(anyhow::anyhow!("reconnect refused"))
            })
        };

        let first = Box::new(FakeCollector { fail: fail.clone() }) as Box<dyn StatsCollector>;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancellationToken::new();

        let handle = tokio::spawn(monitoring_task(
            "fake".into(),
            first,
            factory,
            Duration::from_millis(20),
            BackoffSchedule::new(Duration::from_millis(5), Duration::from_millis(20), 3),
            tx,
            cancel,
        ));

        // Wait for a real sample — proof the loop reached `Live` — before dropping
        // the stream, rather than a fixed sleep that flakes on a loaded runner
        // where the first collect can miss a tight window (mirrors
        // `monitoring_task_reconnects_and_resumes`). Only a genuine Live→Stale
        // drop exercises the reconnect campaign this test asserts on.
        let first_sample = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("first live sample before timeout");
        assert!(first_sample.is_some(), "a live sample must be sent");
        fail.store(true, Ordering::SeqCst);

        // The task must terminate on its own (budget exhausted → Offline),
        // not run forever.
        let joined = tokio::time::timeout(Duration::from_secs(10), handle).await;
        assert!(
            joined.is_ok(),
            "the task must stop once the reconnect budget is exhausted"
        );
        assert!(
            redial_calls.load(Ordering::SeqCst) >= 1,
            "at least one re-dial must be attempted before giving up"
        );

        // The desktop is told each transition, ending on a transport-typed
        // Offline — not left to infer it from the silence (#3321). The first
        // `recv` above consumed the `Live` status.
        assert_eq!(
            statuses(&drain(&mut rx)),
            vec![
                status(MonitorStatus::Stale, Some(MonitorStatusReason::Transport)),
                status(
                    MonitorStatus::Reconnecting,
                    Some(MonitorStatusReason::Transport)
                ),
                status(MonitorStatus::Offline, Some(MonitorStatusReason::Transport)),
            ]
        );
    }

    // ── Bounded pre-Live resolution (#3300) ────────────────────────────

    /// A collector whose every collect fails with a caller-chosen error,
    /// counting its calls.
    struct AlwaysFailingCollector {
        calls: Arc<AtomicUsize>,
        unparseable: bool,
    }

    impl StatsCollector for AlwaysFailingCollector {
        fn collect(&mut self, _host_label: &str) -> Result<SystemStats, CoreError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.unparseable {
                Err(CoreError::Unparseable("too few lines".into()))
            } else {
                Err(CoreError::Other("exec failed".into()))
            }
        }
    }

    /// A factory that counts re-dials and hands out always-failing collectors.
    fn counting_failing_factory(
        redials: Arc<AtomicUsize>,
        calls: Arc<AtomicUsize>,
        unparseable: bool,
    ) -> CollectorFactory {
        Arc::new(move || {
            redials.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(AlwaysFailingCollector {
                calls: calls.clone(),
                unparseable,
            }) as Box<dyn StatsCollector>)
        })
    }

    /// Run `monitoring_task` over `first` and wait for it to end on its own.
    async fn run_until_task_ends(
        first: Box<dyn StatsCollector>,
        factory: CollectorFactory,
    ) -> tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = tokio::spawn(monitoring_task(
            "fake".into(),
            first,
            factory,
            Duration::from_millis(20),
            BackoffSchedule::new(Duration::from_millis(5), Duration::from_millis(20), 8),
            tx,
            CancellationToken::new(),
        ));
        tokio::time::timeout(Duration::from_secs(10), handle)
            .await
            .expect("the task must resolve Offline and stop on its own")
            .expect("the task must not panic");
        rx
    }

    /// A collector that connects but whose every collect fails at the transport
    /// level must not poll forever in `Connecting`: after `pre_live_failure_limit`
    /// collects the task resolves `Offline` and stops, without a re-dial.
    #[tokio::test]
    async fn monitoring_task_stops_when_no_first_sample_ever_arrives() {
        let calls = Arc::new(AtomicUsize::new(0));
        let redials = Arc::new(AtomicUsize::new(0));
        let first = Box::new(AlwaysFailingCollector {
            calls: calls.clone(),
            unparseable: false,
        }) as Box<dyn StatsCollector>;

        let mut rx = run_until_task_ends(
            first,
            counting_failing_factory(redials.clone(), calls.clone(), false),
        )
        .await;

        assert_eq!(
            calls.load(Ordering::SeqCst),
            CollectLoopState::new().pre_live_failure_limit() as usize,
            "transport failures use the generous pre-Live bound"
        );
        assert_eq!(redials.load(Ordering::SeqCst), 0, "no re-dial before Live");
        let notifs = drain(&mut rx);
        assert_eq!(data_count(&notifs), 0, "no sample was ever streamed");
        assert_eq!(
            statuses(&notifs),
            vec![status(
                MonitorStatus::Offline,
                Some(MonitorStatusReason::Transport)
            )],
            "the pre-Live Offline is reported, typed as a transport failure (#3321)"
        );
    }

    /// Persistently unparseable output is typed apart from a transport failure
    /// and resolves on the strict parse bound (`stale_threshold` collects).
    #[tokio::test]
    async fn monitoring_task_stops_on_persistently_unparseable_output() {
        let calls = Arc::new(AtomicUsize::new(0));
        let redials = Arc::new(AtomicUsize::new(0));
        let first = Box::new(AlwaysFailingCollector {
            calls: calls.clone(),
            unparseable: true,
        }) as Box<dyn StatsCollector>;

        let mut rx = run_until_task_ends(
            first,
            counting_failing_factory(redials.clone(), calls.clone(), true),
        )
        .await;

        assert_eq!(
            calls.load(Ordering::SeqCst),
            termihub_core::monitoring::DEFAULT_STALE_THRESHOLD as usize,
            "unparseable output uses the strict parse bound, not the transport one"
        );
        assert_eq!(redials.load(Ordering::SeqCst), 0, "no re-dial before Live");
        let notifs = drain(&mut rx);
        assert_eq!(data_count(&notifs), 0, "no sample was ever streamed");
        assert_eq!(
            statuses(&notifs),
            vec![status(
                MonitorStatus::Offline,
                Some(MonitorStatusReason::Parse)
            )],
            "the unparseable Offline is reported, typed as a parse failure (#3321)"
        );
    }

    /// After a mid-stream drop the re-dial succeeds but the fresh collector
    /// never samples: the task must not sit in `Reconnecting` forever.
    #[tokio::test]
    async fn monitoring_task_stops_when_re_dialled_collector_never_samples() {
        let fail = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        let redials = Arc::new(AtomicUsize::new(0));
        let first = Box::new(FakeCollector { fail: fail.clone() }) as Box<dyn StatsCollector>;

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = tokio::spawn(monitoring_task(
            "fake".into(),
            first,
            counting_failing_factory(redials.clone(), calls.clone(), false),
            Duration::from_millis(20),
            BackoffSchedule::new(Duration::from_millis(5), Duration::from_millis(20), 8),
            tx,
            CancellationToken::new(),
        ));

        let first_sample = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("first live sample before timeout");
        assert!(first_sample.is_some(), "a live sample must be sent");
        fail.store(true, Ordering::SeqCst);

        tokio::time::timeout(Duration::from_secs(10), handle)
            .await
            .expect("the task must resolve Offline after a never-sampling re-dial")
            .expect("the task must not panic");
        assert_eq!(
            redials.load(Ordering::SeqCst),
            1,
            "the one re-dial succeeded"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            CollectLoopState::new().pre_live_failure_limit() as usize,
            "the re-dialled collector gets the generous pre-Live bound"
        );
        // The desktop hears the terminal Offline instead of staying Stale (#3321).
        let tail = statuses(&drain(&mut rx));
        assert_eq!(
            tail.last(),
            Some(&status(
                MonitorStatus::Offline,
                Some(MonitorStatusReason::Transport)
            ))
        );
    }

    // ── connection.monitoring.status notification (#3321) ──────────────

    /// The first sample is preceded by a `Live` status, so the desktop has
    /// applied `Live` by the time it sees the data.
    #[tokio::test]
    async fn monitoring_task_reports_live_before_the_first_sample() {
        let first = Box::new(FakeCollector {
            fail: Arc::new(AtomicBool::new(false)),
        }) as Box<dyn StatsCollector>;
        let factory: CollectorFactory = Arc::new(|| Err(anyhow::anyhow!("unused")));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(monitoring_task(
            "fake".into(),
            first,
            factory,
            Duration::from_millis(20),
            BackoffSchedule::default(),
            tx,
            cancel.clone(),
        ));

        let mut seen = Vec::new();
        while seen.len() < 3 {
            let n = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .expect("notification before timeout")
                .expect("channel open");
            seen.push(n);
        }
        cancel.cancel();
        let _ = handle.await;

        assert_eq!(seen[0].method, CONNECTION_MONITORING_STATUS);
        assert_eq!(
            statuses(&seen[..1]),
            vec![status(MonitorStatus::Live, None)]
        );
        assert_eq!(seen[1].method, CONNECTION_MONITORING_DATA);
        assert_eq!(
            statuses(&seen),
            vec![status(MonitorStatus::Live, None)],
            "a steady Live loop reports its status once, not every tick"
        );
    }

    /// A drop that recovers reports every transition: Live → Stale →
    /// Reconnecting → Live.
    #[tokio::test]
    async fn monitoring_task_reports_each_transition_through_a_recovery() {
        let fail = Arc::new(AtomicBool::new(false));
        let factory: CollectorFactory = Arc::new(|| {
            Ok(Box::new(FakeCollector {
                fail: Arc::new(AtomicBool::new(false)),
            }) as Box<dyn StatsCollector>)
        });
        let first = Box::new(FakeCollector { fail: fail.clone() }) as Box<dyn StatsCollector>;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(monitoring_task(
            "fake".into(),
            first,
            factory,
            Duration::from_millis(20),
            BackoffSchedule::new(Duration::from_millis(5), Duration::from_millis(20), 8),
            tx,
            cancel.clone(),
        ));

        let mut reported = Vec::new();
        let mut dropped = false;
        while reported.len() < 4 {
            let n = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .expect("notification before timeout")
                .expect("channel open");
            if n.method == CONNECTION_MONITORING_DATA && !dropped {
                // First sample seen: drop the stream.
                fail.store(true, Ordering::SeqCst);
                dropped = true;
            }
            reported.extend(statuses(std::slice::from_ref(&n)));
        }
        cancel.cancel();
        let _ = handle.await;

        assert_eq!(
            reported,
            vec![
                status(MonitorStatus::Live, None),
                status(MonitorStatus::Stale, Some(MonitorStatusReason::Transport)),
                status(
                    MonitorStatus::Reconnecting,
                    Some(MonitorStatusReason::Transport)
                ),
                status(MonitorStatus::Live, None),
            ]
        );
    }
}
