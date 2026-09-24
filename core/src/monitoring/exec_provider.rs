//! Exec-based monitoring provider implementing [`MonitoringProvider`]
//! (PROD-0022, #3182).
//!
//! Docker containers and WSL distributions are Linux with `/proc`, so their
//! monitoring reuses the exact same [`MONITORING_COMMAND`] and
//! [`parse_stats`](crate::monitoring::parse_stats) as the SSH backend — the only
//! difference is *how* the command is run: `docker exec` / `wsl.exe -d <distro>`
//! instead of an SSH exec channel. This module captures that shared machinery so
//! neither backend re-implements the collect loop, the CPU/network delta
//! trackers, or the parser.
//!
//! A backend supplies a [`ProcStatsSource`] — one async method that runs the
//! monitoring command in the target and returns its raw stdout. The provider
//! drives that source on a periodic loop, feeds each sample through the canonical
//! parser, applies the per-core + aggregate CPU and network delta trackers, and
//! mirrors the SSH provider's observable lifecycle
//! ([`Connecting`](crate::monitoring::MonitorStatus::Connecting) →
//! [`Live`](crate::monitoring::MonitorStatus::Live) →
//! [`Stale`](crate::monitoring::MonitorStatus::Stale) → reconnect →
//! [`Offline`](crate::monitoring::MonitorStatus::Offline)) so the whole
//! projection/UI stack renders container/distro stats unchanged.
//!
//! Each collect is an independent exec — there is no persistent session to
//! re-dial — so a sustained drop is recovered by re-probing the source under a
//! bounded backoff and, on the first success, dropping the stale CPU/network
//! baselines so the next sample re-primes (first sample reports CPU 0, exactly
//! like SSH). A source whose target has no readable `/proc` (distroless /
//! BusyBox-only containers) yields collect/parse failures that surface honestly
//! as `Stale` → `Offline` — never a crash and never fabricated stats. A
//! `docker stats` fallback for such containers is deliberately out of scope here
//! (tracked as a follow-up).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;
use tracing::debug;

use crate::errors::CoreError;
use crate::monitoring::{
    parse_stats, BackoffSchedule, CollectLoopState, CpuDeltaTracker, MonitorStatus,
    MonitorStatusSender, MonitoringProvider, MonitoringReceiver, MonitoringSender,
    MonitoringSubscription, NetDeltaTracker, PerCoreCpuTracker, SystemStats, BACKOFF_CAP,
    DEFAULT_BACKOFF_BASE, DEFAULT_MAX_RECONNECT_ATTEMPTS, DEFAULT_MONITORING_INTERVAL_MS,
    DEFAULT_STALE_THRESHOLD,
};

/// Default polling interval for collecting stats.
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
///
/// Bounds the exec against an unresponsive container/distro so the collect loop
/// cannot hang indefinitely (mirrors the SSH collect timeout, #1228 gap G3).
const COLLECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Async source of raw monitoring output for an exec-based backend.
///
/// Implementations run [`MONITORING_COMMAND`](crate::monitoring::MONITORING_COMMAND)
/// inside the target (a Docker container via `docker exec`, a WSL distribution
/// via `wsl.exe -d <distro>`) and return its raw stdout. Like the SSH exec, the
/// process exit status is intentionally *not* consulted: the parser tolerates a
/// partial trailing leg (e.g. a missing `/proc/net/dev`), so returning whatever
/// stdout was produced yields more metrics than failing the whole collect on a
/// non-zero exit.
#[async_trait::async_trait]
pub trait ProcStatsSource: Send + Sync + 'static {
    /// Run the monitoring command in the target and return its raw stdout.
    ///
    /// An `Err` (transport/exec failure) is counted as "no fresh sample this
    /// tick"; so is stdout the parser rejects (a target with no readable
    /// `/proc`). Neither panics nor fabricates data.
    async fn collect_proc(&self) -> Result<String, CoreError>;
}

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

