//! Stats collectors for local and remote hosts.
//!
//! Both [`LocalCollector`] and [`SshCollector`] implement the core
//! [`StatsCollector`](termihub_core::monitoring::StatsCollector) trait,
//! returning [`SystemStats`](termihub_core::monitoring::SystemStats).
//! The monitoring task adds the `host` field when building protocol-level
//! [`MonitoringData`](crate::protocol::methods::MonitoringData).

use anyhow::{Context, Result};
use russh::ChannelMsg;
use sysinfo::{Disks, System};
use tracing::debug;

use crate::protocol::methods::SshSessionConfig;
use termihub_core::backends::ssh::handler::SshSession;

// Re-export core trait so the monitoring manager can import it from here.
pub use termihub_core::monitoring::StatsCollector;

use termihub_core::errors::CoreError;
use termihub_core::monitoring::{
    cpu_percent_from_delta, parse_stats, CpuCounters, SystemStats, MONITORING_COMMAND,
};

// ── Local collector ─────────────────────────────────────────────────

/// Collects system statistics from the agent's own host using the `sysinfo` crate.
///
/// Cross-platform: works on Linux, macOS, Windows, and any other platform
/// supported by `sysinfo`. The `System` instance is kept alive between polls
/// so that `global_cpu_usage()` can compute delta-based percentages correctly.
pub struct LocalCollector {
    sys: System,
    cached_hostname: String,
    cached_os_info: String,
}

impl LocalCollector {
    pub fn new() -> Self {
        let mut sys = System::new();
        // Prime the CPU counters so the first real `collect()` call returns a
        // meaningful delta rather than 0 %.
        sys.refresh_cpu_usage();

        let hostname = System::host_name().unwrap_or_else(|| "unknown".to_string());
        let os_info = System::long_os_version()
            .or_else(|| {
                let name = System::name()?;
                let ver = System::os_version().unwrap_or_default();
                Some(if ver.is_empty() {
                    name
                } else {
                    format!("{name} {ver}")
                })
            })
            .unwrap_or_else(|| "Unknown OS".to_string());

        Self {
            sys,
            cached_hostname: hostname,
            cached_os_info: os_info,
        }
    }
}

impl Default for LocalCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl StatsCollector for LocalCollector {
    fn collect(&mut self, _host_label: &str) -> Result<SystemStats, CoreError> {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();

        let disks = Disks::new_with_refreshed_list();

        let cpu_usage_percent = self.sys.global_cpu_usage() as f64;

        let mem_total_kb = self.sys.total_memory() / 1024;
        let mem_available_kb = self.sys.available_memory() / 1024;
        let memory_used_percent = if mem_total_kb > 0 {
            let used = mem_total_kb.saturating_sub(mem_available_kb);
            used as f64 / mem_total_kb as f64 * 100.0
        } else {
            0.0
        };

        let (disk_total_kb, disk_used_kb, disk_used_percent) = root_disk_stats(&disks);

        let uptime_seconds = System::uptime() as f64;
        let load_avg = System::load_average();
        let load_average = [load_avg.one, load_avg.five, load_avg.fifteen];

        Ok(SystemStats {
            hostname: self.cached_hostname.clone(),
            uptime_seconds,
            load_average,
            cpu_usage_percent,
            memory_total_kb: mem_total_kb,
            memory_available_kb: mem_available_kb,
            memory_used_percent,
            disk_total_kb,
            disk_used_kb,
            disk_used_percent,
            os_info: self.cached_os_info.clone(),
        })
    }
}

