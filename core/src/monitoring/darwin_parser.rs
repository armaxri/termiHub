//! Parse the macOS branch of the host monitoring command (#5471).
//!
//! macOS has no `/proc`, so the Darwin leg of
//! [`HOST_MONITORING_COMMAND`](super::HOST_MONITORING_COMMAND) reads the same
//! metrics from `sysctl`, `vm_stat`, `df`, `top` and `netstat`. Each command's
//! output sits under its own `@@<name>` header line, so this parser looks the
//! sections up by name instead of by position, and a missing or unreadable
//! section only makes its own metric unavailable.
//!
//! Two metrics differ from the Linux path:
//!
//! - **CPU** comes from `top -l 1`, which already reports a percentage. There
//!   are no cumulative tick counters to diff, so the sample carries
//!   `cpu_usage_percent` directly and returns all-zero [`CpuCounters`], which
//!   [`CpuDeltaTracker`](super::CpuDeltaTracker) treats as "no counter data".
//! - **Per-core CPU** has no shell-readable source on macOS. The per-core list
//!   is empty and [`StatsMetric::PerCoreCpu`] is listed as unavailable.

use std::collections::HashMap;

use crate::errors::CoreError;

use super::parser::parse_df_output;
use super::types::{CpuCounters, NetCounters, StatsMetric, SystemStats};

/// Split the command output into its `@@<name>` sections.
///
/// Lines before the first header (the OS marker line) are ignored.
fn sections(output: &str) -> HashMap<&str, Vec<&str>> {
    let mut map: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut current: Option<&str> = None;
    for line in output.lines() {
        if let Some(name) = line.trim().strip_prefix("@@") {
            let name = name.trim();
            map.entry(name).or_default();
            current = Some(name);
        } else if let Some(name) = current {
            if !line.trim().is_empty() {
                map.entry(name).or_default().push(line);
            }
        }
    }
    map
}

/// Parse `sysctl -n vm.loadavg` output, e.g. `{ 1.23 4.56 7.89 }`.
fn parse_loadavg(line: &str) -> Option<[f64; 3]> {
    let values: Vec<f64> = line
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
    (values.len() >= 3).then(|| [values[0], values[1], values[2]])
}

