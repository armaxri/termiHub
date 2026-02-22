//! SSH monitoring provider implementing [`MonitoringProvider`].
//!
//! Collects system statistics from a remote host by periodically running
//! a monitoring command over SSH and parsing the output. Uses a dedicated
//! SSH session in blocking mode.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tracing::{debug, warn};

use crate::config::SshConfig;
use crate::errors::CoreError;
use crate::monitoring::{
    parse_stats, CpuDeltaTracker, MonitoringProvider, MonitoringReceiver, MonitoringSender,
    MONITORING_COMMAND,
};

use super::auth::connect_and_authenticate;

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
/// Spawns a background thread that periodically runs the monitoring
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
fn ssh_exec(session: &ssh2::Session, command: &str) -> Result<String, CoreError> {
    let mut channel = session
        .channel_session()
        .map_err(|e| CoreError::Other(format!("Channel open failed: {e}")))?;

    channel
        .exec(command)
        .map_err(|e| CoreError::Other(format!("Exec failed: {e}")))?;

    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|e| CoreError::Other(format!("Read failed: {e}")))?;

    channel.wait_close().ok();

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

        std::thread::Builder::new()
            .name("ssh-monitoring".to_string())
            .spawn(move || {
                // Open a dedicated SSH session for monitoring.
                let session = match connect_and_authenticate(&config) {
                    Ok(s) => s,
                    Err(e) => {
                        warn!("Monitoring SSH connection failed: {e}");
                        return;
                    }
                };
                session.set_blocking(true);

                let mut cpu_tracker = CpuDeltaTracker::new();

                while alive_clone.load(Ordering::SeqCst) {
                    match ssh_exec(&session, MONITORING_COMMAND) {
                        Ok(output) => {
                            match parse_stats(&output) {
                                Ok((mut stats, counters)) => {
                                    if let Some(pct) = cpu_tracker.update(counters) {
                                        stats.cpu_usage_percent = pct;
                                    }
                                    if tx.blocking_send(stats).is_err() {
                                        // Receiver dropped.
                                        break;
                                    }
                                }
                                Err(e) => {
                                    debug!("Failed to parse monitoring output: {e}");
                                }
                            }
                        }
                        Err(e) => {
                            debug!("Monitoring exec failed: {e}");
                        }
                    }

                    // Sleep in small increments to allow quick shutdown.
                    let mut remaining = MONITORING_INTERVAL;
                    let tick = Duration::from_millis(100);
                    while remaining > Duration::ZERO && alive_clone.load(Ordering::SeqCst) {
                        let sleep_time = remaining.min(tick);
                        std::thread::sleep(sleep_time);
                        remaining = remaining.saturating_sub(sleep_time);
                    }
                }
                debug!("Monitoring thread stopped");
            })
            .map_err(|e| CoreError::Other(format!("Failed to spawn monitoring thread: {e}")))?;

        if let Ok(mut guard) = self.task.lock() {
            *guard = Some(MonitoringTask { alive });
        }

        Ok(rx)
    }

    async fn unsubscribe(&self) -> Result<(), CoreError> {
        if let Ok(mut guard) = self.task.lock() {
            // Drop the task, which sets alive=false via the Drop impl.
            *guard = None;
        }
        Ok(())
    }
}
