//! Local-machine monitoring provider implementing [`MonitoringProvider`]
//! (PROD-0022).
//!
//! Wraps a [`LocalCollector`] and drives it on a periodic loop, mirroring the
//! SSH provider's observable lifecycle
//! ([`Connecting`](crate::monitoring::MonitorStatus::Connecting) →
//! [`Live`](crate::monitoring::MonitorStatus::Live) →
//! [`Stale`](crate::monitoring::MonitorStatus::Stale) → reconnect →
//! [`Offline`](crate::monitoring::MonitorStatus::Offline)) so the whole
//! projection/UI stack renders local stats unchanged. Because the collector is
//! synchronous and does blocking syscalls (`sysinfo` refresh, disk enumeration)
//! each collect runs on a blocking thread.
//!
//! Unlike SSH there is no transport to re-dial; a rare collect failure is
//! recovered by recreating the [`LocalCollector`] via the collector factory,
//! which resets its CPU/network delta baselines just as a fresh SSH session
//! would.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::debug;

use crate::errors::CoreError;
use crate::monitoring::{
    BackoffSchedule, CollectLoopState, MonitorStatus, MonitorStatusSender, MonitoringProvider,
    MonitoringReceiver, MonitoringSender, MonitoringSubscription, StatsCollector, SystemStats,
    BACKOFF_CAP, DEFAULT_BACKOFF_BASE, DEFAULT_MAX_RECONNECT_ATTEMPTS,
    DEFAULT_MONITORING_INTERVAL_MS, DEFAULT_STALE_THRESHOLD,
};

use super::local_collector::LocalCollector;

/// Host label attached to samples from the local machine.
const HOST_LABEL: &str = "local";

/// Default polling interval for collecting local stats.
///
/// Live-overridable per subscription via [`MonitoringProvider::set_interval`];
/// this is only the starting value.
const MONITORING_INTERVAL: Duration = Duration::from_millis(DEFAULT_MONITORING_INTERVAL_MS);

/// How often a paused loop wakes to re-check whether it should resume.
const PAUSE_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Channel capacity for monitoring stats updates.
const MONITORING_CHANNEL_CAPACITY: usize = 16;

/// Channel capacity for monitoring status updates (transitions are rare).
const MONITORING_STATUS_CHANNEL_CAPACITY: usize = 8;

/// Maximum time a single collect may take before it is treated as a failure.
const COLLECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Produces a fresh boxed collector — used for the initial open and for each
/// bounded reconnect attempt after a sustained drop.
///
/// `Arc`-shared so the spawned loop can invoke it inside `spawn_blocking`
/// without moving it out of the task.
type CollectorFactory =
    Arc<dyn Fn() -> Result<Box<dyn StatsCollector>, CoreError> + Send + Sync + 'static>;

/// Shared, live-updatable controls for a running collect loop.
///
/// The loop reads these every tick so `set_interval` / `set_paused` steer a
/// running subscription without tearing it down. `interval_ms` is atomic so
/// updates are lock-free.
struct LoopControls {
    interval_ms: AtomicU64,
    paused: AtomicBool,
}

impl LoopControls {
    fn new(interval: Duration) -> Self {
        Self {
            interval_ms: AtomicU64::new(interval.as_millis() as u64),
            paused: AtomicBool::new(false),
        }
    }

    fn interval(&self) -> Duration {
        Duration::from_millis(self.interval_ms.load(Ordering::SeqCst).max(1))
    }

    fn set_interval(&self, interval: Duration) {
        self.interval_ms
            .store(interval.as_millis().max(1) as u64, Ordering::SeqCst);
    }

    fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }
}

/// Background monitoring task state, cancelled and marked dead on drop so a
/// torn-down subscription stops promptly.
struct MonitoringTask {
    alive: Arc<AtomicBool>,
    cancel: CancellationToken,
    controls: Arc<LoopControls>,
}

impl Drop for MonitoringTask {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        self.cancel.cancel();
    }
}

