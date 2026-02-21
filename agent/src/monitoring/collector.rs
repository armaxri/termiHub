//! Stats collectors for local and remote hosts.

use std::io::Read;
use std::net::TcpStream;

use anyhow::{bail, Context, Result};
use tracing::debug;

use crate::protocol::methods::{MonitoringData, SshSessionConfig};

#[cfg(target_os = "linux")]
use super::parser::parse_cpu_line;
use super::parser::{cpu_percent_from_delta, parse_stats, CpuCounters};

/// The compound command executed on Linux hosts to gather all metrics
/// in a single round-trip.
const LINUX_MONITORING_COMMAND: &str =
    "hostname && cat /proc/loadavg && head -1 /proc/stat && cat /proc/meminfo && cat /proc/uptime && df -Pk / && uname -sr";

/// Collect system statistics from a host.
pub trait StatsCollector: Send {
    /// Collect a snapshot of system statistics.
    ///
    /// CPU usage is computed from `/proc/stat` deltas between consecutive
    /// calls. The first call returns 0% since there is no previous
    /// snapshot to compare against.
    fn collect(&mut self, host_label: &str) -> Result<MonitoringData>;
}

// ── Local collector ─────────────────────────────────────────────────

/// Collects system statistics from the agent's own host.
///
/// On Linux, reads `/proc/*` files directly and runs `df`, `hostname`,
/// and `uname` as subprocesses. On macOS, uses `sysctl`, `vm_stat`,
/// and `df`.
pub struct LocalCollector {
    // Used on Linux for delta-based CPU%, not used on macOS.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    prev_cpu: Option<CpuCounters>,
    /// Cached hostname (doesn't change at runtime).
    cached_hostname: Option<String>,
    /// Cached OS info (doesn't change at runtime).
    cached_os_info: Option<String>,
}

impl LocalCollector {
    pub fn new() -> Self {
        Self {
            prev_cpu: None,
            cached_hostname: None,
            cached_os_info: None,
        }
    }

    fn hostname(&mut self) -> String {
        if let Some(ref h) = self.cached_hostname {
            return h.clone();
        }
        let h = run_command("hostname", &[]).unwrap_or_else(|_| "unknown".to_string());
        let h = h.trim().to_string();
        self.cached_hostname = Some(h.clone());
        h
    }

    fn os_info(&mut self) -> String {
        if let Some(ref o) = self.cached_os_info {
            return o.clone();
        }
        let o = run_command("uname", &["-sr"]).unwrap_or_default();
        let o = o.trim().to_string();
        self.cached_os_info = Some(o.clone());
        o
    }
}

impl StatsCollector for LocalCollector {
    #[cfg(target_os = "linux")]
    fn collect(&mut self, host_label: &str) -> Result<MonitoringData> {
        collect_linux(self, host_label)
    }

    #[cfg(target_os = "macos")]
    fn collect(&mut self, host_label: &str) -> Result<MonitoringData> {
        collect_macos(self, host_label)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn collect(&mut self, _host_label: &str) -> Result<MonitoringData> {
        bail!("Local monitoring is not supported on this platform")
    }
}

/// Linux: read `/proc/*` directly and run `df`.
#[cfg(target_os = "linux")]
fn collect_linux(collector: &mut LocalCollector, host_label: &str) -> Result<MonitoringData> {
    // Read /proc files directly (faster than spawning processes)
    let loadavg =
        std::fs::read_to_string("/proc/loadavg").context("Failed to read /proc/loadavg")?;
    let stat_line = read_first_cpu_line().context("Failed to read /proc/stat")?;
    let meminfo =
        std::fs::read_to_string("/proc/meminfo").context("Failed to read /proc/meminfo")?;
    let uptime = std::fs::read_to_string("/proc/uptime").context("Failed to read /proc/uptime")?;
    let df_output = run_command("df", &["-Pk", "/"]).context("Failed to run df")?;

    // Parse load average
    let load_parts: Vec<&str> = loadavg.split_whitespace().collect();
    let load_average = [
        load_parts
            .first()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0),
        load_parts
            .get(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0),
        load_parts
            .get(2)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0),
    ];

    // Parse CPU counters
    let cpu_counters = parse_cpu_line(&stat_line);
    let cpu_usage_percent = match &collector.prev_cpu {
        Some(prev) => cpu_percent_from_delta(prev, &cpu_counters),
        None => 0.0,
    };
    collector.prev_cpu = Some(cpu_counters);

    // Parse memory
    let mut mem_total_kb: u64 = 0;
    let mut mem_available_kb: u64 = 0;
    for line in meminfo.lines() {
        if line.starts_with("MemTotal:") {
            mem_total_kb = super::parser::parse_meminfo_value(line);
        } else if line.starts_with("MemAvailable:") {
            mem_available_kb = super::parser::parse_meminfo_value(line);
        }
    }
    let memory_used_percent = if mem_total_kb > 0 {
        let used = mem_total_kb.saturating_sub(mem_available_kb);
        (used as f64 / mem_total_kb as f64) * 100.0
    } else {
        0.0
    };

    // Parse uptime
    let uptime_seconds: f64 = uptime
        .split_whitespace()
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    // Parse df output
    let (disk_total_kb, disk_used_kb, disk_used_percent) = parse_df_output(&df_output);

    Ok(MonitoringData {
        host: host_label.to_string(),
        hostname: collector.hostname(),
        uptime_seconds,
        load_average,
        cpu_usage_percent,
        memory_total_kb: mem_total_kb,
        memory_available_kb: mem_available_kb,
        memory_used_percent,
        disk_total_kb,
        disk_used_kb,
        disk_used_percent,
        os_info: collector.os_info(),
    })
}