/// Per-sample delta trackers, bundled so a reconnect can reset the CPU/network
/// baselines together (the next sample then re-primes to CPU 0).
struct Trackers {
    cpu: CpuDeltaTracker,
    per_core: PerCoreCpuTracker,
    net: NetDeltaTracker,
}

impl Trackers {
    fn new() -> Self {
        Self {
            cpu: CpuDeltaTracker::new(),
            per_core: PerCoreCpuTracker::new(),
            net: NetDeltaTracker::new(),
        }
    }
}

/// Exec-based monitoring provider backed by a [`ProcStatsSource`].
///
/// [`subscribe`](MonitoringProvider::subscribe) spawns a background task that
/// periodically runs the source, parses the output, applies the delta trackers,
/// and sends stats plus status transitions through the subscription's channels.
/// Unlike SSH there is no up-front connect to fail — constructing the source is
/// pure — so a target that cannot be monitored surfaces through the loop's
/// `Stale`/`Offline` lifecycle rather than a `subscribe` error.
pub struct ExecMonitoringProvider {
    source: Arc<dyn ProcStatsSource>,
    /// Initial poll interval; live-updatable per subscription via `set_interval`.
    interval: Duration,
    /// Consecutive collect failures tolerated before the loop reports `Stale`.
    stale_threshold: u32,
    /// Backoff schedule template for the bounded recovery campaign.
    reconnect_backoff: BackoffSchedule,
    task: Arc<Mutex<Option<MonitoringTask>>>,
}