/// Local-machine monitoring provider backed by a [`LocalCollector`].
///
/// [`subscribe`](MonitoringProvider::subscribe) opens the first collector up
/// front — so a (rare) open failure surfaces as `Err` rather than a false
/// "connected" state — then spawns a background task that periodically collects
/// stats and sends them plus status transitions through the subscription's
/// channels.
pub struct LocalMonitoringProvider {
    factory: CollectorFactory,
    /// Initial poll interval; live-updatable per subscription via `set_interval`.
    interval: Duration,
    /// Consecutive collect failures tolerated before the loop reports `Stale`.
    stale_threshold: u32,
    /// Backoff schedule template for the bounded recovery campaign.
    reconnect_backoff: BackoffSchedule,
    task: Arc<Mutex<Option<MonitoringTask>>>,
}

impl LocalMonitoringProvider {
    /// Construct a provider that monitors the process's own host.
    pub fn new() -> Self {
        Self::with_factory(Arc::new(|| {
            Ok(Box::new(LocalCollector::new()) as Box<dyn StatsCollector>)
        }))
    }

    /// Construct a provider over an explicit collector factory (used by tests to
    /// inject a fake collector).
    fn with_factory(factory: CollectorFactory) -> Self {
        Self {
            factory,
            interval: MONITORING_INTERVAL,
            stale_threshold: DEFAULT_STALE_THRESHOLD,
            reconnect_backoff: BackoffSchedule::new(
                DEFAULT_BACKOFF_BASE,
                BACKOFF_CAP,
                DEFAULT_MAX_RECONNECT_ATTEMPTS,
            ),
            task: Arc::new(Mutex::new(None)),
        }
    }

    /// Access the running loop's live controls, if a task is active.
    fn controls(&self) -> Option<Arc<LoopControls>> {
        self.task
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|t| t.controls.clone()))
    }
}

impl Default for LocalMonitoringProvider {
    fn default() -> Self {
        Self::new()
    }
}

/// Shared handle to the collector so a blocking collect can run off the async
/// runtime without moving the collector out of the loop.
type SharedCollector = Arc<std::sync::Mutex<Box<dyn StatsCollector>>>;

/// Open a fresh collector on a blocking thread.
///
/// Awaited synchronously inside [`subscribe`](MonitoringProvider::subscribe) so
/// the real open result reaches the caller.
async fn build_collector(factory: &CollectorFactory) -> Result<Box<dyn StatsCollector>, CoreError> {
    let factory = factory.clone();
    tokio::task::spawn_blocking(move || factory())
        .await
        .map_err(|e| CoreError::Other(format!("Failed to spawn collector task: {e}")))?
}

/// Run one collect on a blocking thread, bounded by `timeout`.
///
/// Returns the fresh sample, or `None` when the collect errored, timed out, or
/// its blocking task panicked — all counted as "no fresh sample this tick".
async fn collect_once(collector: &SharedCollector, timeout: Duration) -> Option<SystemStats> {
    let collector = collector.clone();
    let collect = tokio::task::spawn_blocking(move || {
        // A poisoned lock means a prior collect panicked; use the guard's inner
        // value rather than propagating the panic.
        let mut c = match collector.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        c.collect(HOST_LABEL)
    });

    match tokio::time::timeout(timeout, collect).await {
        Ok(Ok(Ok(stats))) => Some(stats),
        Ok(Ok(Err(e))) => {
            debug!("Local monitoring collect failed: {e}");
            None
        }
        Ok(Err(e)) => {
            debug!("Local monitoring collect task panicked: {e}");
            None
        }
        Err(_elapsed) => {
            debug!("Local monitoring collect timed out after {timeout:?}");
            None
        }
    }
}

/// Send a status transition, ignoring a closed receiver.
///
/// A dropped status receiver must not tear down the collect loop — the stats
/// channel governs the loop's lifetime.
async fn emit_status(status_tx: &MonitorStatusSender, status: MonitorStatus) {
    let _ = status_tx.send(status).await;
}

/// Sleep `delay` in small increments, returning early if the loop is asked to
/// stop (either `alive` cleared or `cancel` fired).
///
/// Returns `true` if the full delay elapsed, `false` if interrupted.
async fn interruptible_sleep(
    mut delay: Duration,
    alive: &AtomicBool,
    cancel: &CancellationToken,
) -> bool {
    let tick = Duration::from_millis(100);
    while delay > Duration::ZERO {
        if !alive.load(Ordering::SeqCst) || cancel.is_cancelled() {
            return false;
        }
        let step = tick.min(delay);
        tokio::time::sleep(step).await;
        delay = delay.saturating_sub(step);
    }
    true
}

