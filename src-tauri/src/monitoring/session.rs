use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use termihub_core::errors::CoreError;
use termihub_core::monitoring::{
    cpu_percent_from_delta, parse_stats, CpuCounters, StatsCollector, SystemStats,
    MONITORING_COMMAND,
};

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;
use crate::utils::remote_exec::run_remote_command;
use crate::utils::ssh_auth::connect_and_authenticate;
use termihub_core::backends::ssh::handler::SshSession;

/// Legacy monitoring session holding a dedicated SSH connection.
///
/// The canonical implementation is now
/// [`termihub_core::backends::ssh::SshMonitoringProvider`](termihub_core::backends::ssh)
/// which implements the unified `MonitoringProvider` trait. This struct
/// will be removed once monitoring is migrated to use `ConnectionType`.
pub struct MonitoringSession {
    session: SshSession,
    /// Previous `/proc/stat` CPU counters for delta-based CPU% calculation.
    prev_cpu: Option<CpuCounters>,
}

impl MonitoringSession {
    /// Open a new monitoring session to the given SSH host.
    pub fn new(config: &SshConfig) -> Result<Self, TerminalError> {
        let session = connect_and_authenticate(config)?;
        Ok(Self {
            session,
            prev_cpu: None,
        })
    }

    /// Fetch system statistics from the remote host.
    ///
    /// CPU usage is computed from `/proc/stat` deltas between consecutive calls.
    /// The first call returns 0% since there is no previous snapshot to compare against.
    pub fn fetch_stats(&mut self) -> Result<SystemStats, TerminalError> {
        let output = run_remote_command(&self.session, MONITORING_COMMAND)?;

        let (mut stats, counters) =
            parse_stats(&output).map_err(|e| TerminalError::SshError(e.to_string()))?;

        if let Some(prev) = &self.prev_cpu {
            stats.cpu_usage_percent = cpu_percent_from_delta(prev, &counters);
        }
        self.prev_cpu = Some(counters);

        Ok(stats)
    }
}

impl StatsCollector for MonitoringSession {
    fn collect(&mut self, _host_label: &str) -> Result<SystemStats, CoreError> {
        self.fetch_stats()
            .map_err(|e| CoreError::Other(e.to_string()))
    }
}

/// Manages multiple monitoring sessions keyed by UUID.
#[derive(Clone)]
pub struct MonitoringManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<MonitoringSession>>>>>,
}

