//! SSH monitoring provider implementing [`MonitoringProvider`].
//!
//! Collects system statistics from a remote host by periodically executing
//! the monitoring command over an SSH exec channel and parsing the output.
//!
//! The provider establishes the SSH connection **synchronously** inside
//! [`MonitoringProvider::subscribe`] so a connect failure surfaces as an
//! `Err` to the caller instead of a false "connected" state (#1228, gap G4).
//! Each collect is bounded by a [`tokio::time::timeout`] so a stalled exec
//! becomes a collect failure rather than hanging the loop forever (#1228,
//! gap G3). The single sequential collect loop is the in-flight guard — no
//! overlapping collects.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::config::SshConfig;
use crate::errors::CoreError;
use crate::monitoring::{
    parse_stats, BackoffSchedule, CollectLoopState, CpuDeltaTracker, MonitorStatus,
    MonitorStatusSender, MonitoringProvider, MonitoringReceiver, MonitoringSender,
    MonitoringSubscription, NetDeltaTracker, PerCoreCpuTracker, BACKOFF_CAP, DEFAULT_BACKOFF_BASE,
    DEFAULT_MAX_RECONNECT_ATTEMPTS, DEFAULT_MONITORING_INTERVAL_MS, DEFAULT_STALE_THRESHOLD,
    MONITORING_COMMAND,
};

use super::handler::{ForwardedChannelRegistry, SshSession};
use super::jump_host::{connect_target, GatewayHold};

/// Default polling interval for collecting system stats.
///
/// Live-overridable per subscription via [`MonitoringProvider::set_interval`]
/// (#1233); this is only the starting value.
const MONITORING_INTERVAL: Duration = Duration::from_millis(DEFAULT_MONITORING_INTERVAL_MS);

/// How often a paused loop wakes to re-check whether it should resume (#1233).
///
/// Short enough that Resume feels immediate, long enough to keep an idle paused
/// monitor cheap.
const PAUSE_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Channel capacity for monitoring stats updates.
const MONITORING_CHANNEL_CAPACITY: usize = 16;

/// Channel capacity for monitoring status updates.
///
/// Status transitions are rare (only on Live↔Stale changes), so a small
/// buffer is ample.
const MONITORING_STATUS_CHANNEL_CAPACITY: usize = 8;

/// Maximum time a single collect may take before it is treated as a failure.
///
/// Bounds the exec against a half-dropped TCP peer or an unresponsive remote
/// so the collect loop cannot hang indefinitely (#1228, gap G3).
const COLLECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Abstraction over the SSH connect + collect steps used by the monitoring
/// provider.
///
/// Extracting these two operations behind a trait lets the honest-connect and
/// collect-timeout behaviour be exercised with a fake transport in unit tests,
/// without a real SSH server.
#[async_trait::async_trait]
pub(crate) trait MonitoringTransport: Send + Sync + 'static {
    /// Established session handle carried into the collect loop.
    type Session: Send + Sync + 'static;

    /// Establish the monitoring session, honoring `cancel`.
    ///
    /// Awaited synchronously inside [`MonitoringProvider::subscribe`] so the
    /// real connect result reaches the caller (#1228, gap G4).
    async fn connect(&self, cancel: CancellationToken) -> Result<Self::Session, CoreError>;

    /// Run one collection over an established session, returning raw stdout.
    async fn collect(&self, session: &Self::Session) -> Result<String, CoreError>;
}

/// Real SSH transport: connects via [`connect_target`] and collects via
/// [`ssh_exec`].
pub(crate) struct SshTransport {
    config: SshConfig,
}

/// A connected SSH monitoring session and the resources that must outlive it.
///
/// The pooled `_gateway` hold and forwarded-channel `_registry` are kept alive
/// for the session's lifetime so a jump-host chain (#939) stays open while the
/// collect loop runs.
pub(crate) struct SshConnectedSession {
    session: SshSession,
    _registry: ForwardedChannelRegistry,
    _gateway: Option<GatewayHold>,
}

#[async_trait::async_trait]
impl MonitoringTransport for SshTransport {
    type Session = SshConnectedSession;

    async fn connect(&self, cancel: CancellationToken) -> Result<Self::Session, CoreError> {
        // Reach the target directly, or through its pooled jump-host gateway
        // when a ProxyJump chain is configured (#939).
        let (session, registry, gateway) = connect_target(&self.config, Some(&cancel)).await?;
        Ok(SshConnectedSession {
            session,
            _registry: registry,
            _gateway: gateway,
        })
    }

    async fn collect(&self, session: &Self::Session) -> Result<String, CoreError> {
        ssh_exec(&session.session, MONITORING_COMMAND).await
    }
}

/// Shared, live-updatable controls for a running collect loop (#1233).
///
/// The loop reads these every tick, so the provider's `set_interval` /
/// `set_paused` methods can steer a running subscription without tearing it
/// down. `interval_ms` is stored as an atomic so updates are lock-free.
struct LoopControls {
    /// Poll interval in milliseconds, read afresh before each wait.
    interval_ms: AtomicU64,
    /// When set, the loop skips collection but keeps the transport open.
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

/// Background monitoring task state.
struct MonitoringTask {
    alive: Arc<AtomicBool>,
    /// Cancels an in-flight connect / collect (Cancel control, #1233).
    /// Cancelled on drop so a torn-down subscription aborts any pending SSH
    /// handshake promptly.
    cancel: CancellationToken,
    /// Live interval / pause controls read by the running loop (#1233).
    controls: Arc<LoopControls>,
}

impl Drop for MonitoringTask {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        self.cancel.cancel();
    }
}