/// Re-open the collector under a bounded exponential backoff once the loop has
/// gone `Stale`.
///
/// Emits `Reconnecting`, then for each attempt sleeps the next backoff delay and
/// re-runs the factory. Returns the fresh collector on the first success (the
/// caller resets loop state so the next collect emits `Live`), or `None` when
/// the budget is exhausted or the loop is asked to stop mid-backoff (the caller
/// then emits `Offline`).
async fn reconnect_with_backoff(
    factory: &CollectorFactory,
    mut backoff: BackoffSchedule,
    loop_state: &mut CollectLoopState,
    status_tx: &MonitorStatusSender,
    alive: &AtomicBool,
    cancel: &CancellationToken,
) -> Option<Box<dyn StatsCollector>> {
    if let Some(status) = loop_state.begin_reconnect() {
        emit_status(status_tx, status).await;
    }

    while let Some(delay) = backoff.next_delay() {
        if !interruptible_sleep(delay, alive, cancel).await {
            return None;
        }
        match build_collector(factory).await {
            Ok(collector) => {
                debug!("Local monitoring collector recreated");
                return Some(collector);
            }
            Err(e) => debug!("Local monitoring reconnect attempt failed: {e}"),
        }
    }

    None
}

/// The periodic collect loop: collects a sample, folds success/failure into the
/// [`CollectLoopState`], recreates the collector under backoff on a sustained
/// drop, and honors the live pause / interval / cancel controls.
#[allow(clippy::too_many_arguments)]
async fn run_collect_loop(
    collector: Box<dyn StatsCollector>,
    factory: CollectorFactory,
    controls: Arc<LoopControls>,
    collect_timeout: Duration,
    stale_threshold: u32,
    reconnect_backoff: BackoffSchedule,
    tx: MonitoringSender,
    status_tx: MonitorStatusSender,
    alive: Arc<AtomicBool>,
    cancel: CancellationToken,
) {
    let collector: SharedCollector = Arc::new(std::sync::Mutex::new(collector));
    let mut loop_state = CollectLoopState::with_threshold(stale_threshold);

    while alive.load(Ordering::SeqCst) {
        // Paused: keep the collector alive but skip collection.
        if controls.is_paused() {
            if let Some(status) = loop_state.pause() {
                emit_status(&status_tx, status).await;
            }
            interruptible_sleep(PAUSE_POLL_INTERVAL, &alive, &cancel).await;
            continue;
        }
        if let Some(status) = loop_state.resume() {
            emit_status(&status_tx, status).await;
        }

        let collected = match collect_once(&collector, collect_timeout).await {
            Some(stats) => {
                if tx.send(stats).await.is_err() {
                    break;
                }
                true
            }
            None => false,
        };

        let transition = if collected {
            loop_state.on_success()
        } else {
            loop_state.on_failure()
        };
        if let Some(status) = transition {
            emit_status(&status_tx, status).await;
        }

        // A sustained drop triggers a bounded recovery campaign that recreates
        // the collector in place.
        if loop_state.should_begin_reconnect() {
            match reconnect_with_backoff(
                &factory,
                reconnect_backoff.clone(),
                &mut loop_state,
                &status_tx,
                &alive,
                &cancel,
            )
            .await
            {
                Some(fresh) => {
                    *collector.lock().unwrap_or_else(|p| p.into_inner()) = fresh;
                    continue;
                }
                None => {
                    if let Some(status) = loop_state.exhaust_reconnect() {
                        emit_status(&status_tx, status).await;
                    }
                    break;
                }
            }
        }

        interruptible_sleep(controls.interval(), &alive, &cancel).await;
    }
    debug!("Local monitoring task stopped");
}