impl MonitoringManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Open a new monitoring session. Returns the session UUID.
    pub fn open_session(&self, config: &SshConfig) -> Result<String, TerminalError> {
        let session = MonitoringSession::new(config)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(id.clone(), Arc::new(Mutex::new(session)));
        Ok(id)
    }

    /// Close and drop a monitoring session.
    pub fn close_session(&self, id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.remove(id);
    }

    /// Get a session Arc for use outside the manager lock.
    pub fn get_session(&self, id: &str) -> Result<Arc<Mutex<MonitoringSession>>, TerminalError> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .get(id)
            .cloned()
            .ok_or_else(|| TerminalError::MonitoringSessionNotFound(id.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_core::monitoring::{parse_cpu_line, parse_meminfo_value};

    fn _assert_stats_collector<T: StatsCollector>() {}

    #[test]
    fn monitoring_session_satisfies_stats_collector() {
        _assert_stats_collector::<MonitoringSession>();
    }

    fn sample_output(cpu_line: &str) -> String {
        format!(
            "\
myhost
0.15 0.10 0.05 1/234 5678
{cpu_line}
MemTotal:       16384000 kB
MemFree:         8000000 kB
MemAvailable:   12000000 kB
Buffers:          500000 kB
Cached:          3000000 kB
12345.67 45678.90
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        50000000  20000000  28000000      42% /
Linux 5.15.0"
        )
    }

    #[test]
    fn parse_stats_basic() {
        let output = sample_output("cpu  10000 500 3000 80000 1000 0 200 0 0 0");
        let (stats, counters) = parse_stats(&output).unwrap();
        assert_eq!(stats.hostname, "myhost");
        assert!((stats.load_average[0] - 0.15).abs() < 0.001);
        assert!((stats.cpu_usage_percent - 0.0).abs() < 0.001);
        assert_eq!(counters.user, 10000);
        assert_eq!(counters.idle, 80000);
        assert_eq!(stats.memory_total_kb, 16384000);
        assert_eq!(stats.memory_available_kb, 12000000);
        assert!((stats.uptime_seconds - 12345.67).abs() < 0.01);
        assert_eq!(stats.disk_total_kb, 50000000);
        assert_eq!(stats.disk_used_kb, 20000000);
        assert!((stats.disk_used_percent - 42.0).abs() < 0.1);
        assert_eq!(stats.os_info, "Linux 5.15.0");
    }

    #[test]
    fn parse_meminfo_value_extracts_number() {
        assert_eq!(parse_meminfo_value("MemTotal:       16384000 kB"), 16384000);
        assert_eq!(parse_meminfo_value("MemAvailable:   12000000 kB"), 12000000);
        assert_eq!(parse_meminfo_value("Invalid line"), 0);
    }

    #[test]
    fn parse_stats_too_few_lines() {
        let output = "myhost\n0.15 0.10 0.05\ncpu  0 0 0 0 0 0 0 0";
        assert!(parse_stats(output).is_err());
    }

    #[test]
    fn parse_cpu_line_parses_all_fields() {
        let counters =
            parse_cpu_line("cpu  10132153 290696 3084719 46828483 16683 0 25195 100 0 0");
        assert_eq!(counters.user, 10132153);
        assert_eq!(counters.nice, 290696);
        assert_eq!(counters.system, 3084719);
        assert_eq!(counters.idle, 46828483);
        assert_eq!(counters.iowait, 16683);
        assert_eq!(counters.irq, 0);
        assert_eq!(counters.softirq, 25195);
        assert_eq!(counters.steal, 100);
    }

    #[test]
    fn cpu_percent_delta_idle_system() {
        let prev = CpuCounters {
            user: 10,
            nice: 0,
            system: 10,
            idle: 70,
            iowait: 10,
            irq: 0,
            softirq: 0,
            steal: 0,
        };
        let curr = CpuCounters {
            user: 30,
            nice: 0,
            system: 30,
            idle: 110,
            iowait: 20,
            irq: 5,
            softirq: 5,
            steal: 0,
        };
        let pct = cpu_percent_from_delta(&prev, &curr);
        assert!((pct - 50.0).abs() < 0.01);
    }

    #[test]
    fn cpu_percent_delta_zero_total_returns_zero() {
        let counters = CpuCounters::default();
        let pct = cpu_percent_from_delta(&counters, &counters);
        assert!((pct - 0.0).abs() < 0.001);
    }

    #[test]
    fn cpu_percent_delta_full_load() {
        let prev = CpuCounters {
            idle: 100,
            iowait: 0,
            ..Default::default()
        };
        let curr = CpuCounters {
            user: 100,
            idle: 100,
            iowait: 0,
            ..Default::default()
        };
        let pct = cpu_percent_from_delta(&prev, &curr);
        assert!((pct - 100.0).abs() < 0.01);
    }

    #[test]
    fn cpu_percent_delta_fully_idle() {
        let prev = CpuCounters::default();
        let curr = CpuCounters {
            idle: 1000,
            ..Default::default()
        };
        let pct = cpu_percent_from_delta(&prev, &curr);
        assert!((pct - 0.0).abs() < 0.01);
    }

    #[test]
    fn parse_stats_memory_used_percent() {
        let output = "\
testhost
1.00 0.50 0.25 2/100 1234
cpu  5000 0 3000 80000 2000 0 0 0 0 0
MemTotal:       8000000 kB
MemFree:        1000000 kB
MemAvailable:   2000000 kB
1000.50 2000.00
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        100000000  60000000  38000000      60% /
Linux 6.1.0";

        let (stats, _) = parse_stats(output).unwrap();
        assert!((stats.memory_used_percent - 75.0).abs() < 0.1);
        assert!((stats.disk_used_percent - 60.0).abs() < 0.1);
    }
}
