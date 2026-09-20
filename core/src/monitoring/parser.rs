//! Parse system monitoring output from Linux command output.
//!
//! This is the canonical implementation of the monitoring parsers,
//! shared between the desktop and agent crates. Both previously had
//! their own copies of this logic.

use crate::errors::CoreError;

use super::types::{CpuCounters, NetCounters, SystemStats};

/// The compound command executed on Linux hosts to gather all metrics
/// in a single round-trip.
///
/// The leading `export LC_ALL=C LANG=C;` pins a stable machine locale for the
/// whole compound command (I18N-005). A bare `LC_ALL=C cmd` prefix would only
/// affect the first `hostname`, so the locale is `export`ed once for the exec'd
/// shell instead — keeping `df`'s numbers ungrouped and dot-decimal and
/// `uname`'s text stable even on a remote whose `$LANG` localizes numeric
/// output. `/proc` is already locale-invariant, so this is defence-in-depth for
/// the `df`/`uname` legs and guards against any future parsed command being
/// appended here.
///
/// The trailing `cat /proc/net/dev` supplies cumulative per-interface network
/// byte counters (NET throughput). It is appended last so a host that lacks it
/// still yields every earlier metric; a failure there only drops the network
/// leg (parsed as `0`), it does not lose the rest of the already-emitted output.
///
/// `grep '^cpu' /proc/stat` (replacing the former `head -1 /proc/stat`) emits the
/// aggregate `cpu` line **and** every per-core `cpuN` line (#3178). The extra
/// lines sit directly after the aggregate line; [`parse_stats`] consumes the
/// whole `cpu*` block, so a host that reports only the aggregate line still
/// parses correctly (empty per-core list).
pub const MONITORING_COMMAND: &str =
    "export LC_ALL=C LANG=C; hostname && cat /proc/loadavg && grep '^cpu' /proc/stat && cat /proc/meminfo && cat /proc/uptime && df -Pk / && uname -sr && cat /proc/net/dev";

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