impl ExecMonitoringProvider {
    /// Construct a provider that monitors the target described by `source`.
    pub fn new(source: Arc<dyn ProcStatsSource>) -> Self {
        Self {
            source,
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

/// Run one collect bounded by `timeout`, parse it, and fold in the delta
/// trackers.
///
/// Returns the fresh sample, or `None` when the exec errored, timed out, or its
/// output could not be parsed (a target with no readable `/proc`) — all counted
/// as "no fresh sample this tick". Never panics, never fabricates data.
async fn collect_once(
    source: &dyn ProcStatsSource,
    timeout: Duration,
    trackers: &mut Trackers,
) -> Option<SystemStats> {
    let output = match tokio::time::timeout(timeout, source.collect_proc()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            debug!("Exec monitoring collect failed: {e}");
            return None;
        }
        Err(_elapsed) => {
            debug!("Exec monitoring collect timed out after {timeout:?}");
            return None;
        }
    };

    match parse_stats(&output) {
        Ok((mut stats, cpu_counters, per_core_counters, net_counters)) => {
            if let Some(pct) = trackers.cpu.update(cpu_counters) {
                stats.cpu_usage_percent = pct;
            }
            stats.per_core_cpu_percent = trackers.per_core.update(&per_core_counters);
            let (rx, tx) = trackers.net.update(net_counters, Instant::now());
            stats.net_rx_bytes_per_sec = rx;
            stats.net_tx_bytes_per_sec = tx;
            Some(stats)
        }
        Err(e) => {
            debug!("Failed to parse exec monitoring output: {e}");
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

/// Re-probe the source under a bounded exponential backoff once the loop has
/// gone `Stale`.
///
/// Emits `Reconnecting`, then for each attempt sleeps the next backoff delay and
/// runs one collect. Returns `true` on the first attempt whose output parses (the
/// caller then resets the trackers so the next sample re-primes and emits
/// `Live`), or `false` when the budget is exhausted or the loop is asked to stop
/// mid-backoff (the caller then emits `Offline`).
async fn reconnect_with_backoff(
    source: &dyn ProcStatsSource,
    mut backoff: BackoffSchedule,
    collect_timeout: Duration,
    loop_state: &mut CollectLoopState,
    status_tx: &MonitorStatusSender,
    alive: &AtomicBool,
    cancel: &CancellationToken,
) -> bool {
    if let Some(status) = loop_state.begin_reconnect() {
        emit_status(status_tx, status).await;
    }

    while let Some(delay) = backoff.next_delay() {
        if !interruptible_sleep(delay, alive, cancel).await {
            return false;
        }
        // A probe collect that parses proves the target is reachable again. The
        // sample itself is discarded — the caller resets the trackers, so the
        // next loop collect re-primes (first sample = CPU 0), matching SSH.
        match tokio::time::timeout(collect_timeout, source.collect_proc()).await {
            Ok(Ok(output)) if parse_stats(&output).is_ok() => {
                debug!("Exec monitoring source reachable again");
                return true;
            }
            Ok(Ok(_)) => debug!("Exec monitoring reconnect probe produced unparseable output"),
            Ok(Err(e)) => debug!("Exec monitoring reconnect probe failed: {e}"),
            Err(_elapsed) => debug!("Exec monitoring reconnect probe timed out"),
        }
    }

    false
}

/// The periodic collect loop: collects a sample, folds success/failure into the
/// [`CollectLoopState`], re-probes the source under backoff on a sustained drop,
/// and honors the live pause / interval / cancel controls.
#[allow(clippy::too_many_arguments)]
async fn run_collect_loop(
    source: Arc<dyn ProcStatsSource>,
    controls: Arc<LoopControls>,
    collect_timeout: Duration,
    stale_threshold: u32,
    reconnect_backoff: BackoffSchedule,
    tx: MonitoringSender,
    status_tx: MonitorStatusSender,
    alive: Arc<AtomicBool>,
    cancel: CancellationToken,
) {
    let mut trackers = Trackers::new();
    let mut loop_state = CollectLoopState::with_threshold(stale_threshold);

    while alive.load(Ordering::SeqCst) {
        // Paused: keep the loop alive but skip collection.
        if controls.is_paused() {
            if let Some(status) = loop_state.pause() {
                emit_status(&status_tx, status).await;
            }
            interruptible_sleep(PAUSE_POLL_INTERVAL, &alive, &cancel).await;
            continue;
        }
        if let Some(status) = loop_state.resume() {
            emit_status(&status_tx, status).await;
            // Drop the stale CPU/network baselines so the first post-resume
            // sample does not report a spurious rate from the paused gap.
            trackers = Trackers::new();
        }

        let collected = match collect_once(&*source, collect_timeout, &mut trackers).await {
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

        // A sustained drop triggers a bounded recovery campaign that re-probes
        // the source in place.
        if loop_state.should_begin_reconnect() {
            let recovered = reconnect_with_backoff(
                &*source,
                reconnect_backoff.clone(),
                collect_timeout,
                &mut loop_state,
                &status_tx,
                &alive,
                &cancel,
            )
            .await;
            if recovered {
                // Fresh baseline: the next collect emits `Live` on success.
                trackers = Trackers::new();
                continue;
            }
            if let Some(status) = loop_state.exhaust_reconnect() {
                emit_status(&status_tx, status).await;
            }
            break;
        }

        interruptible_sleep(controls.interval(), &alive, &cancel).await;
    }
    debug!("Exec monitoring task stopped");
}

#[async_trait::async_trait]
impl MonitoringProvider for ExecMonitoringProvider {
    async fn subscribe(&self) -> Result<MonitoringSubscription, CoreError> {
        // Stop any existing monitoring task.
        if let Ok(mut guard) = self.task.lock() {
            *guard = None;
        }

        // Probe once up front so an unmonitorable target — a distroless /
        // BusyBox-only container with no readable `/proc` — surfaces as an honest
        // `Err` (the UI shows a failed connect + retry) rather than a monitor that
        // sits forever "connecting". This mirrors the SSH provider establishing
        // its session inside `subscribe` so the real connect result reaches the
        // caller (#1228, gap G4). The probe sample is discarded: the loop's first
        // collect is the priming sample (CPU 0), preserving the SSH priming
        // contract. A `docker stats` fallback for distroless containers is out of
        // scope here (follow-up).
        match tokio::time::timeout(COLLECT_TIMEOUT, self.source.collect_proc()).await {
            Ok(Ok(output)) => {
                parse_stats(&output).map_err(|e| {
                    CoreError::Other(format!(
                        "monitoring target returned unparseable output (no readable /proc?): {e}"
                    ))
                })?;
            }
            Ok(Err(e)) => return Err(e),
            Err(_elapsed) => {
                return Err(CoreError::Other(format!(
                    "monitoring connect probe timed out after {COLLECT_TIMEOUT:?}"
                )))
            }
        }

        let cancel = CancellationToken::new();

        let (tx, rx): (MonitoringSender, MonitoringReceiver) =
            tokio::sync::mpsc::channel(MONITORING_CHANNEL_CAPACITY);
        let (status_tx, status_rx) = tokio::sync::mpsc::channel(MONITORING_STATUS_CHANNEL_CAPACITY);

        let alive = Arc::new(AtomicBool::new(true));
        let controls = Arc::new(LoopControls::new(self.interval));

        tokio::spawn(run_collect_loop(
            self.source.clone(),
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

    /// A captured `MONITORING_COMMAND` sample as a container/distro would emit it:
    /// hostname, loadavg, aggregate + per-core `/proc/stat`, `/proc/meminfo`
    /// (incl. swap), `/proc/uptime`, `df -Pk /`, `uname -sr`, and
    /// `/proc/net/dev`.
    const SAMPLE_1: &str = "\
containerhost
0.15 0.10 0.05 1/234 5678
cpu  10000 500 3000 80000 1000 0 200 0 0 0
cpu0 5000 250 1500 40000 500 0 100 0 0 0
cpu1 5000 250 1500 40000 500 0 100 0 0 0
MemTotal:       16384000 kB
MemFree:         2000000 kB
MemAvailable:   12000000 kB
Buffers:          500000 kB
Cached:          3000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
12345.67 45678.90
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        50000000  20000000  28000000      42% /
Linux 5.15.0
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  1000       10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
  eth0: 500000     1000    0    0    0     0          0         0   250000     500    0    0    0     0       0          0";

    /// A second sample two "seconds" later: every CPU counter advanced (so the
    /// aggregate + per-core deltas are non-zero) and the interface byte counters
    /// grew, so the trackers derive a sane CPU% and network rate on sample #2.
    const SAMPLE_2: &str = "\
containerhost
0.20 0.12 0.06 1/234 5678
cpu  10100 500 3050 80850 1000 0 200 0 0 0
cpu0 5050 250 1525 40425 500 0 100 0 0 0
cpu1 5050 250 1525 40425 500 0 100 0 0 0
MemTotal:       16384000 kB
MemFree:         2000000 kB
MemAvailable:   12000000 kB
Buffers:          500000 kB
Cached:          3000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
12347.67 45680.90
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        50000000  20000000  28000000      42% /
Linux 5.15.0
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  1000       10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
  eth0: 502000     1010    0    0    0     0          0         0   251000     510    0    0    0     0       0          0";

    /// A scripted source that returns queued outputs in order, then repeats the
    /// last one; an empty queue (or the `fail` flag) makes every collect error,
    /// simulating a target with no readable `/proc`.
    struct FakeSource {
        outputs: Vec<String>,
        calls: Arc<AtomicUsize>,
        fail: Arc<AtomicBool>,
    }

    impl FakeSource {
        fn with_outputs(outputs: &[&str]) -> Self {
            Self {
                outputs: outputs.iter().map(|s| s.to_string()).collect(),
                calls: Arc::new(AtomicUsize::new(0)),
                fail: Arc::new(AtomicBool::new(false)),
            }
        }

        /// A source whose every collect fails — the distroless / no-`/proc` case.
        fn always_failing() -> Self {
            Self {
                outputs: Vec::new(),
                calls: Arc::new(AtomicUsize::new(0)),
                fail: Arc::new(AtomicBool::new(true)),
            }
        }
    }

    #[async_trait::async_trait]
    impl ProcStatsSource for FakeSource {
        async fn collect_proc(&self) -> Result<String, CoreError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail.load(Ordering::SeqCst) || self.outputs.is_empty() {
                return Err(CoreError::Other("no /proc".into()));
            }
            let idx = n.min(self.outputs.len() - 1);
            Ok(self.outputs[idx].clone())
        }
    }

    /// A short-interval provider over a source scripted with `outputs`.
    fn fast_provider(outputs: &[&str]) -> ExecMonitoringProvider {
        let mut provider = ExecMonitoringProvider::new(Arc::new(FakeSource::with_outputs(outputs)));
        provider.interval = Duration::from_millis(20);
        provider
    }

    /// Wait for the next status transition, failing if none arrives in time.
    async fn next_status(rx: &mut MonitorStatusReceiver) -> MonitorStatus {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("status should arrive before timeout")
            .expect("status channel should stay open")
    }

    async fn next_sample(rx: &mut MonitoringReceiver) -> SystemStats {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("a sample must arrive before timeout")
            .expect("stats channel should stay open")
    }

    /// A captured `/proc` sample fed through the exec code path parses into a
    /// fully-populated `SystemStats`, and the first sample primes CPU to 0 (no
    /// prior delta) — exactly the SSH priming contract.
    #[tokio::test]
    async fn first_sample_parses_and_primes_cpu_to_zero() {
        let provider = fast_provider(&[SAMPLE_1]);
        let mut sub = provider.subscribe().await.expect("subscribe");

        let s = next_sample(&mut sub.stats).await;
        assert_eq!(s.hostname, "containerhost");
        assert_eq!(s.memory_total_kb, 16_384_000);
        assert_eq!(s.swap_total_kb, 2_000_000);
        assert_eq!(s.swap_used_kb, 500_000);
        assert_eq!(s.disk_total_kb, 50_000_000);
        assert_eq!(s.disk_used_percent, 42.0);
        assert_eq!(s.os_info, "Linux 5.15.0");
        assert!((s.uptime_seconds - 12_345.67).abs() < 0.01);
        // First sample: no prior snapshot, so CPU and network rates are primed 0.
        assert_eq!(s.cpu_usage_percent, 0.0);
        assert_eq!(s.per_core_cpu_percent, vec![0.0, 0.0]);
        assert_eq!(s.net_rx_bytes_per_sec, 0.0);
        assert_eq!(s.net_tx_bytes_per_sec, 0.0);

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// Two successive samples drive the delta trackers: sample #2 reports a sane
    /// aggregate + per-core CPU% and a non-zero network rate.
    #[tokio::test]
    async fn second_sample_derives_cpu_and_network_rates() {
        // Index 0 is consumed by the subscribe probe (discarded); the loop's
        // first sample is index 1 (SAMPLE_1, primed CPU 0), the second is
        // index 2 (SAMPLE_2, deltas).
        let provider = fast_provider(&[SAMPLE_1, SAMPLE_1, SAMPLE_2]);
        let mut sub = provider.subscribe().await.expect("subscribe");

        let _first = next_sample(&mut sub.stats).await;
        let second = next_sample(&mut sub.stats).await;

        // SAMPLE_1→SAMPLE_2 aggregate: total delta = 100+50+850 = 1000,
        // idle delta = 850 (idle 80000→80850, iowait unchanged), active = 150 → 15%.
        assert!(
            (second.cpu_usage_percent - 15.0).abs() < 0.5,
            "aggregate CPU% was {}",
            second.cpu_usage_percent
        );
        assert_eq!(second.per_core_cpu_percent.len(), 2);
        assert!(
            second.per_core_cpu_percent.iter().all(|p| *p > 0.0),
            "per-core CPU% must be non-zero on the second sample: {:?}",
            second.per_core_cpu_percent
        );
        assert!(
            second
                .per_core_cpu_percent
                .iter()
                .all(|p| (0.0..=100.0).contains(p)),
            "per-core CPU% out of range: {:?}",
            second.per_core_cpu_percent
        );
        // eth0 grew rx +2000 / tx +1000 over ~2s of uptime → positive rates.
        assert!(
            second.net_rx_bytes_per_sec > 0.0,
            "rx rate was {}",
            second.net_rx_bytes_per_sec
        );
        assert!(
            second.net_tx_bytes_per_sec > 0.0,
            "tx rate was {}",
            second.net_tx_bytes_per_sec
        );

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// Graceful degradation (honest connect): a target with no readable `/proc`
    /// — every collect fails — surfaces as an `Err` from `subscribe` (a failed
    /// connect the UI can retry), never a false "connected" nor fabricated data.
    #[tokio::test]
    async fn no_proc_source_subscribe_returns_err() {
        let provider = ExecMonitoringProvider::new(Arc::new(FakeSource::always_failing()));

        assert!(
            provider.subscribe().await.is_err(),
            "a target with no readable /proc must surface as Err, not a false connected state"
        );
    }

    /// Unparseable output (a BusyBox target that emits too few lines) also fails
    /// the up-front probe — surfaced as `Err`, never a panic or a bogus
    /// zero-filled sample.
    #[tokio::test]
    async fn unparseable_output_subscribe_returns_err() {
        let provider =
            ExecMonitoringProvider::new(Arc::new(FakeSource::with_outputs(&["not/proc output"])));

        assert!(
            provider.subscribe().await.is_err(),
            "unparseable probe output must surface as Err"
        );
    }

    /// Unparseable output is treated by `collect_once` as a failed collect (no
    /// sample), not a panic or a bogus zero-filled sample.
    #[tokio::test]
    async fn unparseable_output_yields_no_sample() {
        let mut trackers = Trackers::new();
        let source = FakeSource::with_outputs(&["not/proc output"]);
        let sample = collect_once(&source, COLLECT_TIMEOUT, &mut trackers).await;
        assert!(
            sample.is_none(),
            "unparseable output must not yield a sample"
        );
    }

    /// A source that goes live and then loses `/proc` mid-stream drives the
    /// observable lifecycle `Live` → `Stale` → `Reconnecting` → `Offline` when
    /// the target stays down, without ever fabricating a sample.
    #[tokio::test]
    async fn mid_stream_drop_resolves_to_offline() {
        let source = FakeSource::with_outputs(&[SAMPLE_1]);
        let fail = source.fail.clone();
        let mut provider = ExecMonitoringProvider::new(Arc::new(source));
        provider.interval = Duration::from_millis(20);
        provider.stale_threshold = 1;
        provider.reconnect_backoff =
            BackoffSchedule::new(Duration::from_millis(5), Duration::from_millis(20), 2);

        let mut sub = provider.subscribe().await.expect("subscribe");
        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Live);

        // The target loses /proc mid-stream: every subsequent collect fails.
        fail.store(true, Ordering::SeqCst);
        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Stale);
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Reconnecting
        );
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Offline,
            "a target that stays down must resolve to Offline"
        );

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// A live loop pauses (stops collecting, emits `Paused`) and resumes
    /// (`Live`, collection continues).
    #[tokio::test]
    async fn set_paused_emits_paused_then_live_on_resume() {
        let provider = fast_provider(&[SAMPLE_1, SAMPLE_2]);
        let mut sub = provider.subscribe().await.expect("subscribe");

        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Live);

        provider.set_paused(true).await;
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Paused,
            "pausing a live loop must emit Paused"
        );

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
        let provider = fast_provider(&[SAMPLE_1]);
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
