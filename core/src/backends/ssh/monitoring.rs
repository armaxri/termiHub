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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::ChannelMsg;
use tokio_util::sync::CancellationToken;
use tracing::debug;

use crate::config::SshConfig;
use crate::errors::CoreError;
use crate::monitoring::{
    parse_stats, CollectLoopState, CpuDeltaTracker, MonitorStatus, MonitorStatusSender,
    MonitoringProvider, MonitoringReceiver, MonitoringSender, MonitoringSubscription,
    DEFAULT_STALE_THRESHOLD, MONITORING_COMMAND,
};

use super::handler::{ForwardedChannelRegistry, SshSession};
use super::jump_host::{connect_target, GatewayHold};

/// Polling interval for collecting system stats.
const MONITORING_INTERVAL: Duration = Duration::from_secs(2);

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

/// Background monitoring task state.
struct MonitoringTask {
    alive: Arc<AtomicBool>,
    /// Cancels an in-flight connect / collect (wired to Cancel controls in a
    /// follow-up issue). Cancelled on drop so a torn-down subscription aborts
    /// any pending SSH handshake promptly.
    cancel: CancellationToken,
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
    /// Consecutive collect failures tolerated before the loop reports `Stale`.
    stale_threshold: u32,
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
            stale_threshold: DEFAULT_STALE_THRESHOLD,
            task: Arc::new(Mutex::new(None)),
        }
    }
}

impl SshMonitoringProviderImpl<SshTransport> {
    /// Construct a provider that monitors the host described by `config`.
    pub(crate) fn new(config: SshConfig) -> Self {
        Self::with_transport(SshTransport { config }, COLLECT_TIMEOUT)
    }
}

/// Execute a command over an SSH session and return stdout as a string.
async fn ssh_exec(session: &SshSession, command: &str) -> Result<String, CoreError> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| CoreError::Other(format!("Channel open failed: {e}")))?;

    channel
        .exec(false, command)
        .await
        .map_err(|e| CoreError::Other(format!("Exec failed: {e}")))?;

    let mut output = String::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => {
                if let Ok(s) = std::str::from_utf8(data) {
                    output.push_str(s);
                }
            }
            Some(ChannelMsg::ExitStatus { .. }) => {}
            Some(ChannelMsg::Eof) | None => break,
            _ => {}
        }
    }

    Ok(output)
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

        // The loop owns the already-open session; it never reconnects. It
        // tracks its own status via `CollectLoopState`: the first successful
        // collect emits `Live`; `stale_threshold` consecutive failures emit
        // `Stale`; a later success emits `Live` again (#1229, gap G1).
        tokio::spawn(async move {
            let session = session;
            let mut cpu_tracker = CpuDeltaTracker::new();
            let mut loop_state = CollectLoopState::with_threshold(stale_threshold);

            while alive_clone.load(Ordering::SeqCst) {
                // A collect error, a parse error, or a stat send failure all
                // mean "no fresh sample this tick" → count as a failure.
                let collected = match collect_once(&*transport, &session, collect_timeout).await {
                    Ok(output) => match parse_stats(&output) {
                        Ok((mut stats, counters)) => {
                            if let Some(pct) = cpu_tracker.update(counters) {
                                stats.cpu_usage_percent = pct;
                            }
                            if tx.send(stats).await.is_err() {
                                break;
                            }
                            true
                        }
                        Err(e) => {
                            debug!("Failed to parse monitoring output: {e}");
                            false
                        }
                    },
                    Err(e) => {
                        debug!("Monitoring collect failed: {e}");
                        false
                    }
                };

                let transition = if collected {
                    loop_state.on_success()
                } else {
                    loop_state.on_failure()
                };
                if let Some(status) = transition {
                    emit_status(&status_tx, status).await;
                }

                // Sleep in 100ms increments to allow quick shutdown.
                let mut remaining = MONITORING_INTERVAL;
                let tick = Duration::from_millis(100);
                while remaining > Duration::ZERO && alive_clone.load(Ordering::SeqCst) {
                    tokio::time::sleep(tick.min(remaining)).await;
                    remaining = remaining.saturating_sub(tick);
                }
            }
            debug!("Monitoring task stopped");
        });

        if let Ok(mut guard) = self.task.lock() {
            *guard = Some(MonitoringTask { alive, cancel });
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

    /// Fake transport with scripted connect / collect behaviour for tests.
    ///
    /// `collect_should_fail` lets a test flip collects between success and
    /// failure at runtime to exercise the Live↔Stale status transitions.
    struct FakeTransport {
        connect_ok: bool,
        collect_delay: Duration,
        collect_calls: Arc<AtomicUsize>,
        collect_should_fail: Arc<AtomicBool>,
        collect_output: String,
    }

    impl FakeTransport {
        fn new(connect_ok: bool, collect_delay: Duration) -> Self {
            Self {
                connect_ok,
                collect_delay,
                collect_calls: Arc::new(AtomicUsize::new(0)),
                collect_should_fail: Arc::new(AtomicBool::new(false)),
                collect_output: "collected".to_string(),
            }
        }

        /// A transport whose collects return parseable stats and whose failure
        /// mode is controlled by the returned flag (`true` = fail).
        fn with_failure_flag() -> (Self, Arc<AtomicBool>) {
            let flag = Arc::new(AtomicBool::new(false));
            let transport = Self {
                connect_ok: true,
                collect_delay: Duration::ZERO,
                collect_calls: Arc::new(AtomicUsize::new(0)),
                collect_should_fail: flag.clone(),
                collect_output: SAMPLE_STATS.to_string(),
            };
            (transport, flag)
        }
    }

    #[async_trait::async_trait]
    impl MonitoringTransport for FakeTransport {
        type Session = ();

        async fn connect(&self, _cancel: CancellationToken) -> Result<Self::Session, CoreError> {
            if self.connect_ok {
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

    /// Wait for the next status transition, failing if none arrives in time.
    async fn next_status(rx: &mut MonitorStatusReceiver) -> MonitorStatus {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("status should arrive before timeout")
            .expect("status channel should stay open")
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

    /// G1: a mid-stream collect drop flips the status channel to `Stale`, and a
    /// recovery flips it back to `Live` — the loop-state transitions observed
    /// through the real collect loop.
    #[tokio::test]
    async fn collect_loop_emits_stale_on_drop_and_live_on_recovery() {
        let (transport, fail) = FakeTransport::with_failure_flag();
        // Threshold 1 so a single failure is enough to go Stale in the test.
        let mut provider = SshMonitoringProviderImpl::with_transport(transport, COLLECT_TIMEOUT);
        provider.stale_threshold = 1;

        let mut sub = provider.subscribe().await.expect("subscribe");

        // First successful collect emits Live.
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Live,
            "first successful collect must emit Live"
        );

        // Simulate a mid-stream drop: subsequent collects fail → Stale.
        fail.store(true, Ordering::SeqCst);
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Stale,
            "a mid-stream collect drop must emit Stale"
        );

        // Recover: collects succeed again → Live.
        fail.store(false, Ordering::SeqCst);
        assert_eq!(
            next_status(&mut sub.status).await,
            MonitorStatus::Live,
            "recovery must emit Live again"
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
}