/// Parse the combined command output into `SystemStats` and raw `CpuCounters`.
///
/// Expected input is the output of [`MONITORING_COMMAND`]:
/// ```text
/// hostname && cat /proc/loadavg && head -1 /proc/stat && cat /proc/meminfo \
///     && cat /proc/uptime && df -Pk / && uname -sr
/// ```
///
/// `cpu_usage_percent`, `per_core_cpu_percent`, and the `net_*_bytes_per_sec`
/// fields in the returned `SystemStats` are left at their empty/zero defaults;
/// the caller is responsible for computing the actual values from the returned
/// aggregate [`CpuCounters`], the per-core `Vec<CpuCounters>`, and the
/// [`NetCounters`] deltas.
///
/// The returned `Vec<CpuCounters>` holds one entry per `cpuN` line (#3178). It is
/// empty when the host emits only the aggregate `cpu` line.
pub fn parse_stats(
    output: &str,
) -> Result<(SystemStats, CpuCounters, Vec<CpuCounters>, NetCounters), CoreError> {
    let lines: Vec<&str> = output.lines().collect();
    if lines.len() < 6 {
        return Err(CoreError::Other(
            "Unexpected monitoring output format (too few lines)".to_string(),
        ));
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

    // Line 2: aggregate cpu line from /proc/stat.
    let cpu_counters = parse_cpu_line(lines[2]);

    // Lines 3..: optional per-core `cpuN` lines emitted by `grep '^cpu'` (#3178).
    // Consume the consecutive block of lines whose token is `cpu<digit>` (the
    // aggregate `cpu` line was already taken above). meminfo/uptime/df/uname
    // never begin with `cpu`, so the first non-`cpuN` line ends the block; a host
    // that reports only the aggregate line yields an empty per-core list.
    let mut per_core_counters: Vec<CpuCounters> = Vec::new();
    let mut cpu_block_end = 3;
    while let Some(line) = lines.get(cpu_block_end) {
        let is_per_core = line
            .strip_prefix("cpu")
            .and_then(|rest| rest.chars().next())
            .is_some_and(|c| c.is_ascii_digit());
        if !is_per_core {
            break;
        }
        per_core_counters.push(parse_cpu_line(line));
        cpu_block_end += 1;
    }

    // Lines after the cpu block: /proc/meminfo — find MemTotal and MemAvailable.
    //
    // `MemAvailable` was only added to /proc/meminfo in Linux 3.14 (2014).
    // Older/embedded kernels and some minimal /proc implementations omit it,
    // so we also collect the fields needed to estimate available memory the
    // way `free`/`htop` do when it is absent: MemFree + Buffers + Cached +
    // SReclaimable. `SwapCached` is deliberately not counted.
    let mut mem_total_kb: u64 = 0;
    let mut mem_available_kb: u64 = 0;
    let mut mem_available_seen = false;
    let mut mem_free_kb: u64 = 0;
    let mut mem_buffers_kb: u64 = 0;
    let mut mem_cached_kb: u64 = 0;
    let mut mem_sreclaimable_kb: u64 = 0;
    let mut swap_total_kb: u64 = 0;
    let mut swap_free_kb: u64 = 0;
    let mut meminfo_end = cpu_block_end;

    for (i, line) in lines.iter().enumerate().skip(cpu_block_end) {
        if line.starts_with("MemTotal:") {
            mem_total_kb = parse_meminfo_value(line);
        } else if line.starts_with("MemAvailable:") {
            mem_available_kb = parse_meminfo_value(line);
            mem_available_seen = true;
        } else if line.starts_with("MemFree:") {
            mem_free_kb = parse_meminfo_value(line);
        } else if line.starts_with("Buffers:") {
            mem_buffers_kb = parse_meminfo_value(line);
        } else if line.starts_with("Cached:") {
            // Exact prefix match avoids picking up "SwapCached:".
            mem_cached_kb = parse_meminfo_value(line);
        } else if line.starts_with("SReclaimable:") {
            mem_sreclaimable_kb = parse_meminfo_value(line);
        } else if line.starts_with("SwapTotal:") {
            swap_total_kb = parse_meminfo_value(line);
        } else if line.starts_with("SwapFree:") {
            swap_free_kb = parse_meminfo_value(line);
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

    // Fall back to the classic approximation when the kernel did not report
    // MemAvailable, so hosts on pre-3.14 kernels don't read as 100% used.
    if !mem_available_seen {
        let estimate = mem_free_kb
            .saturating_add(mem_buffers_kb)
            .saturating_add(mem_cached_kb)
            .saturating_add(mem_sreclaimable_kb);
        // Never report more available than total (defends the agent's
        // `available <= total` invariant against odd inputs).
        mem_available_kb = estimate.min(mem_total_kb);
    }

    let memory_used_percent = if mem_total_kb > 0 {
        let used = mem_total_kb.saturating_sub(mem_available_kb);
        (used as f64 / mem_total_kb as f64) * 100.0
    } else {
        0.0
    };

    // Swap: used = total - free. A host with no swap reports SwapTotal 0, which
    // yields 0 used / 0 % rather than an error.
    let swap_used_kb = swap_total_kb.saturating_sub(swap_free_kb);
    let swap_used_percent = if swap_total_kb > 0 {
        (swap_used_kb as f64 / swap_total_kb as f64) * 100.0
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

    // uname -sr: last non-empty line that is neither a df row (starts with `/`)
    // nor part of the trailing `/proc/net/dev` block. Net/dev header lines carry
    // a `|` and its interface rows carry a `:`; `uname -sr` output ("Linux 5.15.0",
    // "Darwin 22.1.0", …) has neither, so excluding both reliably lands on uname
    // even though the network block now follows it in the command output.
    let os_info = lines
        .iter()
        .rev()
        .find(|l| {
            let trimmed = l.trim();
            !trimmed.is_empty()
                && !trimmed.starts_with('/')
                && !trimmed.contains(':')
                && !trimmed.contains('|')
        })
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    // Network counters from the trailing `/proc/net/dev` block. Absent on hosts
    // whose kernel omits it (parsed as 0); the caller diffs successive snapshots
    // to derive the per-second rates.
    let net_counters = parse_net_dev(output);

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
        swap_total_kb,
        swap_used_kb,
        swap_used_percent,
        net_rx_bytes_per_sec: 0.0,
        net_tx_bytes_per_sec: 0.0,
        per_core_cpu_percent: Vec::new(),
    };

    Ok((stats, cpu_counters, per_core_counters, net_counters))
}

/// Extract the numeric kB value from a `/proc/meminfo` line like
/// `"MemTotal:       16384000 kB"`.
pub fn parse_meminfo_value(line: &str) -> u64 {
    line.split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// Parse `df -Pk` output to extract disk total, used, and used percent.
///
/// Returns `(total_kb, used_kb, used_percent)`. Returns `(0, 0, 0.0)` if
/// the output cannot be parsed.
pub fn parse_df_output(output: &str) -> (u64, u64, f64) {
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

/// Sum cumulative receive/transmit byte counters across all non-loopback
/// interfaces from `/proc/net/dev` output.
///
/// Each interface row is `iface: rxbytes rxpackets … txbytes txpackets …` — 8
/// receive columns followed by 8 transmit columns after the `:`. We take
/// column 0 (rx bytes) and column 8 (tx bytes). The two header lines carry no
/// `:` and are skipped, as is `lo` (loopback). Lines from other sections of the
/// combined monitoring output never match: only `/proc/net/dev` rows have ≥16
/// numeric fields after a colon, so this is safe to run over the whole output.
/// When the interface counter is very large the kernel may glue it to the `:`
/// (`eth0:12345…`); splitting on the first `:` handles that.
pub fn parse_net_dev(output: &str) -> NetCounters {
    let mut rx_bytes: u64 = 0;
    let mut tx_bytes: u64 = 0;
    for line in output.lines() {
        let Some(colon) = line.find(':') else {
            continue;
        };
        let name = line[..colon].trim();
        if name.is_empty() || name == "lo" {
            continue;
        }
        let fields: Vec<u64> = line[colon + 1..]
            .split_whitespace()
            .map(|s| s.parse().unwrap_or(0))
            .collect();
        if fields.len() >= 16 {
            rx_bytes = rx_bytes.saturating_add(fields[0]);
            tx_bytes = tx_bytes.saturating_add(fields[8]);
        }
    }
    NetCounters { rx_bytes, tx_bytes }
}

/// Compute network throughput in bytes/sec from the delta between two cumulative
/// counter snapshots taken `elapsed_secs` apart.
///
/// Returns `(rx_bytes_per_sec, tx_bytes_per_sec)`. A non-positive `elapsed_secs`
/// yields `(0.0, 0.0)`; a counter that went backwards (reboot / interface reset)
/// contributes `0` for that direction via a saturating subtraction.
pub fn net_rate_from_delta(
    prev: &NetCounters,
    curr: &NetCounters,
    elapsed_secs: f64,
) -> (f64, f64) {
    if elapsed_secs <= 0.0 {
        return (0.0, 0.0);
    }
    let rx = curr.rx_bytes.saturating_sub(prev.rx_bytes) as f64 / elapsed_secs;
    let tx = curr.tx_bytes.saturating_sub(prev.tx_bytes) as f64 / elapsed_secs;
    (rx, tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// I18N-005: the monitoring command must pin a stable machine locale for the
    /// whole compound command so `df`/`uname` (and any future parsed leg) are not
    /// at the mercy of the remote's `$LANG`. An `export` (not a bare `LC_ALL=C`
    /// prefix) is required so the locale applies past the first `&&`.
    #[test]
    fn monitoring_command_forces_c_locale_for_the_whole_command() {
        assert!(
            MONITORING_COMMAND.starts_with("export LC_ALL=C LANG=C;"),
            "monitoring command must export a C locale before the first `&&`, got: {MONITORING_COMMAND}"
        );
    }

    /// Helper: build sample output with the given cpu line. Includes swap lines
    /// in the meminfo section and a trailing `/proc/net/dev` block so the full
    /// `MONITORING_COMMAND` layout is exercised.
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
SwapTotal:       4000000 kB
SwapFree:        3000000 kB
12345.67 45678.90
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        50000000  20000000  28000000      42% /
Linux 5.15.0
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  1000000    1000    0    0    0     0          0         0  1000000    1000    0    0    0     0       0          0
  eth0:  5000000   45678    0    0    0     0          0         0  2000000   23456    0    0    0     0       0          0"
        )
    }

    #[test]
    fn parse_stats_basic() {
        let output = sample_output("cpu  10000 500 3000 80000 1000 0 200 0 0 0");

        let (stats, counters, per_core, net) = parse_stats(&output).unwrap();
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
        // os_info must remain uname even though /proc/net/dev now follows it.
        assert_eq!(stats.os_info, "Linux 5.15.0");
        // Swap: used = 4_000_000 - 3_000_000 = 1_000_000 → 25%.
        assert_eq!(stats.swap_total_kb, 4_000_000);
        assert_eq!(stats.swap_used_kb, 1_000_000);
        assert!((stats.swap_used_percent - 25.0).abs() < 0.1);
        // parse_stats leaves net rates at 0 (caller computes from the delta);
        // the cumulative counters exclude `lo`.
        assert!((stats.net_rx_bytes_per_sec - 0.0).abs() < 0.001);
        assert!((stats.net_tx_bytes_per_sec - 0.0).abs() < 0.001);
        assert_eq!(net.rx_bytes, 5_000_000);
        assert_eq!(net.tx_bytes, 2_000_000);
        // The shared sample has no per-core `cpuN` lines (it uses the aggregate
        // `cpu` line only), so per-core parsing yields an empty list.
        assert!(per_core.is_empty());
    }

    #[test]
    fn parse_stats_parses_per_core_cpu_lines() {
        // `grep '^cpu' /proc/stat` emits the aggregate `cpu` line followed by one
        // `cpuN` line per logical core (#3178). The whole block sits between the
        // loadavg and meminfo sections; parsing must pick up every `cpuN` line
        // without shifting the downstream meminfo/df/uname/net parsing.
        let output = "\
myhost
0.15 0.10 0.05 1/234 5678
cpu  10000 500 3000 80000 1000 0 200 0 0 0
cpu0 5000 250 1500 40000 500 0 100 0 0 0
cpu1 5000 250 1500 40000 500 0 100 0 0 0
MemTotal:       16384000 kB
MemAvailable:   12000000 kB
12345.67 45678.90
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        50000000  20000000  28000000      42% /
Linux 5.15.0";

        let (stats, counters, per_core, _net) = parse_stats(output).unwrap();
        // Aggregate line still parsed correctly.
        assert_eq!(counters.user, 10000);
        assert_eq!(counters.idle, 80000);
        // Two per-core lines → two entries, each with the cpuN fields.
        assert_eq!(per_core.len(), 2);
        assert_eq!(per_core[0].user, 5000);
        assert_eq!(per_core[0].idle, 40000);
        assert_eq!(per_core[1].system, 1500);
        // Downstream sections are unaffected by the inserted per-core lines.
        assert_eq!(stats.memory_total_kb, 16384000);
        assert!((stats.uptime_seconds - 12345.67).abs() < 0.01);
        assert_eq!(stats.disk_total_kb, 50000000);
        assert_eq!(stats.os_info, "Linux 5.15.0");
        // parse_stats leaves the computed percentages empty for the caller.
        assert!(stats.per_core_cpu_percent.is_empty());
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

        let (stats, _, _, _) = parse_stats(output).unwrap();
        // used = 8000000 - 2000000 = 6000000, percent = 75%
        assert!((stats.memory_used_percent - 75.0).abs() < 0.1);
        assert!((stats.disk_used_percent - 60.0).abs() < 0.1);
    }

    #[test]
    fn parse_stats_memavailable_absent_falls_back() {
        // Pre-3.14 kernels (and some minimal /proc implementations) omit the
        // MemAvailable line. Without a fallback the parser reported 100% used.
        let output = "\
oldhost
0.20 0.10 0.05 1/100 4321
cpu  5000 0 3000 80000 2000 0 0 0 0 0
MemTotal:       8000000 kB
MemFree:        1000000 kB
Buffers:         200000 kB
Cached:         2000000 kB
SwapCached:       50000 kB
SReclaimable:    300000 kB
1000.50 2000.00
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        100000000  60000000  38000000      60% /
Linux 3.10.0";

        let (stats, _, _, _) = parse_stats(output).unwrap();
        // available ≈ MemFree + Buffers + Cached + SReclaimable
        //         = 1_000_000 + 200_000 + 2_000_000 + 300_000 = 3_500_000
        // (SwapCached must NOT be counted).
        assert_eq!(stats.memory_available_kb, 3_500_000);
        // used = 8_000_000 - 3_500_000 = 4_500_000 → 56.25%, not 100%.
        assert!(
            (stats.memory_used_percent - 56.25).abs() < 0.1,
            "expected ~56.25%, got {}",
            stats.memory_used_percent
        );
    }

    #[test]
    fn parse_stats_memavailable_present_unchanged() {
        // When MemAvailable is present it wins; the fallback fields are ignored.
        let output = "\
newhost
0.20 0.10 0.05 1/100 4321
cpu  5000 0 3000 80000 2000 0 0 0 0 0
MemTotal:       8000000 kB
MemFree:        1000000 kB
Buffers:         200000 kB
Cached:         2000000 kB
MemAvailable:   6000000 kB
SReclaimable:    300000 kB
1000.50 2000.00
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        100000000  60000000  38000000      60% /
Linux 6.1.0";

        let (stats, _, _, _) = parse_stats(output).unwrap();
        assert_eq!(stats.memory_available_kb, 6_000_000);
        // used = 8_000_000 - 6_000_000 = 2_000_000 → 25%.
        assert!((stats.memory_used_percent - 25.0).abs() < 0.1);
    }

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

    #[test]
    fn parse_net_dev_sums_non_loopback_interfaces() {
        // Two real interfaces plus loopback; `lo` must be excluded and the rest
        // summed. rx = col 0, tx = col 8 (after the 8 receive columns).
        let output = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  9999999    1000    0    0    0     0          0         0  9999999    1000    0    0    0     0       0          0
  eth0:  5000000   45678    0    0    0     0          0         0  2000000   23456    0    0    0     0       0          0
  wlan0:  1000000    5000    0    0    0     0          0         0   500000    4000    0    0    0     0       0          0";
        let net = parse_net_dev(output);
        assert_eq!(net.rx_bytes, 6_000_000);
        assert_eq!(net.tx_bytes, 2_500_000);
    }

    #[test]
    fn parse_net_dev_handles_counter_glued_to_colon() {
        // The kernel column is fixed-width; a very large counter can be printed
        // with no space after the `:`. Splitting on the first `:` must still work.
        let output = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0:99999999999   45678    0    0    0     0          0         0  2000000   23456    0    0    0     0       0          0";
        let net = parse_net_dev(output);
        assert_eq!(net.rx_bytes, 99_999_999_999);
        assert_eq!(net.tx_bytes, 2_000_000);
    }

    #[test]
    fn parse_net_dev_absent_yields_zero() {
        // Non-net output (or a host whose kernel omits /proc/net/dev): no row has
        // ≥16 numeric fields after a colon, so counters stay 0 rather than erroring.
        let output = "\
myhost
MemTotal:       16384000 kB
Linux 5.15.0";
        let net = parse_net_dev(output);
        assert_eq!(net.rx_bytes, 0);
        assert_eq!(net.tx_bytes, 0);
    }

    #[test]
    fn parse_stats_no_swap_reports_zero() {
        // A host with swap disabled reports SwapTotal 0 (or omits the lines).
        let output = "\
noswap
0.10 0.05 0.01 1/50 999
cpu  1000 0 500 9000 200 0 0 0 0 0
MemTotal:       8000000 kB
MemAvailable:   4000000 kB
SwapTotal:             0 kB
SwapFree:              0 kB
100.0 200.0
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        10000000   5000000   5000000      50% /
Linux 6.1.0";
        let (stats, _, _, _) = parse_stats(output).unwrap();
        assert_eq!(stats.swap_total_kb, 0);
        assert_eq!(stats.swap_used_kb, 0);
        assert!((stats.swap_used_percent - 0.0).abs() < 0.001);
    }

    #[test]
    fn net_rate_from_delta_computes_bytes_per_sec() {
        let prev = NetCounters {
            rx_bytes: 1_000,
            tx_bytes: 2_000,
        };
        let curr = NetCounters {
            rx_bytes: 3_000,
            tx_bytes: 4_000,
        };
        // 2000 bytes over 2.0s = 1000 B/s each direction.
        let (rx, tx) = net_rate_from_delta(&prev, &curr, 2.0);
        assert!((rx - 1000.0).abs() < 0.001);
        assert!((tx - 1000.0).abs() < 0.001);
    }

    #[test]
    fn net_rate_from_delta_zero_elapsed_returns_zero() {
        let c = NetCounters {
            rx_bytes: 5_000,
            tx_bytes: 5_000,
        };
        let (rx, tx) = net_rate_from_delta(&c, &c, 0.0);
        assert!((rx - 0.0).abs() < 0.001);
        assert!((tx - 0.0).abs() < 0.001);
    }

    #[test]
    fn net_rate_from_delta_counter_reset_yields_zero() {
        // A reboot/interface reset makes the new counter smaller; saturating_sub
        // clamps the negative delta to 0 rather than underflowing.
        let prev = NetCounters {
            rx_bytes: 10_000,
            tx_bytes: 10_000,
        };
        let curr = NetCounters {
            rx_bytes: 100,
            tx_bytes: 100,
        };
        let (rx, tx) = net_rate_from_delta(&prev, &curr, 2.0);
        assert!((rx - 0.0).abs() < 0.001);
        assert!((tx - 0.0).abs() < 0.001);
    }
}
