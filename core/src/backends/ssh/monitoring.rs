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
    parse_stats, CpuDeltaTracker, MonitoringProvider, MonitoringReceiver, MonitoringSender,
    MONITORING_COMMAND,
};

use super::handler::{ForwardedChannelRegistry, SshSession};
use super::jump_host::{connect_target, GatewayHold};

/// Polling interval for collecting system stats.
const MONITORING_INTERVAL: Duration = Duration::from_secs(2);

/// Channel capacity for monitoring stats updates.
const MONITORING_CHANNEL_CAPACITY: usize = 16;

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

#[async_trait::async_trait]
impl<T: MonitoringTransport> MonitoringProvider for SshMonitoringProviderImpl<T> {
    async fn subscribe(&self) -> Result<MonitoringReceiver, CoreError> {
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

        let alive = Arc::new(AtomicBool::new(true));
        let alive_clone = alive.clone();
        let transport = self.transport.clone();
        let collect_timeout = self.collect_timeout;

        // The loop owns the already-open session; it never reconnects.
        tokio::spawn(async move {
            let session = session;
            let mut cpu_tracker = CpuDeltaTracker::new();

            while alive_clone.load(Ordering::SeqCst) {
                match collect_once(&*transport, &session, collect_timeout).await {
                    Ok(output) => match parse_stats(&output) {
                        Ok((mut stats, counters)) => {
                            if let Some(pct) = cpu_tracker.update(counters) {
                                stats.cpu_usage_percent = pct;
                            }
                            if tx.send(stats).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            debug!("Failed to parse monitoring output: {e}");
                        }
                    },
                    Err(e) => {
                        debug!("Monitoring collect failed: {e}");
                    }
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

        Ok(rx)
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
    use std::sync::atomic::AtomicUsize;

    /// Fake transport with scripted connect / collect behaviour for tests.
    struct FakeTransport {
        connect_ok: bool,
        collect_delay: Duration,
        collect_calls: Arc<AtomicUsize>,
    }

    impl FakeTransport {
        fn new(connect_ok: bool, collect_delay: Duration) -> Self {
            Self {
                connect_ok,
                collect_delay,
                collect_calls: Arc::new(AtomicUsize::new(0)),
            }
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
            Ok("collected".to_string())
        }
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

    /// G4: a successful connect yields a live receiver.
    #[tokio::test]
    async fn subscribe_returns_ok_when_connect_succeeds() {
        let transport = FakeTransport::new(true, Duration::ZERO);
        let provider = SshMonitoringProviderImpl::with_transport(transport, COLLECT_TIMEOUT);

        let result = provider.subscribe().await;

        assert!(result.is_ok(), "successful connect must return a receiver");
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