/// SSH-based monitoring provider, generic over its [`MonitoringTransport`].
///
/// [`subscribe`](MonitoringProvider::subscribe) establishes the connection up
/// front and, on success, spawns a background tokio task that periodically
/// collects the monitoring command output, parses it, and sends stats through
/// a channel.
pub(crate) struct SshMonitoringProviderImpl<T: MonitoringTransport> {
    transport: Arc<T>,
    collect_timeout: Duration,
    /// Initial poll interval; live-updatable per subscription via `set_interval`.
    interval: Duration,
    /// Consecutive collect failures tolerated before the loop reports `Stale`.
    stale_threshold: u32,
    /// Backoff schedule template for the bounded reconnect campaign (#1230, G2).
    reconnect_backoff: BackoffSchedule,
    task: Arc<Mutex<Option<MonitoringTask>>>,
}

/// SSH monitoring provider backed by the real [`SshTransport`].
pub(crate) type SshMonitoringProvider = SshMonitoringProviderImpl<SshTransport>;

impl<T: MonitoringTransport> SshMonitoringProviderImpl<T> {
    /// Construct a provider over an explicit transport and collect timeout.
    fn with_transport(transport: T, collect_timeout: Duration) -> Self {
        Self {
            transport: Arc::new(transport),
            collect_timeout,
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

impl SshMonitoringProviderImpl<SshTransport> {
    /// Construct a provider that monitors the host described by `config`.
    pub(crate) fn new(config: SshConfig) -> Self {
        Self::with_transport(SshTransport { config }, COLLECT_TIMEOUT)
    }
}

/// Execute a command over an SSH session and return stdout as a string.
///
/// Thin wrapper over [`ssh_exec_with_stdin`](super::exec::ssh_exec_with_stdin)
/// that runs with no stdin and keeps only stdout — the monitoring loop parses
/// stdout and does not need the captured stderr or exit status.
async fn ssh_exec(session: &SshSession, command: &str) -> Result<String, CoreError> {
    let output = super::exec::ssh_exec_with_stdin(session, command, "").await?;
    Ok(output.stdout)
}

/// Run a single collect bounded by `timeout`.
///
/// A stalled exec (half-dropped TCP, unresponsive remote) elapses and is
/// mapped to a collect failure instead of hanging the loop forever (#1228,
/// gap G3).
async fn collect_once<T: MonitoringTransport>(
    transport: &T,
    session: &T::Session,
    timeout: Duration,
) -> Result<String, CoreError> {
    match tokio::time::timeout(timeout, transport.collect(session)).await {
        Ok(result) => result,
        Err(_elapsed) => Err(CoreError::Other(format!(
            "Monitoring collect timed out after {timeout:?}"
        ))),
    }
}

/// Send a status transition, ignoring a closed receiver.
///
/// A dropped status receiver (frontend stopped listening) must not tear down
/// the collect loop — the stats channel governs the loop's lifetime.
async fn emit_status(status_tx: &MonitorStatusSender, status: MonitorStatus) {
    let _ = status_tx.send(status).await;
}

/// Sleep `delay` in small increments, returning early if the loop is asked to
/// stop (either `alive` cleared or `cancel` fired).
///
/// Returns `true` if the full delay elapsed, `false` if interrupted — mirrors
/// the incremental sleep the collect loop uses between ticks so a torn-down
/// subscription aborts a long backoff promptly.
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

/// What one collect tick produced, folded into the [`CollectLoopState`].
enum TickOutcome {
    /// A parsed sample was pushed.
    Sample,
    /// The collect errored or timed out (transport-level failure).
    Failed,
    /// The transport answered, but `parse_stats` rejected the output (#3252).
    Unparseable,
}

/// Re-dial the transport under a bounded exponential backoff (#1230, gap G2).
///
/// Called once the collect loop has gone `Stale`. Emits `Reconnecting`, then
/// for each attempt sleeps the next backoff delay and re-runs
/// [`MonitoringTransport::connect`]. On the first successful re-dial it returns
/// the fresh session (the caller resets loop state so the next collect emits
/// `Live`). When the [`BackoffSchedule`] budget is exhausted — or the loop is
/// asked to stop mid-backoff — it returns `None`; the caller then emits
/// `Offline`.
async fn reconnect_with_backoff<T: MonitoringTransport>(
    transport: &T,
    mut backoff: BackoffSchedule,
    loop_state: &mut CollectLoopState,
    status_tx: &MonitorStatusSender,
    alive: &AtomicBool,
    cancel: &CancellationToken,
) -> Option<T::Session> {
    if let Some(status) = loop_state.begin_reconnect() {
        emit_status(status_tx, status).await;
    }

    while let Some(delay) = backoff.next_delay() {
        if !interruptible_sleep(delay, alive, cancel).await {
            return None;
        }
        match transport.connect(cancel.clone()).await {
            Ok(session) => {
                debug!("Monitoring transport reconnected");
                return Some(session);
            }
            Err(e) => debug!("Monitoring reconnect attempt failed: {e}"),
        }
    }

    None
}

#[async_trait::async_trait]
impl<T: MonitoringTransport> MonitoringProvider for SshMonitoringProviderImpl<T> {
    async fn subscribe(&self) -> Result<MonitoringSubscription, CoreError> {
        // Stop any existing monitoring task.
        if let Ok(mut guard) = self.task.lock() {
            *guard = None;
        }

        let cancel = CancellationToken::new();

        // Establish the connection *before* returning so the caller sees the
        // real connect result. A failure propagates as `Err` — no false
        // "connected" and no receiver that waits forever (#1228, gap G4).
        let session = self.transport.connect(cancel.clone()).await?;

        let (tx, rx): (MonitoringSender, MonitoringReceiver) =
            tokio::sync::mpsc::channel(MONITORING_CHANNEL_CAPACITY);
        let (status_tx, status_rx) = tokio::sync::mpsc::channel(MONITORING_STATUS_CHANNEL_CAPACITY);

        let alive = Arc::new(AtomicBool::new(true));
        let alive_clone = alive.clone();
        let transport = self.transport.clone();
        let collect_timeout = self.collect_timeout;
        let stale_threshold = self.stale_threshold;
        let reconnect_backoff = self.reconnect_backoff.clone();
        let loop_cancel = cancel.clone();
        let controls = Arc::new(LoopControls::new(self.interval));
        let loop_controls = controls.clone();

        // The loop owns the session and re-dials it in place. It tracks its own
        // status via `CollectLoopState`: the first successful collect emits
        // `Live`; `stale_threshold` consecutive failures emit `Stale` (#1229,
        // gap G1); once `Stale`, a bounded exponential backoff re-runs
        // `connect`, emitting `Reconnecting` then `Live` (recovered) or
        // `Offline` (exhausted) (#1230, gap G2).
        tokio::spawn(async move {
            let mut session = session;
            let mut cpu_tracker = CpuDeltaTracker::new();
            let mut per_core_tracker = PerCoreCpuTracker::new();
            let mut net_tracker = NetDeltaTracker::new();
            let mut loop_state = CollectLoopState::with_threshold(stale_threshold);

            while alive_clone.load(Ordering::SeqCst) {
                // Paused: keep the transport open but skip collection. Emit
                // `Paused` on the transition, then idle until resumed (#1233).
                if loop_controls.is_paused() {
                    if let Some(status) = loop_state.pause() {
                        emit_status(&status_tx, status).await;
                    }
                    interruptible_sleep(PAUSE_POLL_INTERVAL, &alive_clone, &loop_cancel).await;
                    continue;
                }
                // Just resumed after a pause: announce the transition so the UI
                // un-dims and the next collect keeps the loop `Live`.
                if let Some(status) = loop_state.resume() {
                    emit_status(&status_tx, status).await;
                    // Drop the stale CPU/network baselines so the first
                    // post-resume sample does not report a spurious rate from
                    // the paused gap.
                    cpu_tracker = CpuDeltaTracker::new();
                    per_core_tracker = PerCoreCpuTracker::new();
                    net_tracker = NetDeltaTracker::new();
                }

                // A collect error or a stat send failure means "no fresh sample
                // this tick" → a failure. A parse error is tracked separately:
                // the transport answered, but with unusable data, so before
                // `Live` a sustained run resolves to `Offline` instead of
                // hanging in `Connecting` (#3252).
                let outcome = match collect_once(&*transport, &session, collect_timeout).await {
                    Ok(output) => match parse_stats(&output) {
                        Ok((mut stats, counters, per_core_counters, net_counters)) => {
                            if let Some(pct) = cpu_tracker.update(counters) {
                                stats.cpu_usage_percent = pct;
                            }
                            stats.per_core_cpu_percent =
                                per_core_tracker.update(&per_core_counters);
                            let (rx, tx_rate) = net_tracker.update(net_counters, Instant::now());
                            stats.net_rx_bytes_per_sec = rx;
                            stats.net_tx_bytes_per_sec = tx_rate;
                            if tx.send(stats).await.is_err() {
                                break;
                            }
                            TickOutcome::Sample
                        }
                        Err(e) => {
                            warn!("Failed to parse monitoring output: {e}");
                            TickOutcome::Unparseable
                        }
                    },
                    Err(e) => {
                        debug!("Monitoring collect failed: {e}");
                        TickOutcome::Failed
                    }
                };

                let transition = match outcome {
                    TickOutcome::Sample => loop_state.on_success(),
                    TickOutcome::Failed => loop_state.on_failure(),
                    TickOutcome::Unparseable => loop_state.on_parse_failure(),
                };
                if let Some(status) = transition {
                    emit_status(&status_tx, status).await;
                }

                // Connected but never parseable: `Offline` is terminal — end the
                // loop (closing the stats channel) exactly like an exhausted
                // reconnect budget (#3252).
                if loop_state.is_offline() {
                    break;
                }

                // A sustained drop (now `Stale`) triggers a bounded reconnect
                // campaign that re-dials the transport in place (#1230, G2).
                if loop_state.should_begin_reconnect() {
                    match reconnect_with_backoff(
                        &*transport,
                        reconnect_backoff.clone(),
                        &mut loop_state,
                        &status_tx,
                        &alive_clone,
                        &loop_cancel,
                    )
                    .await
                    {
                        Some(new_session) => {
                            // Fresh transport: drop the stale CPU baseline and
                            // let the next collect emit `Live` on success.
                            session = new_session;
                            cpu_tracker = CpuDeltaTracker::new();
                            per_core_tracker = PerCoreCpuTracker::new();
                            continue;
                        }
                        None => {
                            // Budget exhausted (or told to stop): resolve to
                            // Offline and end the loop — monitoring is dead
                            // until manually re-picked.
                            if let Some(status) = loop_state.exhaust_reconnect() {
                                emit_status(&status_tx, status).await;
                            }
                            break;
                        }
                    }
                }

                // Wait the (live-updatable) poll interval in small increments so
                // a torn-down subscription, a cancel, or an interval change take
                // effect promptly (#1233).
                interruptible_sleep(loop_controls.interval(), &alive_clone, &loop_cancel).await;
            }
            debug!("Monitoring task stopped");
        });

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

    /// A valid `MONITORING_COMMAND` output that `parse_stats` accepts, so the
    /// collect loop can produce a real `Live` sample in tests. Matches the
    /// plain-line layout the parser expects (hostname, loadavg, cpu, meminfo,
    /// uptime, df, uname).
    const SAMPLE_STATS: &str = "\
testhost
0.15 0.10 0.05 1/234 5678
cpu  10000 500 3000 80000 1000 0 200 0 0 0
MemTotal:       16384000 kB
MemAvailable:   12000000 kB
12345.67 45678.90
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        50000000  20000000  28000000      42% /
Linux 5.15.0";

    // ── Degraded / malformed collect payloads (MOCK-009) ───────────────────
    //
    // These model the fault modes a real remote produces that the earlier fakes
    // never covered: an exec cut short, garbage interleaved with valid lines, a
    // missing `/proc` section, a truncated network block, and a foreign-distro
    // (BusyBox/musl) shape. Each is fed through the real `collect_once` +
    // `parse_stats` collect-loop path so the parser's degraded/error branches are
    // exercised end-to-end rather than asserted against a mock parser.

    /// The exec was killed after only two-and-a-bit lines, leaving fewer than
    /// the six lines `parse_stats` requires. The parser rejects it with a typed
    /// error (its documented contract for a too-short sample).
    const TRUNCATED_STATS: &str = "\
testhost
0.15 0.10 0.05 1/234 5678
cpu  10000 500 3000";

    /// Garbage / non-numeric lines interleaved with the expected line layout.
    /// The output still has ≥6 lines, so `parse_stats` returns *partial* stats
    /// (every unparseable numeric field defaults to 0) rather than erroring — a
    /// graceful degrade, not a crash and not a false-precise reading.
    const GARBAGE_LINES_STATS: &str = "\
weird-host
not a loadavg at all
cpu  garbage tokens here nope
MemTotal:       not-a-number kB
??? definitely not meminfo ???
also not an uptime line";

    /// A host that answered loadavg + cpu but whose `/proc/meminfo` leg produced
    /// nothing (stripped `/proc`, permission error swallowed upstream, …). The
    /// remaining sections still parse; the memory metrics default to zero.
    const MISSING_MEMINFO_STATS: &str = "\
nomeminfo
0.42 0.30 0.20 1/100 4242
cpu  20000 0 5000 100000 0 0 0 0 0 0
9999.50 12345.00
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        10000000   4000000   6000000      40% /
Linux 6.1.0";

    /// The trailing `/proc/net/dev` block is truncated mid-row: the interface
    /// line carries far fewer than the 16 numeric columns the parser needs, so
    /// the network leg degrades to 0 while every earlier metric survives (the
    /// documented "a failure there only drops the network leg" contract).
    const TRUNCATED_NETDEV_STATS: &str = "\
nettrunc
0.15 0.10 0.05 1/234 5678
cpu  10000 500 3000 80000 1000 0 200 0 0 0
MemTotal:       16384000 kB
MemAvailable:   12000000 kB
12345.67 45678.90
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        50000000  20000000  28000000      42% /
Linux 5.15.0
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs
  eth0:  5000000   45678    0    0";

    /// A BusyBox/musl (e.g. Alpine) shaped sample: `/proc/meminfo` omits
    /// `MemAvailable` (so the classic MemFree+Buffers+Cached+SReclaimable
    /// fallback must kick in), no swap lines, a BusyBox `df` header, and an
    /// Alpine-flavoured `uname`. The parser must still yield sensible values.
    const BUSYBOX_STATS: &str = "\
alpine-box
0.05 0.02 0.00 1/40 512
cpu  1000 0 300 9000 100 0 0 0 0 0
MemTotal:        512000 kB
MemFree:         100000 kB
Buffers:          20000 kB
Cached:           80000 kB
900.10 1800.20
Filesystem           1K-blocks      Used Available Use% Mounted on
/dev/sda1              2000000    800000   1200000  40% /
Linux 5.15.0-0-virt
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:    5000      50    0    0    0     0          0         0     5000      50    0    0    0     0       0          0
  eth0:  300000    2000    0    0    0     0          0         0   150000    1000    0    0    0     0       0          0";

    /// Fake transport with scripted connect / collect behaviour for tests.
    ///
    /// `collect_should_fail` lets a test flip collects between success and
    /// failure at runtime to exercise the Live↔Stale status transitions.
    /// `connect_should_fail` does the same for re-dials, so a test can hold a
    /// reconnect campaign in `Reconnecting` (and drive it to `Offline`) or let
    /// it recover to `Live` (#1230, gap G2).
    struct FakeTransport {
        connect_ok: bool,
        collect_delay: Duration,
        collect_calls: Arc<AtomicUsize>,
        connect_calls: Arc<AtomicUsize>,
        collect_should_fail: Arc<AtomicBool>,
        connect_should_fail: Arc<AtomicBool>,
        collect_output: String,
    }

    impl FakeTransport {
        fn new(connect_ok: bool, collect_delay: Duration) -> Self {
            Self {
                connect_ok,
                collect_delay,
                collect_calls: Arc::new(AtomicUsize::new(0)),
                connect_calls: Arc::new(AtomicUsize::new(0)),
                collect_should_fail: Arc::new(AtomicBool::new(false)),
                connect_should_fail: Arc::new(AtomicBool::new(false)),
                collect_output: "collected".to_string(),
            }
        }

        /// A transport whose every `collect` returns a fixed, caller-supplied
        /// payload — the hook for driving degraded / malformed parser inputs
        /// through the real `collect_once` + `parse_stats` path (MOCK-009).
        ///
        /// Connect always succeeds and collects never delay, so the only
        /// variable under test is the shape of the collected output.
        fn with_output(output: impl Into<String>) -> Self {
            Self {
                connect_ok: true,
                collect_delay: Duration::ZERO,
                collect_calls: Arc::new(AtomicUsize::new(0)),
                connect_calls: Arc::new(AtomicUsize::new(0)),
                collect_should_fail: Arc::new(AtomicBool::new(false)),
                connect_should_fail: Arc::new(AtomicBool::new(false)),
                collect_output: output.into(),
            }
        }

        /// A transport wired for reconnect tests: collects fail/succeed via the
        /// first flag, re-dials fail/succeed via the second.
        fn with_collect_and_connect_flags() -> (Self, Arc<AtomicBool>, Arc<AtomicBool>) {
            let collect_fail = Arc::new(AtomicBool::new(false));
            let connect_fail = Arc::new(AtomicBool::new(false));
            let transport = Self {
                connect_ok: true,
                collect_delay: Duration::ZERO,
                collect_calls: Arc::new(AtomicUsize::new(0)),
                connect_calls: Arc::new(AtomicUsize::new(0)),
                collect_should_fail: collect_fail.clone(),
                connect_should_fail: connect_fail.clone(),
                collect_output: SAMPLE_STATS.to_string(),
            };
            (transport, collect_fail, connect_fail)
        }
    }

    #[async_trait::async_trait]
    impl MonitoringTransport for FakeTransport {
        type Session = ();

        async fn connect(&self, _cancel: CancellationToken) -> Result<Self::Session, CoreError> {
            self.connect_calls.fetch_add(1, Ordering::SeqCst);
            if self.connect_ok && !self.connect_should_fail.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(CoreError::Other("connect refused".to_string()))
            }
        }

        async fn collect(&self, _session: &Self::Session) -> Result<String, CoreError> {
            self.collect_calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(self.collect_delay).await;
            if self.collect_should_fail.load(Ordering::SeqCst) {
                return Err(CoreError::Other("collect dropped".to_string()));
            }
            Ok(self.collect_output.clone())
        }
    }

    /// A backoff schedule with near-zero delays so reconnect tests stay fast.
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

    /// Wait for the next emitted `SystemStats` sample, failing if none arrives.
    async fn next_stats(rx: &mut MonitoringReceiver) -> crate::monitoring::SystemStats {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("stats should arrive before timeout")
            .expect("stats channel should stay open")
    }

    /// G4: a connect failure must surface as `Err` from `subscribe`, so the
    /// caller never sees a false "connected".
    #[tokio::test]
    async fn subscribe_returns_err_when_connect_fails() {
        let transport = FakeTransport::new(false, Duration::ZERO);
        let provider = SshMonitoringProviderImpl::with_transport(transport, COLLECT_TIMEOUT);

        let result = provider.subscribe().await;

        assert!(
            result.is_err(),
            "connect failure must surface as Err, not a false connected state"
        );
    }

    /// G4: a successful connect yields a live subscription.
    #[tokio::test]
    async fn subscribe_returns_ok_when_connect_succeeds() {
        let transport = FakeTransport::new(true, Duration::ZERO);
        let provider = SshMonitoringProviderImpl::with_transport(transport, COLLECT_TIMEOUT);

        let result = provider.subscribe().await;

        assert!(
            result.is_ok(),
            "successful connect must return a subscription"
        );
        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// G1/G2: a mid-stream collect drop flips the status channel to `Stale`,
    /// the loop enters `Reconnecting`, and a successful re-dial + collect flips
    /// it back to `Live` — all observed through the real collect loop.
    #[tokio::test]
    async fn collect_loop_emits_stale_reconnecting_then_live_on_recovery() {
        let (transport, collect_fail, connect_fail) =
            FakeTransport::with_collect_and_connect_flags();
        let connect_calls = transport.connect_calls.clone();
        // Threshold 1 so a single failure is enough to go Stale in the test.
        let mut provider = SshMonitoringProviderImpl::with_transport(transport, COLLECT_TIMEOUT);
        provider.stale_threshold = 1;
        provider.reconnect_backoff = fast_backoff(8);

        let mut sub = provider.subscribe().await.expect("subscribe");

        // First successful collect emits Live.
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Live,
            "first successful collect must emit Live"
        );

        // Simulate a mid-stream drop: subsequent collects fail → Stale.
        collect_fail.store(true, Ordering::SeqCst);
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Stale,
            "a mid-stream collect drop must emit Stale"
        );

        // The loop then begins a reconnect campaign → Reconnecting.
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Reconnecting,
            "a sustained drop must emit Reconnecting"
        );

        // Recovery: allow collects to succeed again; the re-dial (connect_ok)
        // succeeds and the next collect emits Live.
        let _ = connect_fail; // re-dials succeed by default here
        collect_fail.store(false, Ordering::SeqCst);
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Live,
            "a recovered re-dial + collect must emit Live again"
        );
        assert!(
            connect_calls.load(Ordering::SeqCst) >= 2,
            "the loop must have re-dialed the transport in place"
        );

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// G2: when every re-dial fails, the bounded backoff is exhausted and the
    /// loop resolves to `Offline`.
    #[tokio::test]
    async fn collect_loop_emits_offline_when_reconnect_exhausted() {
        let (transport, collect_fail, connect_fail) =
            FakeTransport::with_collect_and_connect_flags();
        let mut provider = SshMonitoringProviderImpl::with_transport(transport, COLLECT_TIMEOUT);
        provider.stale_threshold = 1;
        provider.reconnect_backoff = fast_backoff(3);

        // The initial connect succeeds; every *re-dial* fails.
        let mut sub = provider.subscribe().await.expect("subscribe");

        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Live);

        // Drop the stream: collects fail → Stale → Reconnecting.
        connect_fail.store(true, Ordering::SeqCst);
        collect_fail.store(true, Ordering::SeqCst);
        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Stale);
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Reconnecting
        );

        // All re-dials fail → backoff exhausted → Offline.
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Offline,
            "an exhausted reconnect budget must emit Offline"
        );

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// #3300: a transport that connects but whose every collect fails (timeout /
    /// exec error) before the first sample must not hang in `Connecting`: after
    /// `pre_live_failure_limit` consecutive failures the loop resolves to the
    /// terminal `Offline` and ends, without a reconnect campaign.
    #[tokio::test(start_paused = true)]
    async fn collect_loop_resolves_offline_when_no_first_sample_ever_arrives() {
        let (transport, collect_fail, _connect_fail) =
            FakeTransport::with_collect_and_connect_flags();
        collect_fail.store(true, Ordering::SeqCst);
        let collect_calls = transport.collect_calls.clone();
        let connect_calls = transport.connect_calls.clone();
        let mut provider = SshMonitoringProviderImpl::with_transport(transport, COLLECT_TIMEOUT);
        provider.interval = Duration::from_millis(20);
        provider.stale_threshold = 2;
        provider.reconnect_backoff = fast_backoff(8);
        let limit = CollectLoopState::with_threshold(2).pre_live_failure_limit();

        let mut sub = provider.subscribe().await.expect("subscribe");

        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Offline,
            "a pre-Live run of transport failures must resolve Connecting -> Offline"
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(5), sub.stats.recv())
                .await
                .expect("the collect loop must end after going Offline")
                .is_none(),
            "an Offline loop pushes no sample and closes its stats channel"
        );
        assert_eq!(
            collect_calls.load(Ordering::SeqCst),
            limit as usize,
            "exactly `pre_live_failure_limit` collects before giving up"
        );
        assert_eq!(
            connect_calls.load(Ordering::SeqCst),
            1,
            "a pre-Live Offline must not start a re-dial campaign"
        );

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// #3300: after a mid-stream drop the re-dial succeeds, but every collect
    /// on the fresh transport still fails. The loop must not sit in
    /// `Reconnecting` forever: it resolves to `Offline` in bounded time.
    #[tokio::test(start_paused = true)]
    async fn collect_loop_resolves_offline_when_re_dialled_transport_never_samples() {
        let (transport, collect_fail, _connect_fail) =
            FakeTransport::with_collect_and_connect_flags();
        let connect_calls = transport.connect_calls.clone();
        let mut provider = SshMonitoringProviderImpl::with_transport(transport, COLLECT_TIMEOUT);
        provider.interval = Duration::from_millis(20);
        provider.stale_threshold = 1;
        provider.reconnect_backoff = fast_backoff(8);

        let mut sub = provider.subscribe().await.expect("subscribe");
        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Live);

        // Collects fail from here on; re-dials keep succeeding.
        collect_fail.store(true, Ordering::SeqCst);
        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Stale);
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Reconnecting
        );
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Offline,
            "a re-dialled transport that never samples must resolve to Offline"
        );
        assert_eq!(
            connect_calls.load(Ordering::SeqCst),
            2,
            "the re-dial succeeded once; Offline came from the collect bound"
        );

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// G3: a stalled collect must time out and be reported as a failure rather
    /// than hanging forever.
    #[tokio::test]
    async fn collect_once_times_out_as_failure() {
        let transport = FakeTransport::new(true, Duration::from_secs(60));

        let result = collect_once(&transport, &(), Duration::from_millis(50)).await;

        assert!(
            result.is_err(),
            "a collect that outlasts the timeout must be a failure"
        );
    }

    /// A fast collect returns its output unchanged.
    #[tokio::test]
    async fn collect_once_returns_output_when_fast() {
        let transport = FakeTransport::new(true, Duration::ZERO);

        let result = collect_once(&transport, &(), Duration::from_secs(5)).await;

        assert_eq!(result.expect("collect should succeed"), "collected");
    }

    // ── Pause / Resume / Interval (#1233) ──────────────────────────────

    /// A short-interval provider over a always-succeeding transport, ready to
    /// exercise the live pause/resume/interval controls.
    fn fast_live_provider() -> SshMonitoringProviderImpl<FakeTransport> {
        let (transport, _collect_fail, _connect_fail) =
            FakeTransport::with_collect_and_connect_flags();
        let mut provider = SshMonitoringProviderImpl::with_transport(transport, COLLECT_TIMEOUT);
        // Tight interval so pause/interval/cancel tests observe cadence quickly.
        provider.interval = Duration::from_millis(20);
        provider
    }

    /// Pausing a live loop emits `Paused` and stops collecting; resuming emits
    /// `Live` and collection continues (#1233).
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

        // A collect already in flight when the pause flag flipped may deliver one
        // last buffered sample; drain whatever is queued, then assert the channel
        // stays quiet — a paused loop must not push *further* stats.
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

    /// A larger interval visibly slows the collect cadence: with a long interval
    /// the loop performs far fewer collects over a fixed window than a short one
    /// (#1233).
    #[tokio::test]
    async fn set_interval_changes_collect_cadence() {
        let provider = fast_live_provider();
        let collect_calls = provider.transport.collect_calls.clone();

        let mut sub = provider.subscribe().await.expect("subscribe");
        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Live);

        // Stretch the interval well beyond the observation window so only the
        // handful of ticks that already happened count.
        provider.set_interval(Duration::from_secs(60)).await;
        tokio::time::sleep(Duration::from_millis(120)).await;
        let after_slow = collect_calls.load(Ordering::SeqCst);

        // A short window at the 60s interval must not accumulate many collects.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let later = collect_calls.load(Ordering::SeqCst);
        assert!(
            later <= after_slow + 1,
            "a long interval must nearly halt collection (got {after_slow} then {later})"
        );

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// `cancel_connect` fires the loop's cancellation token so an in-flight
    /// connect / collect is aborted promptly (#1233, Cancel control).
    #[tokio::test]
    async fn cancel_connect_fires_the_loop_token() {
        let provider = fast_live_provider();
        let sub = provider.subscribe().await.expect("subscribe");

        // Grab the live token before cancelling so we can assert it fired.
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

    // ── Degraded-input fault modes through the real parser (MOCK-009) ──────
    //
    // Each test drives a degraded collect payload through the real
    // `collect_once` + `parse_stats` collect-loop path (never a mock parser) and
    // asserts the parser degrades gracefully: no panic, no false `Live`, and
    // either a sensible partial `SystemStats` or a clean typed error per the
    // parser's documented contract.

    /// A short-interval provider whose transport always collects `output`, so a
    /// degraded payload is driven through the real collect loop quickly.
    fn degraded_provider(output: &str) -> SshMonitoringProviderImpl<FakeTransport> {
        let mut provider = SshMonitoringProviderImpl::with_transport(
            FakeTransport::with_output(output),
            COLLECT_TIMEOUT,
        );
        // Tight interval so several degraded collects happen inside the test
        // window without waiting on the 2s default.
        provider.interval = Duration::from_millis(20);
        provider
    }

    /// A collect that is truncated below the parser's six-line floor is a clean
    /// typed error. The transport is up but the remote never answers with a
    /// parseable sample, so a reconnect cannot help: after `stale_threshold`
    /// consecutive pre-`Live` parse failures the loop resolves to the terminal
    /// `Offline` (no false `Live`, no fabricated stats) and ends, instead of
    /// hanging in `Connecting` forever (#3252).
    #[tokio::test]
    async fn truncated_output_yields_typed_error_and_no_false_live() {
        // The parser rejects the truncated sample with a typed error (contract).
        assert!(
            parse_stats(TRUNCATED_STATS).is_err(),
            "a sample below the six-line floor must be a parser error"
        );

        let provider = degraded_provider(TRUNCATED_STATS);
        let mut sub = provider.subscribe().await.expect("subscribe");

        // The first and only transition is straight to Offline — never a bogus
        // Live, and never a Stale/Reconnecting campaign against a healthy
        // transport.
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Offline,
            "persistently unparseable output must resolve Connecting -> Offline"
        );
        // …and must never push a stats sample derived from unparseable output.
        assert!(
            sub.stats.try_recv().is_err(),
            "a persistently unparseable collect must never push a stats sample"
        );
        // Bounded: exactly `stale_threshold` parse failures, then the loop ends
        // (the stats channel closes) without re-dialling the transport.
        assert!(
            tokio::time::timeout(Duration::from_secs(2), sub.stats.recv())
                .await
                .expect("the collect loop must end after going Offline")
                .is_none(),
            "an Offline loop ends and closes its stats channel"
        );
        assert_eq!(
            provider.transport.collect_calls.load(Ordering::SeqCst),
            DEFAULT_STALE_THRESHOLD as usize,
            "the loop gives up after `stale_threshold` consecutive parse failures"
        );
        assert_eq!(
            provider.transport.connect_calls.load(Ordering::SeqCst),
            1,
            "a pre-Live parse failure must not start a reconnect campaign"
        );

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// Garbage / non-numeric lines interleaved with the expected layout still
    /// parse (≥6 lines) into partial stats: unparseable numeric fields default
    /// to 0 rather than erroring the whole sample or reading as false-precise.
    #[tokio::test]
    async fn garbage_lines_yield_partial_zeroed_stats() {
        let provider = degraded_provider(GARBAGE_LINES_STATS);
        let mut sub = provider.subscribe().await.expect("subscribe");

        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Live);
        let stats = next_stats(&mut sub.stats).await;
        assert_eq!(
            stats.hostname, "weird-host",
            "the first line is still taken as the hostname"
        );
        assert_eq!(
            stats.load_average,
            [0.0, 0.0, 0.0],
            "a non-numeric loadavg degrades to zeros, not an error"
        );
        assert_eq!(
            stats.memory_total_kb, 0,
            "a non-numeric MemTotal degrades to zero"
        );
        assert!((stats.memory_used_percent - 0.0).abs() < f64::EPSILON);
        assert_eq!(
            stats.disk_total_kb, 0,
            "unparseable df data leaves disk at zero"
        );
        assert!((stats.cpu_usage_percent - 0.0).abs() < f64::EPSILON);

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// A missing `/proc/meminfo` section zeroes the memory metrics while every
    /// other leg still parses — a partial sample, not a crash or a false
    /// 100%-used reading.
    #[tokio::test]
    async fn missing_meminfo_section_defaults_memory_to_zero() {
        let provider = degraded_provider(MISSING_MEMINFO_STATS);
        let mut sub = provider.subscribe().await.expect("subscribe");

        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Live);
        let stats = next_stats(&mut sub.stats).await;
        assert_eq!(stats.hostname, "nomeminfo");
        // Memory leg absent → zeroed, not a false 100%-used.
        assert_eq!(stats.memory_total_kb, 0);
        assert_eq!(stats.memory_available_kb, 0);
        assert!((stats.memory_used_percent - 0.0).abs() < f64::EPSILON);
        // The sections that WERE present still parse.
        assert!((stats.load_average[0] - 0.42).abs() < 0.001);
        assert!((stats.uptime_seconds - 9999.50).abs() < 0.01);
        assert_eq!(stats.disk_total_kb, 10_000_000);
        assert!((stats.disk_used_percent - 40.0).abs() < 0.1);
        assert_eq!(stats.os_info, "Linux 6.1.0");

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// A truncated trailing `/proc/net/dev` block degrades the network leg to 0
    /// (its row has too few columns) while every metric emitted before it
    /// survives intact — the documented "a failure there only drops the network
    /// leg" contract.
    #[tokio::test]
    async fn truncated_netdev_block_zeros_network_but_keeps_earlier_metrics() {
        let provider = degraded_provider(TRUNCATED_NETDEV_STATS);
        let mut sub = provider.subscribe().await.expect("subscribe");

        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Live);
        let stats = next_stats(&mut sub.stats).await;
        // The mangled /proc/net/dev row has too few columns → network → 0.
        assert!((stats.net_rx_bytes_per_sec - 0.0).abs() < f64::EPSILON);
        assert!((stats.net_tx_bytes_per_sec - 0.0).abs() < f64::EPSILON);
        // Every metric emitted before the network block survives intact.
        assert_eq!(stats.hostname, "nettrunc");
        assert_eq!(stats.memory_total_kb, 16_384_000);
        assert_eq!(stats.memory_available_kb, 12_000_000);
        assert_eq!(stats.disk_total_kb, 50_000_000);
        assert!((stats.disk_used_percent - 42.0).abs() < 0.1);
        assert_eq!(stats.os_info, "Linux 5.15.0");

        provider.unsubscribe().await.expect("unsubscribe");
    }

    /// A BusyBox/musl-shaped sample (no `MemAvailable`, no swap, BusyBox `df`
    /// header, Alpine `uname`) parses to sensible values via the classic
    /// MemFree+Buffers+Cached(+SReclaimable) fallback rather than reading as
    /// 100%-used.
    #[tokio::test]
    async fn busybox_shaped_output_parses_via_memavailable_fallback() {
        let provider = degraded_provider(BUSYBOX_STATS);
        let mut sub = provider.subscribe().await.expect("subscribe");

        assert_eq!(next_status(&mut sub.status).await, MonitorStatus::Live);
        let stats = next_stats(&mut sub.stats).await;
        assert_eq!(stats.hostname, "alpine-box");
        assert_eq!(stats.memory_total_kb, 512_000);
        // No MemAvailable → MemFree+Buffers+Cached(+SReclaimable) fallback:
        // 100000 + 20000 + 80000 = 200000.
        assert_eq!(stats.memory_available_kb, 200_000);
        // used = 512000 - 200000 = 312000 → ~60.94%.
        assert!(
            (stats.memory_used_percent - 60.9375).abs() < 0.5,
            "got {}",
            stats.memory_used_percent
        );
        // No swap lines → zeroed swap, not an error.
        assert_eq!(stats.swap_total_kb, 0);
        assert!((stats.swap_used_percent - 0.0).abs() < f64::EPSILON);
        // The BusyBox df header differs but the data row parses by column.
        assert_eq!(stats.disk_total_kb, 2_000_000);
        assert!((stats.disk_used_percent - 40.0).abs() < 0.1);
        assert_eq!(stats.os_info, "Linux 5.15.0-0-virt");

        provider.unsubscribe().await.expect("unsubscribe");
    }
}