/// Pick the disk that represents the user-visible root filesystem.
///
/// On macOS Catalina+, `/` is a read-only System snapshot; the real user
/// data (and correct total/used figures) live on `/System/Volumes/Data`.
/// On every other platform we use `/` (Linux) or `C:\` (Windows) and fall
/// back to whichever mounted disk has the most total space.
fn root_disk_stats(disks: &Disks) -> (u64, u64, f64) {
    let preferred = if cfg!(target_os = "macos") {
        std::path::Path::new("/System/Volumes/Data")
    } else if cfg!(windows) {
        std::path::Path::new("C:\\")
    } else {
        std::path::Path::new("/")
    };
    let fallback = std::path::Path::new("/");

    let disk = disks
        .iter()
        .find(|d| d.mount_point() == preferred)
        .or_else(|| disks.iter().find(|d| d.mount_point() == fallback))
        .or_else(|| disks.iter().max_by_key(|d| d.total_space()));

    let Some(disk) = disk else {
        return (0, 0, 0.0);
    };

    let total = disk.total_space() / 1024;
    let avail = disk.available_space() / 1024;
    let used = total.saturating_sub(avail);
    let pct = if total > 0 {
        used as f64 / total as f64 * 100.0
    } else {
        0.0
    };
    (total, used, pct)
}

// ── SSH collector ───────────────────────────────────────────────────

/// Collects system statistics from a remote Linux host via SSH exec.
///
/// Opens a persistent russh connection and executes the monitoring
/// command on each collection cycle via async exec channels.
pub struct SshCollector {
    session: SshSession,
    prev_cpu: Option<CpuCounters>,
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
            prev_cpu: None,
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
                Ok::<String, anyhow::Error>(output)
            })
        })
    }
}

impl StatsCollector for SshCollector {
    fn collect(&mut self, _host_label: &str) -> Result<SystemStats, CoreError> {
        let output = self
            .exec(MONITORING_COMMAND)
            .map_err(|e| CoreError::Other(e.to_string()))?;
        let (stats, counters) =
            parse_stats(&output).map_err(|e| CoreError::Other(e.to_string()))?;

        let cpu_usage_percent = match &self.prev_cpu {
            Some(prev) => cpu_percent_from_delta(prev, &counters),
            None => 0.0,
        };
        self.prev_cpu = Some(counters);

        Ok(SystemStats {
            hostname: stats.hostname,
            uptime_seconds: stats.uptime_seconds,
            load_average: stats.load_average,
            cpu_usage_percent,
            memory_total_kb: stats.memory_total_kb,
            memory_available_kb: stats.memory_available_kb,
            memory_used_percent: stats.memory_used_percent,
            disk_total_kb: stats.disk_total_kb,
            disk_used_kb: stats.disk_used_kb,
            disk_used_percent: stats.disk_used_percent,
            os_info: stats.os_info,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_collector_returns_valid_stats() {
        let mut collector = LocalCollector::new();
        let stats = collector.collect("test").expect("collect should succeed");

        assert!(!stats.hostname.is_empty());
        assert!(stats.uptime_seconds > 0.0);
        assert!(
            (0.0..=100.0).contains(&stats.cpu_usage_percent),
            "cpu_usage_percent out of range: {}",
            stats.cpu_usage_percent
        );
        assert!(stats.memory_total_kb > 0, "memory_total_kb should be > 0");
        assert!(
            stats.memory_available_kb <= stats.memory_total_kb,
            "available memory exceeds total"
        );
        assert!(
            (0.0..=100.0).contains(&stats.memory_used_percent),
            "memory_used_percent out of range: {}",
            stats.memory_used_percent
        );
        assert!(!stats.os_info.is_empty());
    }

    #[test]
    fn local_collector_second_sample_has_cpu() {
        // The first sample primes the counters; the second should reflect
        // real usage (> 0 on any active machine, though we only verify it's valid).
        let mut collector = LocalCollector::new();
        let _first = collector.collect("test").unwrap();
        let second = collector.collect("test").unwrap();
        assert!(
            (0.0..=100.0).contains(&second.cpu_usage_percent),
            "cpu_usage_percent out of range on second sample: {}",
            second.cpu_usage_percent
        );
    }

    #[test]
    fn local_collector_disk_stats_nonzero() {
        let mut collector = LocalCollector::new();
        let stats = collector.collect("test").unwrap();
        assert!(stats.disk_total_kb > 0, "disk_total_kb should be > 0");
        assert!(
            stats.disk_used_kb <= stats.disk_total_kb,
            "used disk exceeds total"
        );
        assert!(
            (0.0..=100.0).contains(&stats.disk_used_percent),
            "disk_used_percent out of range: {}",
            stats.disk_used_percent
        );
    }
}
