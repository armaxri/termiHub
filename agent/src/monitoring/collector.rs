//! Stats collectors for local and remote hosts.
//!
//! Both [`LocalCollector`] and [`SshCollector`] implement the core
//! [`StatsCollector`](termihub_core::monitoring::StatsCollector) trait,
//! returning [`SystemStats`](termihub_core::monitoring::SystemStats).
//! The monitoring task adds the `host` field when building protocol-level
//! [`MonitoringData`](crate::protocol::methods::MonitoringData).
//!
//! [`LocalCollector`] lives in `termihub-core` (`monitoring::local_collector`)
//! so both the agent's self-monitoring and the desktop's local monitoring
//! provider share the one sysinfo-backed collector (PROD-0022); it is
//! re-exported here so existing `collector::LocalCollector` paths keep working.

use std::time::Instant;

use anyhow::{Context, Result};
use russh::ChannelMsg;
use tracing::debug;

use crate::protocol::methods::SshSessionConfig;
use termihub_core::backends::ssh::handler::SshSession;

// Re-export core trait + the shared local collector so the monitoring manager
// can import them from here.
pub use termihub_core::monitoring::{LocalCollector, StatsCollector};

use termihub_core::errors::CoreError;
use termihub_core::monitoring::{
    parse_stats, CpuDeltaTracker, NetDeltaTracker, PerCoreCpuTracker, SystemStats,
    MONITORING_COMMAND,
};

// ── SSH collector ───────────────────────────────────────────────────

/// Collects system statistics from a remote Linux host via SSH exec.
///
/// Opens a persistent russh connection and executes the monitoring
/// command on each collection cycle via async exec channels.
pub struct SshCollector {
    session: SshSession,
    cpu_tracker: CpuDeltaTracker,
    per_core_tracker: PerCoreCpuTracker,
    net_tracker: NetDeltaTracker,
}

impl SshCollector {
    /// Open a new SSH connection for monitoring.
    pub fn new(config: &SshSessionConfig) -> Result<Self> {
        let (session, _registry) = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(termihub_core::backends::ssh::auth::connect_and_authenticate(config))
        })
        .context("SSH connection failed")?;
        debug!(
            "SSH monitoring connection established to {}@{}",
            config.username, config.host
        );
        Ok(Self {
            session,
            cpu_tracker: CpuDeltaTracker::new(),
            per_core_tracker: PerCoreCpuTracker::new(),
            net_tracker: NetDeltaTracker::new(),
        })
    }

    /// Execute a command over SSH and return stdout.
    fn exec(&self, command: &str) -> Result<String> {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let mut channel = self
                    .session
                    .channel_open_session()
                    .await
                    .context("SSH channel open failed")?;

                channel
                    .exec(false, command)
                    .await
                    .context("SSH exec failed")?;

                // Collect the raw stdout frames; a multi-byte UTF-8 character
                // can straddle two frames, so decoding is deferred until every
                // frame has been received (see [`decode_stdout`]).
                let mut frames: Vec<Vec<u8>> = Vec::new();
                loop {
                    match channel.wait().await {
                        Some(ChannelMsg::Data { ref data }) => frames.push(data.to_vec()),
                        Some(ChannelMsg::ExitStatus { .. }) => {}
                        Some(ChannelMsg::Eof) | None => break,
                        _ => {}
                    }
                }
                Ok::<String, anyhow::Error>(decode_stdout(&frames))
            })
        })
    }
}

impl StatsCollector for SshCollector {
    fn collect(&mut self, _host_label: &str) -> Result<SystemStats, CoreError> {
        let output = self
            .exec(MONITORING_COMMAND)
            .map_err(|e| CoreError::Other(e.to_string()))?;
        // A parse failure is typed apart from the exec failure above so the
        // monitoring loop can bound it separately (#3252/#3300).
        let (mut stats, counters, per_core_counters, net_counters) =
            parse_stats(&output).map_err(|e| CoreError::Unparseable(e.to_string()))?;

        // First sample has no prior snapshot to diff against, so report 0 %/0 B/s;
        // core's Cpu/NetDeltaTracker encapsulate that previous-snapshot state.
        stats.cpu_usage_percent = self.cpu_tracker.update(counters).unwrap_or(0.0);
        stats.per_core_cpu_percent = self.per_core_tracker.update(&per_core_counters);
        let (net_rx, net_tx) = self.net_tracker.update(net_counters, Instant::now());
        stats.net_rx_bytes_per_sec = net_rx;
        stats.net_tx_bytes_per_sec = net_tx;

        Ok(stats)
    }
}

/// Reassemble SSH stdout, delivered as a sequence of `ChannelMsg::Data` byte
/// frames, into a single string.
///
/// SSH frames carry arbitrary byte slices whose boundaries are set by the
/// channel window, not by character boundaries, so a multi-byte UTF-8 sequence
/// can straddle two frames. The bytes are concatenated before decoding so a
/// boundary-split character is never lost; [`String::from_utf8_lossy`] then
/// tolerates any genuinely invalid bytes rather than discarding a whole frame.
fn decode_stdout(frames: &[Vec<u8>]) -> String {
    let mut bytes = Vec::with_capacity(frames.iter().map(Vec::len).sum());
    for frame in frames {
        bytes.extend_from_slice(frame);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_stdout_reassembles_utf8_split_across_frames() {
        // "é" is 0xC3 0xA9; split it across two Data frames, as SSH may deliver
        // it when the character straddles a channel-window boundary.
        let frames = vec![vec![b'c', b'a', b'f', 0xC3], vec![0xA9, b'\n']];
        assert_eq!(decode_stdout(&frames), "café\n");
    }

    #[test]
    fn decode_stdout_handles_empty_and_ascii() {
        assert_eq!(decode_stdout(&[]), "");
        assert_eq!(decode_stdout(&[b"hostname\n".to_vec()]), "hostname\n");
    }

    #[test]
    fn decode_stdout_is_lossy_on_invalid_bytes() {
        // A lone continuation byte is never valid UTF-8; it becomes U+FFFD
        // while the surrounding bytes survive, rather than dropping the frame.
        let frames = vec![vec![b'a', 0xFF, b'b']];
        assert_eq!(decode_stdout(&frames), "a\u{FFFD}b");
    }
}
