//! Monitoring data types shared between the desktop and agent crates.

use serde::{Deserialize, Serialize};

/// Where a [`SystemStats`] sample came from (#3202).
///
/// Most hosts are sampled from `/proc` (or `sysinfo` locally). A container with
/// no shell / no readable `/proc` (distroless) falls back to the Docker Engine
/// stats API, which reports a narrower set of metrics — the UI labels such
/// samples "via Docker stats" and shows the metrics it cannot supply as
/// unavailable (see [`SystemStats::unavailable_metrics`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum StatsSource {
    /// Host/container `/proc` (or `sysinfo` for the local machine). The default,
    /// so samples from older agents deserialize as `/proc`-sourced.
    #[default]
    Proc,
    /// The Docker Engine container-stats API (`docker stats`).
    DockerStats,
}

/// A metric a [`SystemStats`] sample could not supply (#3202).
///
/// Listed in [`SystemStats::unavailable_metrics`] so the UI renders the metric
/// as "unavailable" instead of a misleading zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum StatsMetric {
    /// Aggregate CPU usage.
    Cpu,
    /// Memory usage / limit.
    Memory,
    /// Network throughput.
    Network,
    /// Host uptime.
    Uptime,
    /// 1/5/15-minute load average.
    LoadAverage,
    /// Root filesystem usage.
    Disk,
    /// Swap usage.
    Swap,
    /// Per-core CPU usage.
    PerCoreCpu,
    /// Kernel / OS description.
    OsInfo,
    /// The process list (it needs an exec inside the target).
    Processes,
}

/// Parsed system statistics from a local or remote host.
///
/// Fields use `camelCase` serialization to match the JSON convention used
/// by both the desktop frontend and the agent protocol.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub hostname: String,
    pub uptime_seconds: f64,
    pub load_average: [f64; 3],
    pub cpu_usage_percent: f64,
    #[cfg_attr(test, ts(type = "number"))]
    pub memory_total_kb: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub memory_available_kb: u64,
    pub memory_used_percent: f64,
    #[cfg_attr(test, ts(type = "number"))]
    pub disk_total_kb: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub disk_used_kb: u64,
    pub disk_used_percent: f64,
    pub os_info: String,
    /// Total swap space in kB. `0` when the host has no swap or the metric is
    /// unavailable (older agents / non-Linux SSH remotes) — never an error.
    #[serde(default)]
    #[cfg_attr(test, ts(type = "number"))]
    pub swap_total_kb: u64,
    /// Used swap space in kB. `0` when unavailable (see [`Self::swap_total_kb`]).
    #[serde(default)]
    #[cfg_attr(test, ts(type = "number"))]
    pub swap_used_kb: u64,
    /// Percentage of swap in use (0.0–100.0). `0.0` when unavailable.
    #[serde(default)]
    pub swap_used_percent: f64,
    /// Network receive throughput in bytes/sec, averaged over the last collection
    /// interval. `0.0` on the first sample (no prior delta) or when unavailable.
    #[serde(default)]
    pub net_rx_bytes_per_sec: f64,
    /// Network transmit throughput in bytes/sec (see [`Self::net_rx_bytes_per_sec`]).
    #[serde(default)]
    pub net_tx_bytes_per_sec: f64,
    /// Per-logical-core CPU usage percentage (0.0–100.0), one entry per core in
    /// core order. Empty when the metric is unavailable — a non-Linux SSH remote
    /// (only `/proc/stat` supplies per-core lines) or an older agent that never
    /// sends the field. `0.0` for every core on the first sample (no prior delta).
    #[serde(default)]
    pub per_core_cpu_percent: Vec<f64>,
    /// Which collector produced this sample (#3202). Defaults to
    /// [`StatsSource::Proc`] when absent (older agents).
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<StatsSource>", optional))]
    pub source: StatsSource,
    /// Metrics this sample could not supply (#3202). Their numeric fields hold
    /// placeholder zeros that must be rendered as "unavailable", never as data.
    /// Empty for a full `/proc` sample.
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<Vec<StatsMetric>>", optional))]
    pub unavailable_metrics: Vec<StatsMetric>,
    /// Block-device read throughput in bytes/sec (#3202). Only the Docker stats
    /// source reports it; absent otherwise. `0.0` on the first sample.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub block_read_bytes_per_sec: Option<f64>,
    /// Block-device write throughput in bytes/sec (see
    /// [`Self::block_read_bytes_per_sec`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub block_write_bytes_per_sec: Option<f64>,
    /// Number of processes/threads in the container's PID cgroup (#3202). Only
    /// the Docker stats source reports it; absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "number"))]
    pub pids_current: Option<u64>,
}

impl SystemStats {
    /// Whether `metric` is listed as unavailable for this sample.
    pub fn is_unavailable(&self, metric: StatsMetric) -> bool {
        self.unavailable_metrics.contains(&metric)
    }
}

/// Cumulative block-I/O byte counters (read/write), summed across devices.
///
/// Monotonic totals from the Docker stats API; callers diff two snapshots to
/// derive the per-second throughput carried in [`SystemStats`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BlockIoCounters {
    pub read_bytes: u64,
    pub write_bytes: u64,
}

/// Cumulative CPU time counters parsed from the aggregate `cpu` line in `/proc/stat`.
#[derive(Debug, Clone, Default)]
pub struct CpuCounters {
    pub user: u64,
    pub nice: u64,
    pub system: u64,
    pub idle: u64,
    pub iowait: u64,
    pub irq: u64,
    pub softirq: u64,
    pub steal: u64,
}

