//! Container-engine stats fallback for exec-based monitoring (#3202).
//!
//! The `/proc` path ([`ExecMonitoringProvider`](super::ExecMonitoringProvider))
//! needs a shell and a readable `/proc` inside the target. Distroless and other
//! minimal images have neither, so for those the provider falls back to the
//! container engine's own stats API (`docker stats`). That API reports cumulative
//! cgroup counters — CPU time, memory usage + limit, network and block-I/O bytes,
//! PIDs — but nothing about load average, uptime, filesystems, swap, per-core CPU
//! or the process list.
//!
//! This module is engine-neutral: a backend maps its engine payload into a
//! [`ContainerStatsSample`] (the Docker backend does it from bollard's `Stats`),
//! and [`ContainerStatsTrackers`] turns consecutive samples into a
//! [`SystemStats`] tagged [`StatsSource::DockerStats`], listing every metric it
//! cannot supply in [`SystemStats::unavailable_metrics`] instead of fabricating
//! zeros.

use std::time::Instant;

use crate::errors::CoreError;
use crate::monitoring::{
    BlockIoCounters, NetCounters, NetDeltaTracker, StatsMetric, StatsSource, SystemStats,
};

/// Metrics the container stats API can never supply.
const ALWAYS_UNAVAILABLE: [StatsMetric; 7] = [
    StatsMetric::Uptime,
    StatsMetric::LoadAverage,
    StatsMetric::Disk,
    StatsMetric::Swap,
    StatsMetric::PerCoreCpu,
    StatsMetric::OsInfo,
    StatsMetric::Processes,
];

/// Cumulative CPU counters from one container stats sample, in nanoseconds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ContainerCpuCounters {
    /// CPU time consumed by the container's cgroup.
    pub container_ns: u64,
    /// CPU time elapsed on the whole host (summed across all host CPUs).
    pub system_ns: u64,
}

/// One engine-neutral container stats sample: cumulative counters plus gauges.
///
/// Every field the engine did not report is `None`; the matching metric is then
/// listed as unavailable rather than rendered as zero.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ContainerStatsSample {
    /// Display name of the container (used as the monitor's hostname).
    pub name: String,
    /// Cumulative CPU counters, when the engine reported both of them.
    pub cpu: Option<ContainerCpuCounters>,
    /// Memory in use, in bytes (page cache that can be reclaimed excluded).
    pub memory_used_bytes: Option<u64>,
    /// Memory limit, in bytes (the host's memory when the container is unlimited).
    pub memory_limit_bytes: Option<u64>,
    /// Cumulative network byte counters summed over the container's interfaces.
    pub net: Option<NetCounters>,
    /// Cumulative block-I/O byte counters summed over devices.
    pub block_io: Option<BlockIoCounters>,
    /// Current number of PIDs in the container's cgroup.
    pub pids: Option<u64>,
}

/// Async source of container-engine stats for one container.
#[async_trait::async_trait]
pub trait ContainerStatsSource: Send + Sync + 'static {
    /// Fetch one stats sample for the container.
    async fn collect_container_stats(&self) -> Result<ContainerStatsSample, CoreError>;
}

/// CPU share of the whole host between two samples, 0.0–100.0.
///
/// `container Δ / host Δ × 100` — the same host-normalized scale the `/proc`
/// path reports, so the status-bar severity thresholds apply unchanged. Returns
/// `0.0` when the host counter did not advance or went backwards (a counter
/// reset), never a negative or `NaN` value.
pub fn container_cpu_percent(prev: ContainerCpuCounters, cur: ContainerCpuCounters) -> f64 {
    let system_delta = cur.system_ns.saturating_sub(prev.system_ns);
    if system_delta == 0 {
        return 0.0;
    }
    let container_delta = cur.container_ns.saturating_sub(prev.container_ns);
    (container_delta as f64 / system_delta as f64 * 100.0).clamp(0.0, 100.0)
}

