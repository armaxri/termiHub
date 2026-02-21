//! Monitoring data types shared between the desktop and agent crates.

use serde::{Deserialize, Serialize};

/// Parsed system statistics from a Linux host.
///
/// Fields use `camelCase` serialization to match the JSON convention used
/// by both the desktop frontend and the agent protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub hostname: String,
    pub uptime_seconds: f64,
    pub load_average: [f64; 3],
    pub cpu_usage_percent: f64,
    pub memory_total_kb: u64,
    pub memory_available_kb: u64,
    pub memory_used_percent: f64,
    pub disk_total_kb: u64,
    pub disk_used_kb: u64,
    pub disk_used_percent: f64,
    pub os_info: String,
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

        let deserialized: SystemStats = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.hostname, "myhost");
        assert!((deserialized.uptime_seconds - 12345.67).abs() < 0.01);
        assert!((deserialized.cpu_usage_percent - 42.5).abs() < 0.01);
        assert_eq!(deserialized.memory_total_kb, 16384000);
        assert_eq!(deserialized.os_info, "Linux 5.15.0");
    }
}
