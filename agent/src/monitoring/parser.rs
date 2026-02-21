//! Parse system monitoring output from Linux command output.
//!
//! Ported from `src-tauri/src/monitoring/session.rs` — the same parsing
//! logic used by the desktop's direct-SSH monitoring, adapted for use
//! in the agent.

use anyhow::{bail, Result};

/// Parsed system statistics (without host routing info).
///
/// Some fields are only accessed on certain platforms (e.g., `cpu_usage_percent`
/// is computed on Linux but not macOS), so we suppress dead-code warnings.
#[derive(Debug, Clone)]
#[allow(dead_code)]
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
    user: u64,
    nice: u64,
    system: u64,
    idle: u64,
    iowait: u64,
    irq: u64,
    softirq: u64,
    steal: u64,
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

/// Compute CPU usage percentage from the delta between two counter snapshots.
/// Returns a value between 0.0 and 100.0.
pub fn cpu_percent_from_delta(prev: &CpuCounters, curr: &CpuCounters) -> f64 {
    let total_delta = curr.total().saturating_sub(prev.total());
    if total_delta == 0 {
        return 0.0;
    }
    let idle_delta = curr.idle_total().saturating_sub(prev.idle_total());
    let active_delta = total_delta.saturating_sub(idle_delta);
    (active_delta as f64 / total_delta as f64) * 100.0
}

/// Parse the aggregate `cpu` line from `/proc/stat`.
///
/// Format: `cpu  user nice system idle iowait irq softirq steal [guest guest_nice]`
pub fn parse_cpu_line(line: &str) -> CpuCounters {
    let parts: Vec<&str> = line.split_whitespace().collect();
    // parts[0] is "cpu", values start at parts[1]
    CpuCounters {
        user: parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
        nice: parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0),
        system: parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0),
        idle: parts.get(4).and_then(|s| s.parse().ok()).unwrap_or(0),
        iowait: parts.get(5).and_then(|s| s.parse().ok()).unwrap_or(0),
        irq: parts.get(6).and_then(|s| s.parse().ok()).unwrap_or(0),
        softirq: parts.get(7).and_then(|s| s.parse().ok()).unwrap_or(0),
        steal: parts.get(8).and_then(|s| s.parse().ok()).unwrap_or(0),
    }
}

/// Intermediate parse result containing both displayable stats and raw CPU counters.
pub type ParseResult = (SystemStats, CpuCounters);

/// Parse the combined command output into `SystemStats` and raw `CpuCounters`.
///
/// Expected input is the output of:
/// ```text
/// hostname && cat /proc/loadavg && head -1 /proc/stat && cat /proc/meminfo \
///     && cat /proc/uptime && df -Pk / && uname -sr
/// ```
///
/// `cpu_usage_percent` in the returned `SystemStats` is set to 0.0; the caller
/// is responsible for computing the actual value from counter deltas.
pub fn parse_stats(output: &str) -> Result<ParseResult> {
    let lines: Vec<&str> = output.lines().collect();
    if lines.len() < 6 {
        bail!("Unexpected monitoring output format (too few lines)");
    }

    // Line 0: hostname
    let hostname = lines[0].trim().to_string();

    // Line 1: /proc/loadavg — "0.15 0.10 0.05 1/234 5678"
    let load_parts: Vec<&str> = lines[1].split_whitespace().collect();
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

    // Line 2: aggregate cpu line from /proc/stat
    let cpu_counters = parse_cpu_line(lines[2]);

    // Lines 3+: /proc/meminfo — find MemTotal and MemAvailable
    let mut mem_total_kb: u64 = 0;
    let mut mem_available_kb: u64 = 0;
    let mut meminfo_end = 3;

    for (i, line) in lines.iter().enumerate().skip(3) {
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

    let memory_used_percent = if mem_total_kb > 0 {
        let used = mem_total_kb.saturating_sub(mem_available_kb);
        (used as f64 / mem_total_kb as f64) * 100.0
    } else {
        0.0
    };

    // df output: find the data line (skip header)
    let mut disk_total_kb: u64 = 0;
    let mut disk_used_kb: u64 = 0;
    let mut disk_used_percent: f64 = 0.0;

    for line in lines.iter().skip(meminfo_end + 1) {
        if line.starts_with("Filesystem") || line.trim().is_empty() {
            continue;
        }
        // uname line — skip it
        if !line.starts_with('/')
            && (line.starts_with("Linux")
                || line.starts_with("Darwin")
                || line.starts_with("FreeBSD"))
        {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 5 {
            disk_total_kb = parts[1].parse().unwrap_or(0);
            disk_used_kb = parts[2].parse().unwrap_or(0);
            // parts[4] is like "42%"
            disk_used_percent = parts[4].trim_end_matches('%').parse().unwrap_or(0.0);
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

    let stats = SystemStats {
        hostname,
        uptime_seconds,
        load_average,
        cpu_usage_percent: 0.0,
        memory_total_kb: mem_total_kb,
        memory_available_kb: mem_available_kb,
        memory_used_percent,
        disk_total_kb,
        disk_used_kb,
        disk_used_percent,
        os_info,
    };

    Ok((stats, cpu_counters))
}

/// Extract the numeric kB value from a `/proc/meminfo` line like
/// `"MemTotal:       16384000 kB"`.
pub fn parse_meminfo_value(line: &str) -> u64 {
    line.split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: build sample output with the given cpu line.
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
        assert!((stats.load_average[1] - 0.10).abs() < 0.001);
        assert!((stats.load_average[2] - 0.05).abs() < 0.001);
        // cpu_usage_percent is 0.0 from parse_stats (caller computes delta)
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
        // delta total = 200-100 = 100, delta idle = (110+20)-(70+10) = 50, active = 50
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
        // delta total = 100, delta idle = 0, active = 100 → 100%
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
        // used = 8000000 - 2000000 = 6000000, percent = 75%
        assert!((stats.memory_used_percent - 75.0).abs() < 0.1);
        assert!((stats.disk_used_percent - 60.0).abs() < 0.1);
    }
}