/// Parse the `sec = N` field of `sysctl -n kern.boottime`, e.g.
/// `{ sec = 1793611950, usec = 89053 } Mon Nov  2 10:32:30 2026`.
fn parse_boottime_secs(line: &str) -> Option<u64> {
    let rest = line.split("sec = ").nth(1)?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Convert a `vm.swapusage` size such as `5120.00M` to kB.
fn parse_swap_size_kb(value: &str) -> Option<u64> {
    let value = value.trim();
    let (number, factor) = match value.chars().last()? {
        'K' => (&value[..value.len() - 1], 1.0),
        'M' => (&value[..value.len() - 1], 1024.0),
        'G' => (&value[..value.len() - 1], 1024.0 * 1024.0),
        'T' => (&value[..value.len() - 1], 1024.0 * 1024.0 * 1024.0),
        _ => (value, 1.0 / 1024.0),
    };
    let number: f64 = number.parse().ok()?;
    Some((number * factor).round() as u64)
}

/// Parse `sysctl -n vm.swapusage`, e.g.
/// `total = 5120.00M  used = 4198.69M  free = 921.31M  (encrypted)`.
///
/// Returns `(total_kb, used_kb)`.
fn parse_swapusage(line: &str) -> Option<(u64, u64)> {
    let field = |name: &str| {
        let rest = line.split(&format!("{name} = ")).nth(1)?;
        parse_swap_size_kb(rest.split_whitespace().next()?)
    };
    Some((field("total")?, field("used")?))
}

/// Available memory in kB from `vm_stat` output: free + inactive + speculative
/// pages, the same estimate `psutil` uses on macOS.
///
/// The page size is read from the `vm_stat` header line
/// (`... (page size of 16384 bytes)`); `None` when it or the free-page count is
/// missing.
fn parse_vm_stat_available_kb(lines: &[&str]) -> Option<u64> {
    let page_size: u64 = lines.iter().find_map(|l| {
        let rest = l.split("page size of ").nth(1)?;
        rest.split_whitespace().next()?.parse().ok()
    })?;
    let pages = |label: &str| -> Option<u64> {
        lines.iter().find_map(|l| {
            let rest = l.trim().strip_prefix(label)?;
            rest.trim().trim_end_matches('.').parse().ok()
        })
    };
    let free = pages("Pages free:")?;
    let inactive = pages("Pages inactive:").unwrap_or(0);
    let speculative = pages("Pages speculative:").unwrap_or(0);
    let available_pages = free.saturating_add(inactive).saturating_add(speculative);
    Some(available_pages.saturating_mul(page_size) / 1024)
}

/// Aggregate CPU usage from `top -l 1 -n 0`'s summary line, e.g.
/// `CPU usage: 5.44% user, 11.81% sys, 82.73% idle`. Usage is `100 - idle`.
fn parse_top_cpu_percent(line: &str) -> Option<f64> {
    let idle_part = line.split(',').find(|p| p.contains("idle"))?;
    let idle: f64 = idle_part
        .split_whitespace()
        .find_map(|tok| tok.strip_suffix('%')?.parse().ok())?;
    Some((100.0 - idle).clamp(0.0, 100.0))
}

/// Sum cumulative byte counters across non-loopback interfaces from
/// `netstat -ibn` output.
///
/// Only the link-level row of each interface (`<Link#N>` in the Network
/// column) is counted; the per-address rows repeat the same counters. Rows
/// without a hardware address have one column fewer, so the counters are read
/// from the end: `... Ibytes Opkts Oerrs Obytes Coll`. Interfaces named `lo*`
/// are skipped, like `lo` on Linux. `None` when no link row was found.
pub fn parse_netstat_ibn(lines: &[&str]) -> Option<NetCounters> {
    let mut found = false;
    let mut counters = NetCounters::default();
    for line in lines {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 || !fields[2].starts_with("<Link#") {
            continue;
        }
        found = true;
        if fields[0].trim_end_matches('*').starts_with("lo") {
            continue;
        }
        let n = fields.len();
        let rx: u64 = fields[n - 5].parse().unwrap_or(0);
        let tx: u64 = fields[n - 2].parse().unwrap_or(0);
        counters.rx_bytes = counters.rx_bytes.saturating_add(rx);
        counters.tx_bytes = counters.tx_bytes.saturating_add(tx);
    }
    found.then_some(counters)
}

/// Parse the macOS branch of the host monitoring command (#5471).
///
/// Returns the same tuple as [`parse_stats`](super::parse_stats). The CPU
/// percentage is already in `SystemStats::cpu_usage_percent`; the returned
/// [`CpuCounters`] are all zero and the per-core list is empty (see the
/// module docs). Every metric whose section is missing or unreadable is listed
/// in [`SystemStats::unavailable_metrics`].
///
/// Errors only when no metric at all could be read.
pub fn parse_darwin_stats(
    output: &str,
) -> Result<(SystemStats, CpuCounters, Vec<CpuCounters>, NetCounters), CoreError> {
    let sections = sections(output);
    let first = |name: &str| -> Option<&str> {
        sections
            .get(name)
            .and_then(|lines| lines.first())
            .map(|l| l.trim())
    };
    let all = |name: &str| -> &[&str] { sections.get(name).map(Vec::as_slice).unwrap_or(&[]) };

    let mut unavailable: Vec<StatsMetric> = vec![StatsMetric::PerCoreCpu];
    let mut mark = |metric: StatsMetric| {
        if !unavailable.contains(&metric) {
            unavailable.push(metric);
        }
    };

    let hostname = first("hostname").unwrap_or_default().to_string();

    let load_average = first("loadavg").and_then(parse_loadavg);
    if load_average.is_none() {
        mark(StatsMetric::LoadAverage);
    }

    let uptime_seconds = match (
        first("boottime").and_then(parse_boottime_secs),
        first("now").and_then(|l| l.parse::<u64>().ok()),
    ) {
        (Some(boot), Some(now)) => Some(now.saturating_sub(boot) as f64),
        _ => None,
    };
    if uptime_seconds.is_none() {
        mark(StatsMetric::Uptime);
    }

    let memory_total_kb = first("memsize")
        .and_then(|l| l.parse::<u64>().ok())
        .map(|bytes| bytes / 1024)
        .filter(|kb| *kb > 0);
    let memory_available_kb = parse_vm_stat_available_kb(all("vmstat"));
    let memory = match (memory_total_kb, memory_available_kb) {
        (Some(total), Some(available)) => Some((total, available.min(total))),
        _ => None,
    };
    if memory.is_none() {
        mark(StatsMetric::Memory);
    }
    let (mem_total, mem_available) = memory.unwrap_or((memory_total_kb.unwrap_or(0), 0));
    let memory_used_percent = match memory {
        Some((total, available)) => (total - available) as f64 / total as f64 * 100.0,
        None => 0.0,
    };

    let swap = first("swap").and_then(parse_swapusage);
    if swap.is_none() {
        mark(StatsMetric::Swap);
    }
    let (swap_total_kb, swap_used_kb) = swap.unwrap_or((0, 0));
    let swap_used_kb = swap_used_kb.min(swap_total_kb);
    let swap_used_percent = if swap_total_kb > 0 {
        swap_used_kb as f64 / swap_total_kb as f64 * 100.0
    } else {
        0.0
    };

    let df = all("df").join("\n");
    let (disk_total_kb, disk_used_kb, disk_used_percent) = parse_df_output(&df);
    if disk_total_kb == 0 {
        mark(StatsMetric::Disk);
    }

    let os_info = first("uname").unwrap_or_default().to_string();
    if os_info.is_empty() {
        mark(StatsMetric::OsInfo);
    }

    let cpu_usage_percent = first("cpu").and_then(parse_top_cpu_percent);
    if cpu_usage_percent.is_none() {
        mark(StatsMetric::Cpu);
    }

    let net = parse_netstat_ibn(all("net"));
    if net.is_none() {
        mark(StatsMetric::Network);
    }

    let nothing_read = load_average.is_none()
        && memory.is_none()
        && cpu_usage_percent.is_none()
        && disk_total_kb == 0;
    if nothing_read {
        return Err(CoreError::Other(
            "Unexpected macOS monitoring output format (no readable metric)".to_string(),
        ));
    }

    let stats = SystemStats {
        hostname,
        uptime_seconds: uptime_seconds.unwrap_or(0.0),
        load_average: load_average.unwrap_or([0.0; 3]),
        cpu_usage_percent: cpu_usage_percent.unwrap_or(0.0),
        memory_total_kb: mem_total,
        memory_available_kb: mem_available,
        memory_used_percent,
        disk_total_kb,
        disk_used_kb,
        disk_used_percent,
        os_info,
        swap_total_kb,
        swap_used_kb,
        swap_used_percent,
        unavailable_metrics: unavailable,
        ..Default::default()
    };

    Ok((
        stats,
        CpuCounters::default(),
        Vec::new(),
        net.unwrap_or_default(),
    ))
}

#[cfg(test)]
#[path = "darwin_parser_tests.rs"]
mod tests;