/// Per-subscription delta state for the container stats path.
///
/// CPU and I/O rates come from differencing consecutive samples, so the first
/// sample primes the trackers and reports CPU 0 / rate 0 — the same priming
/// contract as the `/proc` path.
#[derive(Default)]
pub struct ContainerStatsTrackers {
    prev_cpu: Option<ContainerCpuCounters>,
    net: NetDeltaTracker,
    block_io: NetDeltaTracker,
}

impl ContainerStatsTrackers {
    /// Create trackers with no baseline.
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold `sample`, observed at `now`, into a [`SystemStats`].
    pub fn apply(&mut self, sample: ContainerStatsSample, now: Instant) -> SystemStats {
        let mut unavailable: Vec<StatsMetric> = ALWAYS_UNAVAILABLE.to_vec();
        let mut stats = SystemStats {
            hostname: sample.name,
            source: StatsSource::DockerStats,
            pids_current: sample.pids,
            ..Default::default()
        };

        match sample.cpu {
            Some(cur) => {
                if let Some(prev) = self.prev_cpu.replace(cur) {
                    stats.cpu_usage_percent = container_cpu_percent(prev, cur);
                }
            }
            None => unavailable.push(StatsMetric::Cpu),
        }

        match (sample.memory_used_bytes, sample.memory_limit_bytes) {
            (Some(used), Some(limit)) if limit > 0 => {
                let used = used.min(limit);
                stats.memory_total_kb = limit / 1024;
                stats.memory_available_kb = (limit - used) / 1024;
                stats.memory_used_percent = used as f64 / limit as f64 * 100.0;
            }
            _ => unavailable.push(StatsMetric::Memory),
        }

        match sample.net {
            Some(net) => {
                let (rx, tx) = self.net.update(net, now);
                stats.net_rx_bytes_per_sec = rx;
                stats.net_tx_bytes_per_sec = tx;
            }
            None => unavailable.push(StatsMetric::Network),
        }

        if let Some(io) = sample.block_io {
            // The net tracker's rx/tx pair doubles as read/write here.
            let as_pair = NetCounters {
                rx_bytes: io.read_bytes,
                tx_bytes: io.write_bytes,
            };
            let (read, write) = self.block_io.update(as_pair, now);
            stats.block_read_bytes_per_sec = Some(read);
            stats.block_write_bytes_per_sec = Some(write);
        }

        stats.unavailable_metrics = unavailable;
        stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn cpu(container_ns: u64, system_ns: u64) -> ContainerCpuCounters {
        ContainerCpuCounters {
            container_ns,
            system_ns,
        }
    }

    fn full_sample(cpu_counters: ContainerCpuCounters, rx: u64, read: u64) -> ContainerStatsSample {
        ContainerStatsSample {
            name: "distroless-app".to_string(),
            cpu: Some(cpu_counters),
            memory_used_bytes: Some(256 * 1024 * 1024),
            memory_limit_bytes: Some(1024 * 1024 * 1024),
            net: Some(NetCounters {
                rx_bytes: rx,
                tx_bytes: rx / 2,
            }),
            block_io: Some(BlockIoCounters {
                read_bytes: read,
                write_bytes: read / 4,
            }),
            pids: Some(7),
        }
    }

    #[test]
    fn cpu_percent_is_container_share_of_host_delta() {
        // 0.5 s of container CPU over 10 s of host CPU time = 5 %.
        let pct =
            container_cpu_percent(cpu(1_000, 1_000), cpu(501_000_000 + 1_000, 10_000_001_000));
        assert!((pct - 5.01).abs() < 0.01, "got {pct}");
    }

    #[test]
    fn cpu_percent_is_zero_when_host_counter_does_not_advance() {
        assert_eq!(container_cpu_percent(cpu(10, 100), cpu(20, 100)), 0.0);
    }

    #[test]
    fn cpu_percent_is_zero_on_counter_reset() {
        assert_eq!(container_cpu_percent(cpu(500, 1_000), cpu(10, 50)), 0.0);
    }

    #[test]
    fn cpu_percent_clamps_to_100() {
        assert_eq!(container_cpu_percent(cpu(0, 0), cpu(500, 100)), 100.0);
    }

    #[test]
    fn first_sample_primes_cpu_and_rates_to_zero() {
        let mut t = ContainerStatsTrackers::new();
        let stats = t.apply(full_sample(cpu(100, 1_000), 5_000, 8_000), Instant::now());
        assert_eq!(stats.source, StatsSource::DockerStats);
        assert_eq!(stats.hostname, "distroless-app");
        assert_eq!(stats.cpu_usage_percent, 0.0);
        assert_eq!(stats.net_rx_bytes_per_sec, 0.0);
        assert_eq!(stats.block_read_bytes_per_sec, Some(0.0));
        assert_eq!(stats.pids_current, Some(7));
    }

    #[test]
    fn second_sample_derives_cpu_network_and_block_io_rates() {
        let mut t = ContainerStatsTrackers::new();
        let t0 = Instant::now();
        t.apply(full_sample(cpu(0, 0), 1_000, 4_000), t0);
        let stats = t.apply(
            full_sample(cpu(250, 1_000), 3_000, 8_000),
            t0 + Duration::from_secs(2),
        );
        assert!((stats.cpu_usage_percent - 25.0).abs() < 1e-9);
        assert!((stats.net_rx_bytes_per_sec - 1_000.0).abs() < 1e-9);
        assert!((stats.net_tx_bytes_per_sec - 500.0).abs() < 1e-9);
        assert!((stats.block_read_bytes_per_sec.unwrap() - 2_000.0).abs() < 1e-9);
        assert!((stats.block_write_bytes_per_sec.unwrap() - 500.0).abs() < 1e-9);
    }

    #[test]
    fn memory_maps_usage_and_limit() {
        let mut t = ContainerStatsTrackers::new();
        let stats = t.apply(full_sample(cpu(0, 0), 0, 0), Instant::now());
        assert_eq!(stats.memory_total_kb, 1024 * 1024);
        assert_eq!(stats.memory_available_kb, 768 * 1024);
        assert!((stats.memory_used_percent - 25.0).abs() < 1e-9);
        assert!(!stats.is_unavailable(StatsMetric::Memory));
    }

    #[test]
    fn stats_api_gaps_are_listed_unavailable_not_zeroed_as_data() {
        let mut t = ContainerStatsTrackers::new();
        let stats = t.apply(full_sample(cpu(0, 0), 0, 0), Instant::now());
        for metric in ALWAYS_UNAVAILABLE {
            assert!(
                stats.is_unavailable(metric),
                "{metric:?} must be unavailable"
            );
        }
        assert!(!stats.is_unavailable(StatsMetric::Cpu));
        assert!(!stats.is_unavailable(StatsMetric::Network));
    }

    #[test]
    fn missing_fields_are_unavailable() {
        let mut t = ContainerStatsTrackers::new();
        let sample = ContainerStatsSample {
            name: "bare".to_string(),
            ..Default::default()
        };
        let stats = t.apply(sample, Instant::now());
        assert!(stats.is_unavailable(StatsMetric::Cpu));
        assert!(stats.is_unavailable(StatsMetric::Memory));
        assert!(stats.is_unavailable(StatsMetric::Network));
        assert_eq!(stats.block_read_bytes_per_sec, None);
        assert_eq!(stats.pids_current, None);
    }

    #[test]
    fn zero_memory_limit_is_unavailable() {
        let mut t = ContainerStatsTrackers::new();
        let sample = ContainerStatsSample {
            memory_used_bytes: Some(10),
            memory_limit_bytes: Some(0),
            ..Default::default()
        };
        assert!(t
            .apply(sample, Instant::now())
            .is_unavailable(StatsMetric::Memory));
    }

    #[test]
    fn usage_above_limit_is_capped_at_100_percent() {
        let mut t = ContainerStatsTrackers::new();
        let sample = ContainerStatsSample {
            memory_used_bytes: Some(4096),
            memory_limit_bytes: Some(2048),
            ..Default::default()
        };
        let stats = t.apply(sample, Instant::now());
        assert_eq!(stats.memory_available_kb, 0);
        assert!((stats.memory_used_percent - 100.0).abs() < 1e-9);
    }
}