#[async_trait::async_trait]
impl MonitoringProvider for LocalMonitoringProvider {
    async fn subscribe(&self) -> Result<MonitoringSubscription, CoreError> {
        // Stop any existing monitoring task.
        if let Ok(mut guard) = self.task.lock() {
            *guard = None;
        }

        let cancel = CancellationToken::new();

        // Open the first collector up front so an open failure surfaces as `Err`
        // instead of a receiver that waits forever.
        let first = build_collector(&self.factory).await?;

        let (tx, rx): (MonitoringSender, MonitoringReceiver) =
            tokio::sync::mpsc::channel(MONITORING_CHANNEL_CAPACITY);
        let (status_tx, status_rx) = tokio::sync::mpsc::channel(MONITORING_STATUS_CHANNEL_CAPACITY);

        let alive = Arc::new(AtomicBool::new(true));
        let controls = Arc::new(LoopControls::new(self.interval));

        tokio::spawn(run_collect_loop(
            first,
            self.factory.clone(),
            controls.clone(),
            COLLECT_TIMEOUT,
            self.stale_threshold,
            self.reconnect_backoff.clone(),
            tx,
            status_tx,
            alive.clone(),
            cancel.clone(),
        ));

        if let Ok(mut guard) = self.task.lock() {
            *guard = Some(MonitoringTask {
                alive,
                cancel,
                controls,
            });
        }

        Ok(MonitoringSubscription {
            stats: rx,
            status: status_rx,
        })
    }

    async fn unsubscribe(&self) -> Result<(), CoreError> {
        if let Ok(mut guard) = self.task.lock() {
            *guard = None;
        }
        Ok(())
    }

    async fn set_interval(&self, interval: Duration) {
        if let Some(controls) = self.controls() {
            controls.set_interval(interval);
        }
    }

    async fn set_paused(&self, paused: bool) {
        if let Some(controls) = self.controls() {
            controls.set_paused(paused);
        }
    }

    async fn cancel_connect(&self) {
        if let Ok(guard) = self.task.lock() {
            if let Some(task) = guard.as_ref() {
                task.cancel.cancel();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitoring::MonitorStatusReceiver;
    use std::sync::atomic::AtomicUsize;

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
        }
    }

    /// A fake collector whose collects fail while a shared flag is set, so tests
    /// can flip it between success and failure to exercise Live↔Stale.
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

    /// A factory that always succeeds, returning collectors driven by `fail`.
    fn always_ok_factory(fail: Arc<AtomicBool>) -> CollectorFactory {
        Arc::new(move || {
            Ok(Box::new(FakeCollector { fail: fail.clone() }) as Box<dyn StatsCollector>)
        })
    }

    /// A backoff schedule with near-zero delays so recovery tests stay fast.
    fn fast_backoff(max_attempts: u32) -> BackoffSchedule {
        BackoffSchedule::new(
            Duration::from_millis(5),
            Duration::from_millis(20),
            max_attempts,
        )
    }

    /// Wait for the next status transition, failing if none arrives in time.
    async fn next_status(rx: &mut MonitorStatusReceiver) -> MonitorStatus {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("status should arrive before timeout")
            .expect("status channel should stay open")
    }

    /// A short-interval provider over an always-succeeding fake collector.
    fn fast_live_provider() -> LocalMonitoringProvider {
        let mut provider = LocalMonitoringProvider::with_factory(always_ok_factory(Arc::new(
            AtomicBool::new(false),
        )));
        provider.interval = Duration::from_millis(20);
        provider
    }

    /// The real local collector must yield at least one live sample when
    /// subscribed — the end-to-end proof the provider drives `LocalCollector`.
    #[tokio::test]
    async fn subscribe_yields_a_live_local_sample() {
        let provider = LocalMonitoringProvider::new();
        // Tight interval so the first sample arrives quickly.
        let provider = {
            let mut p = provider;
            p.interval = Duration::from_millis(20);
            p
        };

        let mut sub = provider
            .subscribe()
            .await
            .expect("subscribe should succeed");

        let sample = tokio::time::timeout(Duration::from_secs(5), sub.stats.recv())
            .await
            .expect("a sample must arrive before timeout")
            .expect("stats channel should stay open");

        assert!(!sample.hostname.is_empty(), "hostname should be populated");
        assert!(sample.memory_total_kb > 0, "memory total should be > 0");

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// An open failure surfaces as `Err` from `subscribe`, so the caller never
    /// sees a false "connected".
    #[tokio::test]
    async fn subscribe_returns_err_when_open_fails() {
        let provider = LocalMonitoringProvider::with_factory(Arc::new(|| {
            Err(CoreError::Other("collector open refused".into()))
        }));

        assert!(
            provider.subscribe().await.is_err(),
            "an open failure must surface as Err"
        );
    }

    /// A mid-stream collect drop flips the status channel to `Stale`, the loop
    /// enters `Reconnecting`, and a recreated collector flips it back to `Live`.
    #[tokio::test]
    async fn collect_loop_emits_stale_reconnecting_then_live_on_recovery() {
        let fail = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));

        // The first collector honors `fail` (so it can be dropped mid-stream);
        // every re-created collector always succeeds (the drop was transient).
        let factory: CollectorFactory = {
            let first_fail = fail.clone();
            let calls = calls.clone();
            Arc::new(move || {
                let fail = if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    first_fail.clone()
                } else {
                    Arc::new(AtomicBool::new(false))
                };
                Ok(Box::new(FakeCollector { fail }) as Box<dyn StatsCollector>)
            })
        };