impl CpuCounters {
    /// Total CPU time across all fields.
    pub fn total(&self) -> u64 {
        self.user
            + self.nice
            + self.system
            + self.idle
            + self.iowait
            + self.irq
            + self.softirq
            + self.steal
    }

    /// Idle CPU time (idle + iowait).
    pub fn idle_total(&self) -> u64 {
        self.idle + self.iowait
    }
}

/// Cumulative network byte counters, summed across all non-loopback interfaces.
///
/// These are monotonic totals (as reported by `/proc/net/dev` or `sysinfo`), not
/// rates. Callers diff two snapshots over the elapsed interval to derive the
/// per-second throughput carried in [`SystemStats`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NetCounters {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_counters_total() {
        let c = CpuCounters {
            user: 100,
            nice: 10,
            system: 50,
            idle: 800,
            iowait: 20,
            irq: 5,
            softirq: 10,
            steal: 5,
        };
        assert_eq!(c.total(), 1000);
    }

    #[test]
    fn cpu_counters_idle_total() {
        let c = CpuCounters {
            idle: 800,
            iowait: 20,
            ..Default::default()
        };
        assert_eq!(c.idle_total(), 820);
    }

    #[test]
    fn cpu_counters_default() {
        let c = CpuCounters::default();
        assert_eq!(c.user, 0);
        assert_eq!(c.nice, 0);
        assert_eq!(c.system, 0);
        assert_eq!(c.idle, 0);
        assert_eq!(c.iowait, 0);
        assert_eq!(c.irq, 0);
        assert_eq!(c.softirq, 0);
        assert_eq!(c.steal, 0);
        assert_eq!(c.total(), 0);
        assert_eq!(c.idle_total(), 0);
    }

    #[test]
    fn system_stats_serde_roundtrip() {
        let stats = SystemStats {
            hostname: "myhost".to_string(),
            uptime_seconds: 12345.67,
            load_average: [0.15, 0.10, 0.05],
            cpu_usage_percent: 42.5,
            memory_total_kb: 16384000,
            memory_available_kb: 12000000,
            memory_used_percent: 26.7,
            disk_total_kb: 50000000,
            disk_used_kb: 20000000,
            disk_used_percent: 40.0,
            os_info: "Linux 5.15.0".to_string(),
            swap_total_kb: 2000000,
            swap_used_kb: 500000,
            swap_used_percent: 25.0,
            net_rx_bytes_per_sec: 1024.0,
            net_tx_bytes_per_sec: 2048.0,
            per_core_cpu_percent: vec![10.0, 90.0],
            ..Default::default()
        };

        let json = serde_json::to_string(&stats).unwrap();
        // Verify camelCase serialization
        assert!(json.contains("\"uptimeSeconds\""));
        assert!(json.contains("\"loadAverage\""));
        assert!(json.contains("\"cpuUsagePercent\""));
        assert!(json.contains("\"memoryTotalKb\""));
        assert!(json.contains("\"memoryAvailableKb\""));
        assert!(json.contains("\"memoryUsedPercent\""));
        assert!(json.contains("\"diskTotalKb\""));
        assert!(json.contains("\"diskUsedKb\""));
        assert!(json.contains("\"diskUsedPercent\""));
        assert!(json.contains("\"osInfo\""));
        assert!(json.contains("\"swapTotalKb\""));
        assert!(json.contains("\"swapUsedKb\""));
        assert!(json.contains("\"swapUsedPercent\""));
        assert!(json.contains("\"netRxBytesPerSec\""));
        assert!(json.contains("\"netTxBytesPerSec\""));
        assert!(json.contains("\"perCoreCpuPercent\""));

        let deserialized: SystemStats = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.hostname, "myhost");
        assert!((deserialized.uptime_seconds - 12345.67).abs() < 0.01);
        assert!((deserialized.cpu_usage_percent - 42.5).abs() < 0.01);
        assert_eq!(deserialized.memory_total_kb, 16384000);
        assert_eq!(deserialized.os_info, "Linux 5.15.0");
        assert_eq!(deserialized.swap_total_kb, 2000000);
        assert_eq!(deserialized.swap_used_kb, 500000);
        assert!((deserialized.swap_used_percent - 25.0).abs() < 0.01);
        assert!((deserialized.net_rx_bytes_per_sec - 1024.0).abs() < 0.01);
        assert!((deserialized.net_tx_bytes_per_sec - 2048.0).abs() < 0.01);
        assert_eq!(deserialized.per_core_cpu_percent, vec![10.0, 90.0]);
    }

    /// New metrics fields default to 0 when absent from the JSON, so stats from
    /// an older agent (which never sends them) deserialize without error and
    /// simply read as "no swap / no network data" (graceful degradation).
    #[test]
    fn system_stats_deserializes_without_new_fields() {
        let legacy = r#"{
            "hostname": "old",
            "uptimeSeconds": 1.0,
            "loadAverage": [0.0, 0.0, 0.0],
            "cpuUsagePercent": 0.0,
            "memoryTotalKb": 1000,
            "memoryAvailableKb": 500,
            "memoryUsedPercent": 50.0,
            "diskTotalKb": 2000,
            "diskUsedKb": 1000,
            "diskUsedPercent": 50.0,
            "osInfo": "Linux 4.0.0"
        }"#;
        let stats: SystemStats = serde_json::from_str(legacy).unwrap();
        assert_eq!(stats.swap_total_kb, 0);
        assert_eq!(stats.swap_used_kb, 0);
        assert_eq!(stats.swap_used_percent, 0.0);
        assert_eq!(stats.net_rx_bytes_per_sec, 0.0);
        assert_eq!(stats.net_tx_bytes_per_sec, 0.0);
        assert!(stats.per_core_cpu_percent.is_empty());
    }
}