/// Read the first `cpu` aggregate line from `/proc/stat`.
#[cfg(target_os = "linux")]
fn read_first_cpu_line() -> Result<String> {
    let content = std::fs::read_to_string("/proc/stat")?;
    content
        .lines()
        .find(|l| l.starts_with("cpu "))
        .map(|s| s.to_string())
        .context("No aggregate cpu line found in /proc/stat")
}

/// macOS: use sysctl, vm_stat, and df.
#[cfg(target_os = "macos")]
fn collect_macos(collector: &mut LocalCollector, host_label: &str) -> Result<MonitoringData> {
    // Load average
    let loadavg_str = run_command("sysctl", &["-n", "vm.loadavg"])
        .unwrap_or_else(|_| "{ 0.0 0.0 0.0 }".to_string());
    let load_average = parse_macos_loadavg(&loadavg_str);

    // Memory: total from hw.memsize, available estimated from vm_stat
    let mem_total_bytes: u64 = run_command("sysctl", &["-n", "hw.memsize"])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let mem_total_kb = mem_total_bytes / 1024;

    let vm_stat_output = run_command("vm_stat", &[]).unwrap_or_default();
    let mem_available_kb = parse_macos_vm_stat_available(&vm_stat_output);

    let memory_used_percent = if mem_total_kb > 0 {
        let used = mem_total_kb.saturating_sub(mem_available_kb);
        (used as f64 / mem_total_kb as f64) * 100.0
    } else {
        0.0
    };

    // Uptime from kern.boottime
    let uptime_seconds = parse_macos_uptime();

    // CPU: macOS doesn't have /proc/stat, use host_processor_info or
    // fall back to a simplified approach via `top -l 1`
    // For simplicity, we use sysctl kern.cp_time when available
    let cpu_usage_percent = 0.0; // macOS CPU tracking is best-effort
                                 // Note: delta-based CPU on macOS would require host_statistics() from mach,
                                 // which is complex. We leave it at 0.0 for now (load average is available).

    // Disk
    let df_output = run_command("df", &["-Pk", "/"]).unwrap_or_default();
    let (disk_total_kb, disk_used_kb, disk_used_percent) = parse_df_output(&df_output);

    Ok(MonitoringData {
        host: host_label.to_string(),
        hostname: collector.hostname(),
        uptime_seconds,
        load_average,
        cpu_usage_percent,
        memory_total_kb: mem_total_kb,
        memory_available_kb: mem_available_kb,
        memory_used_percent,
        disk_total_kb,
        disk_used_kb,
        disk_used_percent,
        os_info: collector.os_info(),
    })
}

/// Parse macOS load average from `sysctl -n vm.loadavg`.
/// Output format: `{ 1.23 0.45 0.67 }`
#[cfg(target_os = "macos")]
fn parse_macos_loadavg(output: &str) -> [f64; 3] {
    let trimmed = output.trim().trim_start_matches('{').trim_end_matches('}');
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    [
        parts.first().and_then(|s| s.parse().ok()).unwrap_or(0.0),
        parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0),
        parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0),
    ]
}

/// Parse available memory from macOS `vm_stat` output.
/// Returns available memory in KB.
#[cfg(target_os = "macos")]
fn parse_macos_vm_stat_available(output: &str) -> u64 {
    let page_size: u64 = run_command("sysctl", &["-n", "hw.pagesize"])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(4096);

    let mut free_pages: u64 = 0;
    let mut speculative_pages: u64 = 0;

    for line in output.lines() {
        if line.starts_with("Pages free:") {
            free_pages = extract_vm_stat_value(line);
        } else if line.starts_with("Pages speculative:") {
            speculative_pages = extract_vm_stat_value(line);
        }
    }

    (free_pages + speculative_pages) * page_size / 1024
}

/// Extract the numeric value from a vm_stat line like `"Pages free:                             1234."`.
#[cfg(target_os = "macos")]
fn extract_vm_stat_value(line: &str) -> u64 {
    line.split(':')
        .nth(1)
        .and_then(|s| s.trim().trim_end_matches('.').parse().ok())
        .unwrap_or(0)
}

/// Parse macOS uptime from `kern.boottime`.
#[cfg(target_os = "macos")]
fn parse_macos_uptime() -> f64 {
    let output = run_command("sysctl", &["-n", "kern.boottime"]).unwrap_or_default();
    // Format: "{ sec = 1234567890, usec = 123456 }"
    let sec: Option<u64> = output
        .split("sec = ")
        .nth(1)
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.trim().parse().ok());

    match sec {
        Some(boot_sec) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (now - boot_sec) as f64
        }
        None => 0.0,
    }
}