        let mut provider = LocalMonitoringProvider::with_factory(factory);
        provider.interval = Duration::from_millis(20);
        provider.stale_threshold = 1;
        provider.reconnect_backoff = fast_backoff(8);

        let mut sub = provider.subscribe().await.expect("subscribe");

        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Live,
            "first successful collect must emit Live"
        );

        fail.store(true, Ordering::SeqCst);
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Stale,
            "a mid-stream collect drop must emit Stale"
        );
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Reconnecting,
            "a sustained drop must emit Reconnecting"
        );
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Live,
            "a recreated collector must recover to Live"
        );

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// When every re-open fails, the bounded backoff is exhausted and the loop
    /// resolves to `Offline`.
    #[tokio::test]
    async fn collect_loop_emits_offline_when_reconnect_exhausted() {
        let fail = Arc::new(AtomicBool::new(false));
        let first_fail = fail.clone();
        let used = Arc::new(AtomicBool::new(false));
        // The first open succeeds (honors `fail`); every re-open fails.
        let factory: CollectorFactory = Arc::new(move || {
            if used.swap(true, Ordering::SeqCst) {
                Err(CoreError::Other("reconnect refused".into()))
            } else {
                Ok(Box::new(FakeCollector {
                    fail: first_fail.clone(),
                }) as Box<dyn StatsCollector>)
            }
        });

        let mut provider = LocalMonitoringProvider::with_factory(factory);
        provider.interval = Duration::from_millis(20);
        provider.stale_threshold = 1;
        provider.reconnect_backoff = fast_backoff(3);

        let mut sub = provider.subscribe().await.expect("subscribe");
        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Live);

        fail.store(true, Ordering::SeqCst);
        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Stale);
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Reconnecting
        );
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Offline,
            "an exhausted reconnect budget must emit Offline"
        );

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// Pausing a live loop emits `Paused` and stops collecting; resuming emits
    /// `Live` and collection continues.
    #[tokio::test]
    async fn set_paused_emits_paused_then_live_on_resume() {
        let provider = fast_live_provider();
        let mut sub = provider.subscribe().await.expect("subscribe");

        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Live);

        provider.set_paused(true).await;
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Paused,
            "pausing a live loop must emit Paused"
        );

        // Drain any in-flight sample, then assert the paused loop stays quiet.
        while sub.stats.try_recv().is_ok() {}
        assert!(
            tokio::time::timeout(Duration::from_millis(200), sub.stats.recv())
                .await
                .is_err(),
            "a paused loop must not push further stats once quiescent"
        );

        provider.set_paused(false).await;
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Live,
            "resuming must emit Live"
        );

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// `cancel_connect` fires the loop's cancellation token so an in-flight
    /// collect is aborted promptly.
    #[tokio::test]
    async fn cancel_connect_fires_the_loop_token() {
        let provider = fast_live_provider();
        let sub = provider.subscribe().await.expect("subscribe");

        let token = provider
            .task
            .lock()
            .expect("task lock")
            .as_ref()
            .expect("task present")
            .cancel
            .clone();
        assert!(!token.is_cancelled());

        provider.cancel_connect().await;
        assert!(
            token.is_cancelled(),
            "cancel_connect must fire the loop cancellation token"
        );

        drop(sub);
        provider.unsubscribe().await.expect("unsubscribe");
    }
}
