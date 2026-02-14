use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use ssh2::Session;

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;

/// System statistics retrieved from a remote Linux host.
#[derive(Debug, Clone, Serialize)]
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

/// A monitoring session holding a dedicated SSH connection.
///
/// Uses blocking mode, same pattern as `SftpSession`.
pub struct MonitoringSession {
    session: Session,
}

impl MonitoringSession {
    /// Open a new monitoring session to the given SSH host.
    pub fn new(config: &SshConfig) -> Result<Self, TerminalError> {
        let session = connect_and_authenticate(config)?;
        session.set_blocking(true);

        Ok(Self { session })
    }

    /// Execute a command over SSH and return stdout as a string.
    fn exec(&self, command: &str) -> Result<String, TerminalError> {
        let mut channel = self
            .session
            .channel_session()
            .map_err(|e| TerminalError::SshError(format!("Channel open failed: {}", e)))?;

        channel
            .exec(command)
            .map_err(|e| TerminalError::SshError(format!("Exec failed: {}", e)))?;

        let mut output = String::new();
        channel
            .read_to_string(&mut output)
            .map_err(|e| TerminalError::SshError(format!("Read failed: {}", e)))?;

        channel.wait_close().ok();

        Ok(output)
    }

    /// Fetch system statistics from the remote host.
    pub fn fetch_stats(&self) -> Result<SystemStats, TerminalError> {
        let output = self.exec(
            "hostname && cat /proc/loadavg && cat /proc/meminfo && cat /proc/uptime && df -Pk / && uname -sr",
        )?;

        parse_stats(&output)
    }
}

/// Parse the combined command output into `SystemStats`.
fn parse_stats(output: &str) -> Result<SystemStats, TerminalError> {
    let lines: Vec<&str> = output.lines().collect();
    if lines.len() < 6 {
        return Err(TerminalError::SshError(
            "Unexpected monitoring output format".to_string(),
        ));
    }

    // Line 0: hostname
    let hostname = lines[0].trim().to_string();

    // Line 1: /proc/loadavg — "0.15 0.10 0.05 1/234 5678"
    let load_parts: Vec<&str> = lines[1].split_whitespace().collect();
    let load_average = [
        load_parts.first().and_then(|s| s.parse().ok()).unwrap_or(0.0),
        load_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0),
        load_parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0),
    ];

    // Lines 2+: /proc/meminfo — find MemTotal and MemAvailable
    let mut mem_total_kb: u64 = 0;
    let mut mem_available_kb: u64 = 0;
    let mut meminfo_end = 2;

    for (i, line) in lines.iter().enumerate().skip(2) {
        if line.starts_with("MemTotal:") {
            mem_total_kb = parse_meminfo_value(line);
        } else if line.starts_with("MemAvailable:") {
            mem_available_kb = parse_meminfo_value(line);
        }
        // /proc/uptime line starts with a digit — signals end of meminfo
        if !line.contains(':') && line.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            // Check if this looks like uptime (two floats)
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() == 2 && parts[0].contains('.') && parts[1].contains('.') {
                meminfo_end = i;
                break;
            }
        }
    }

    // uptime line: "12345.67 89012.34"
    let uptime_line = lines.get(meminfo_end).unwrap_or(&"0 0");
    let uptime_parts: Vec<&str> = uptime_line.split_whitespace().collect();
    let uptime_seconds: f64 = uptime_parts
        .first()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    // CPU usage: use 1-minute load average as a practical indicator.
    // /proc/uptime idle_seconds is cumulative across all CPUs, making it
    // unreliable as a point-in-time metric without knowing the CPU count.
    let raw_cpu = load_average[0] * 100.0_f64;
    let cpu_usage_percent = if raw_cpu > 100.0 { 100.0 } else { raw_cpu };

    let memory_used_percent = if mem_total_kb > 0 {
        let used = mem_total_kb.saturating_sub(mem_available_kb);
        (used as f64 / mem_total_kb as f64) * 100.0
    } else {
        0.0
    };

    // df output: find the data line (skip header "Filesystem 1024-blocks Used Available Capacity Mounted on")
    let mut disk_total_kb: u64 = 0;
    let mut disk_used_kb: u64 = 0;
    let mut disk_used_percent: f64 = 0.0;

    for line in lines.iter().skip(meminfo_end + 1) {
        if line.starts_with("Filesystem") || line.trim().is_empty() {
            continue;
        }
        // uname line — skip it
        if !line.starts_with('/') {
            // Could be the uname line — check if it starts with "Linux" or similar
            if line.starts_with("Linux")
                || line.starts_with("Darwin")
                || line.starts_with("FreeBSD")
            {
                continue;
            }
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 5 {
            disk_total_kb = parts[1].parse().unwrap_or(0);
            disk_used_kb = parts[2].parse().unwrap_or(0);
            // parts[4] is like "42%"
            disk_used_percent = parts[4]
                .trim_end_matches('%')
                .parse()
                .unwrap_or(0.0);
            break;
        }
    }

    // uname -sr: last non-empty line
    let os_info = lines
        .iter()
        .rev()
        .find(|l| {
            let trimmed = l.trim();
            !trimmed.is_empty() && !trimmed.starts_with('/')
        })
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    Ok(SystemStats {
        hostname,
        uptime_seconds,
        load_average,
        cpu_usage_percent,
        memory_total_kb: mem_total_kb,
        memory_available_kb: mem_available_kb,
        memory_used_percent,
        disk_total_kb,
        disk_used_kb,
        disk_used_percent,
        os_info,
    })
}

/// Extract the numeric kB value from a `/proc/meminfo` line like "MemTotal:       16384000 kB".
fn parse_meminfo_value(line: &str) -> u64 {
    line.split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// Manages multiple monitoring sessions keyed by UUID.
pub struct MonitoringManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<MonitoringSession>>>>,
}

impl MonitoringManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
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
    pub fn get_session(
        &self,
        id: &str,
    ) -> Result<Arc<Mutex<MonitoringSession>>, TerminalError> {
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

    #[test]
    fn parse_stats_basic() {
        let output = "\
myhost
0.15 0.10 0.05 1/234 5678
MemTotal:       16384000 kB
MemFree:         8000000 kB
MemAvailable:   12000000 kB
Buffers:          500000 kB
Cached:          3000000 kB
12345.67 45678.90
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        50000000  20000000  28000000      42% /
Linux 5.15.0";

        let stats = parse_stats(output).unwrap();
        assert_eq!(stats.hostname, "myhost");
        assert!((stats.load_average[0] - 0.15).abs() < 0.001);
        assert!((stats.load_average[1] - 0.10).abs() < 0.001);
        assert!((stats.load_average[2] - 0.05).abs() < 0.001);
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
        let output = "myhost\n0.15 0.10 0.05";
        assert!(parse_stats(output).is_err());
    }

    #[test]
    fn parse_stats_memory_used_percent() {
        let output = "\
testhost
1.00 0.50 0.25 2/100 1234
MemTotal:       8000000 kB
MemFree:        1000000 kB
MemAvailable:   2000000 kB
1000.50 2000.00
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        100000000  60000000  38000000      60% /
Linux 6.1.0";

        let stats = parse_stats(output).unwrap();
        // used = 8000000 - 2000000 = 6000000, percent = 75%
        assert!((stats.memory_used_percent - 75.0).abs() < 0.1);
        assert!((stats.disk_used_percent - 60.0).abs() < 0.1);
    }
}