/// Parse df -Pk output to extract disk total, used, and used percent.
fn parse_df_output(output: &str) -> (u64, u64, f64) {
    for line in output.lines() {
        if line.starts_with("Filesystem") || line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 5 {
            let total: u64 = parts[1].parse().unwrap_or(0);
            let used: u64 = parts[2].parse().unwrap_or(0);
            let percent: f64 = parts[4].trim_end_matches('%').parse().unwrap_or(0.0);
            return (total, used, percent);
        }
    }
    (0, 0, 0.0)
}

/// Run a command and capture its stdout as a string.
fn run_command(cmd: &str, args: &[&str]) -> Result<String> {
    let output = std::process::Command::new(cmd)
        .args(args)
        .output()
        .with_context(|| format!("Failed to execute {cmd}"))?;

    if !output.status.success() {
        bail!("{cmd} exited with status {}", output.status);
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ── SSH collector ───────────────────────────────────────────────────

/// Collects system statistics from a remote Linux host via SSH exec.
///
/// Opens a persistent SSH connection and executes the monitoring
/// command on each collection cycle.
pub struct SshCollector {
    session: ssh2::Session,
    prev_cpu: Option<CpuCounters>,
}

// ssh2::Session contains raw pointers but is safe to send between
// threads when access is serialized (we only access from the
// monitoring task).
unsafe impl Send for SshCollector {}

impl SshCollector {
    /// Open a new SSH connection for monitoring.
    pub fn new(config: &SshSessionConfig) -> Result<Self> {
        let session = connect_ssh(config)?;
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
        let mut channel = self
            .session
            .channel_session()
            .context("SSH channel open failed")?;

        channel.exec(command).context("SSH exec failed")?;

        let mut output = String::new();
        channel
            .read_to_string(&mut output)
            .context("SSH read failed")?;

        channel.wait_close().ok();

        Ok(output)
    }
}

impl StatsCollector for SshCollector {
    fn collect(&mut self, host_label: &str) -> Result<MonitoringData> {
        let output = self.exec(LINUX_MONITORING_COMMAND)?;
        let (stats, counters) = parse_stats(&output)?;

        let cpu_usage_percent = match &self.prev_cpu {
            Some(prev) => cpu_percent_from_delta(prev, &counters),
            None => 0.0,
        };
        self.prev_cpu = Some(counters);

        Ok(MonitoringData {
            host: host_label.to_string(),
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

/// Establish an SSH connection using the given config.
fn connect_ssh(config: &SshSessionConfig) -> Result<ssh2::Session> {
    let port = config.port.unwrap_or(22);
    let addr = format!("{}:{}", config.host, port);

    let tcp = TcpStream::connect(&addr).with_context(|| format!("TCP connect to {addr} failed"))?;

    let mut session = ssh2::Session::new().context("Failed to create SSH session")?;
    session.set_tcp_stream(tcp);
    session.handshake().context("SSH handshake failed")?;
    session.set_blocking(true);

    match config.auth_method.as_str() {
        "key" => {
            let key_path = config.key_path.as_deref().unwrap_or("~/.ssh/id_rsa");
            let expanded = shellexpand::tilde(key_path);
            session
                .userauth_pubkey_file(
                    &config.username,
                    None,
                    std::path::Path::new(expanded.as_ref()),
                    None,
                )
                .context("SSH key auth failed")?;
        }
        "password" => {
            let password = config.password.as_deref().unwrap_or("");
            session
                .userauth_password(&config.username, password)
                .context("SSH password auth failed")?;
        }
        "agent" => {
            session
                .userauth_agent(&config.username)
                .context("SSH agent auth failed")?;
        }
        other => bail!("Unknown SSH auth method: {other}"),
    }

    if !session.authenticated() {
        bail!("SSH authentication failed");
    }

    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_df_output_basic() {
        let output = "\
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        50000000  20000000  28000000      42% /";
        let (total, used, pct) = parse_df_output(output);
        assert_eq!(total, 50000000);
        assert_eq!(used, 20000000);
        assert!((pct - 42.0).abs() < 0.1);
    }

    #[test]
    fn parse_df_output_empty() {
        let (total, used, pct) = parse_df_output("");
        assert_eq!(total, 0);
        assert_eq!(used, 0);
        assert!((pct - 0.0).abs() < 0.001);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parse_macos_loadavg_basic() {
        let result = parse_macos_loadavg("{ 1.23 0.45 0.67 }");
        assert!((result[0] - 1.23).abs() < 0.01);
        assert!((result[1] - 0.45).abs() < 0.01);
        assert!((result[2] - 0.67).abs() < 0.01);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn extract_vm_stat_value_basic() {
        assert_eq!(
            extract_vm_stat_value("Pages free:                             12345."),
            12345
        );
        assert_eq!(extract_vm_stat_value("Pages free:   0."), 0);
    }
}
