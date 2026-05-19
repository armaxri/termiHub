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

use super::auth::connect_and_authenticate;
use super::handler::SshSession;

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
            let (session, _registry) = match connect_and_authenticate(&config).await {
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
