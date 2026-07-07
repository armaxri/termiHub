//! SSH monitoring provider implementing [`MonitoringProvider`].
//!
//! Collects system statistics from a remote host by periodically executing
//! the monitoring command over an SSH exec channel and parsing the output.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::ChannelMsg;
use tracing::{debug, warn};

use crate::config::SshConfig;
use crate::errors::CoreError;
use crate::monitoring::{
    parse_stats, CpuDeltaTracker, MonitoringProvider, MonitoringReceiver, MonitoringSender,
    MONITORING_COMMAND,
};

use super::handler::SshSession;
use super::jump_host::connect_target;

/// Polling interval for collecting system stats.
const MONITORING_INTERVAL: Duration = Duration::from_secs(2);

/// Channel capacity for monitoring stats updates.
const MONITORING_CHANNEL_CAPACITY: usize = 16;

/// Background monitoring task state.
struct MonitoringTask {
    alive: Arc<AtomicBool>,
}

impl Drop for MonitoringTask {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
    }
}

/// SSH-based monitoring provider.
///
/// Spawns a background tokio task that periodically executes the monitoring
/// command over SSH, parses the output, and sends stats through a channel.
pub(crate) struct SshMonitoringProvider {
    config: SshConfig,
    task: Arc<Mutex<Option<MonitoringTask>>>,
}

impl SshMonitoringProvider {
    pub(crate) fn new(config: SshConfig) -> Self {
        Self {
            config,
            task: Arc::new(Mutex::new(None)),
        }
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

#[async_trait::async_trait]
impl MonitoringProvider for SshMonitoringProvider {
    async fn subscribe(&self) -> Result<MonitoringReceiver, CoreError> {
        // Stop any existing monitoring task.
        if let Ok(mut guard) = self.task.lock() {
            *guard = None;
        }

        let config = self.config.clone();
        let (tx, rx): (MonitoringSender, MonitoringReceiver) =
            tokio::sync::mpsc::channel(MONITORING_CHANNEL_CAPACITY);

        let alive = Arc::new(AtomicBool::new(true));
        let alive_clone = alive.clone();

        tokio::spawn(async move {
            // Reach the target directly, or through its pooled jump-host gateway
            // when a ProxyJump chain is configured (#939). `_gateway` is held for
            // the task's lifetime so the bastion session stays open.
            let (session, _registry, _gateway) = match connect_target(&config, None).await {
                Ok(s) => s,
                Err(e) => {
                    warn!("Monitoring SSH connection failed: {e}");
                    return;
                }
            };

            let mut cpu_tracker = CpuDeltaTracker::new();

            while alive_clone.load(Ordering::SeqCst) {
                match ssh_exec(&session, MONITORING_COMMAND).await {
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
                        debug!("Monitoring exec failed: {e}");
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
            *guard = Some(MonitoringTask { alive });
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
