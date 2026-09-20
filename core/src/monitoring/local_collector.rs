//! Local-host stats collector built on the cross-platform `sysinfo` crate.
//!
//! [`LocalCollector`] implements the synchronous [`StatsCollector`] trait,
//! returning [`SystemStats`] for the machine the process runs on. It is shared
//! by the agent (self-monitoring, `host = "self"`) and the desktop's
//! [`LocalMonitoringProvider`](crate::monitoring::LocalMonitoringProvider) so a
//! locally-run session can surface system stats without an agent (PROD-0022).
//!
//! Cross-platform: `sysinfo` presents a uniform API on Linux, macOS, Windows,
//! and every other platform it supports, so no `#[cfg]` gating is needed here.

use std::time::Instant;

use sysinfo::{Disks, Networks, System};

use crate::errors::CoreError;
use crate::monitoring::{NetCounters, NetDeltaTracker, StatsCollector, SystemStats};

/// Collects system statistics from the process's own host using `sysinfo`.
///
/// The `System` instance is kept alive between polls so that
/// `global_cpu_usage()` can compute delta-based percentages correctly.
pub struct LocalCollector {
    sys: System,
    networks: Networks,
    net_tracker: NetDeltaTracker,
    cached_hostname: String,
    cached_os_info: String,
}

impl LocalCollector {
    /// Create a collector, priming the CPU and network counters so the first
    /// real [`collect`](StatsCollector::collect) returns meaningful deltas.
    pub fn new() -> Self {
        let mut sys = System::new();
        // Prime the CPU counters so the first real `collect()` call returns a
        // meaningful delta rather than 0 %.
        sys.refresh_cpu_usage();

        // Prime the network counters; the first `collect()` reports 0 B/s (no
        // prior delta), matching the SSH collector's first-sample behaviour.
        let networks = Networks::new_with_refreshed_list();

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
            networks,
            net_tracker: NetDeltaTracker::new(),
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
        let mem_used_kb = self.sys.used_memory() / 1024;
        let mem_available_kb = mem_total_kb.saturating_sub(mem_used_kb);
        let memory_used_percent = if mem_total_kb > 0 {
            mem_used_kb as f64 / mem_total_kb as f64 * 100.0
        } else {
            0.0
        };

        // Swap (refreshed by `refresh_memory` above). A host with no swap
        // reports total 0, yielding 0 used / 0 %.
        let swap_total_kb = self.sys.total_swap() / 1024;
        let swap_used_kb = self.sys.used_swap() / 1024;
        let swap_used_percent = if swap_total_kb > 0 {
            swap_used_kb as f64 / swap_total_kb as f64 * 100.0
        } else {
            0.0
        };

        let (disk_total_kb, disk_used_kb, disk_used_percent) = root_disk_stats(&disks);

        // Network throughput: sum cumulative byte counters over all non-loopback
        // interfaces, then diff against the previous snapshot for a per-second
        // rate. `refresh(false)` keeps interfaces that briefly drop out of the
        // listing so their counters are not lost between polls.
        self.networks.refresh(false);
        let mut net_rx_bytes: u64 = 0;
        let mut net_tx_bytes: u64 = 0;
        for (name, data) in &self.networks {
            if name == "lo" {
                continue;
            }
            net_rx_bytes = net_rx_bytes.saturating_add(data.total_received());
            net_tx_bytes = net_tx_bytes.saturating_add(data.total_transmitted());
        }
        let (net_rx_bytes_per_sec, net_tx_bytes_per_sec) = self.net_tracker.update(
            NetCounters {
                rx_bytes: net_rx_bytes,
                tx_bytes: net_tx_bytes,
            },
            Instant::now(),
        );

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
            swap_total_kb,
            swap_used_kb,
            swap_used_percent,
            net_rx_bytes_per_sec,
            net_tx_bytes_per_sec,
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
        // Swap may legitimately be 0 (no swap), but the percent must be sane and
        // used must never exceed total.
        assert!(
            (0.0..=100.0).contains(&stats.swap_used_percent),
            "swap_used_percent out of range: {}",
            stats.swap_used_percent
        );
        assert!(
            stats.swap_used_kb <= stats.swap_total_kb,
            "used swap exceeds total"
        );
        // First sample has no prior delta, so throughput rates are exactly 0.
        assert_eq!(stats.net_rx_bytes_per_sec, 0.0);
        assert_eq!(stats.net_tx_bytes_per_sec, 0.0);
    }

    #[test]
    fn local_collector_second_sample_net_rates_non_negative() {
        // The second sample has a prior snapshot, so rates are computed; they
        // must be finite and non-negative on any machine.
        let mut collector = LocalCollector::new();
        let _first = collector.collect("test").expect("first collect");
        let second = collector.collect("test").expect("second collect");
        assert!(
            second.net_rx_bytes_per_sec.is_finite() && second.net_rx_bytes_per_sec >= 0.0,
            "net_rx_bytes_per_sec invalid: {}",
            second.net_rx_bytes_per_sec
        );
        assert!(
            second.net_tx_bytes_per_sec.is_finite() && second.net_tx_bytes_per_sec >= 0.0,
            "net_tx_bytes_per_sec invalid: {}",
            second.net_tx_bytes_per_sec
        );
    }

    #[test]
    fn local_collector_second_sample_has_cpu() {
        // The first sample primes the counters; the second should reflect
        // real usage (> 0 on any active machine, though we only verify it's valid).
        let mut collector = LocalCollector::new();
        let _first = collector.collect("test").expect("first collect");
        let second = collector.collect("test").expect("second collect");
        assert!(
            (0.0..=100.0).contains(&second.cpu_usage_percent),
            "cpu_usage_percent out of range on second sample: {}",
            second.cpu_usage_percent
        );
    }

    #[test]
    fn local_collector_disk_stats_nonzero() {
        let mut collector = LocalCollector::new();
        let stats = collector.collect("test").expect("collect");
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
