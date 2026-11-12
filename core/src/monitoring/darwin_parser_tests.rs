//! Tests for the macOS monitoring parser (#5471).
//!
//! `RECORDED` is real output of the Darwin branch of `HOST_MONITORING_COMMAND`,
//! recorded on macOS 27 (Apple silicon, 16 KiB pages). The hostname and MAC
//! addresses are anonymised, the `netstat` table is trimmed to a few rows and
//! the `vm_stat` table to its first lines; the numbers are as recorded.

use super::*;
use crate::monitoring::parser::{parse_stats, unsupported_host, DARWIN_STATS_MARKER};
use crate::monitoring::{CpuDeltaTracker, PerCoreCpuTracker};

const RECORDED: &str = "\
termihub-monitoring-os darwin
@@hostname
test-mac.local
@@loadavg
{ 21.70 15.05 11.54 }
@@memsize
17179869184
@@boottime
{ sec = 1793611950, usec = 89053 } Mon Nov  2 10:32:30 2026
@@now
1794469931
@@swap
total = 5120.00M  used = 4198.69M  free = 921.31M  (encrypted)
@@vmstat
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   208321.
Pages active:                                 247436.
Pages inactive:                               240281.
Pages speculative:                              6724.
Pages throttled:                                   0.
Pages wired down:                             174011.
Pages purgeable:                                3839.
\"Translation faults\":                    11567840435.
@@df
Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   482797652  13335688  26009940    34%    /
@@uname
Darwin 27.0.0
@@cpu
CPU usage: 5.44% user, 11.81% sys, 82.73% idle
@@net
Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                       7200349     0 35517173597  7200349     0 35517173597     0
lo0        16384 127           127.0.0.1        7200349     - 35517173597  7200349     - 35517173597     -
gif0*      1280  <Link#2>                             0     0          0        0     0          0     0
en0        1500  <Link#14>   02:00:00:00:00:01 27059012     0 29036133736 13668146     0 4445809764     0
en0        1500  fe80::1862: fe80:e::1862:fb82 27059012     - 29036133736 13668146     - 4445809764     -
en0        1500  192.168.178   192.168.178.162 27059012     - 29036133736 13668146     - 4445809764     -
awdl0      1500  <Link#16>   02:00:00:00:00:02     6185     0    5578875     4977     0    2230797     0
utun8      1420  <Link#27>                     23167275     0 23452610635 12894343     0 3149231586     0
";

#[test]
fn recorded_output_starts_with_the_darwin_marker() {
    assert!(RECORDED.starts_with(DARWIN_STATS_MARKER));
    assert_eq!(unsupported_host(RECORDED), None);
}

#[test]
fn parse_stats_dispatches_recorded_macos_output() {
    let (stats, counters, per_core, net) = parse_stats(RECORDED).unwrap();

    assert_eq!(stats.hostname, "test-mac.local");
    assert_eq!(stats.load_average, [21.70, 15.05, 11.54]);
    // 1794469931 - 1793611950
    assert!((stats.uptime_seconds - 857_981.0).abs() < 0.001);

    // 16 GiB → 16 777 216 kB; available = (free + inactive + speculative) pages
    // × 16 KiB = (208321 + 240281 + 6724) × 16 = 7 285 216 kB.
    assert_eq!(stats.memory_total_kb, 16_777_216);
    assert_eq!(stats.memory_available_kb, 7_285_216);
    assert!((stats.memory_used_percent - 56.577).abs() < 0.01);

    // 5120.00M / 4198.69M → kB.
    assert_eq!(stats.swap_total_kb, 5_242_880);
    assert_eq!(stats.swap_used_kb, 4_299_459);
    assert!((stats.swap_used_percent - 82.005).abs() < 0.01);

    assert_eq!(stats.disk_total_kb, 482_797_652);
    assert_eq!(stats.disk_used_kb, 13_335_688);
    assert!((stats.disk_used_percent - 34.0).abs() < 0.001);

    assert_eq!(stats.os_info, "Darwin 27.0.0");
    // 100 - 82.73 % idle.
    assert!((stats.cpu_usage_percent - 17.27).abs() < 0.001);

    // Link rows only, without lo0: en0 + awdl0 + utun8 (no address column).
    assert_eq!(net.rx_bytes, 52_494_323_246);
    assert_eq!(net.tx_bytes, 7_597_272_147);

    // No tick counters and no per-core source on macOS.
    assert_eq!(counters.total(), 0);
    assert!(per_core.is_empty());
    assert_eq!(stats.unavailable_metrics, vec![StatsMetric::PerCoreCpu]);
}

/// The per-core-absent fallback: the trackers every collector runs leave the
/// direct `top` percentage alone and report an empty per-core list.
#[test]
fn per_core_absent_and_direct_cpu_survive_the_delta_trackers() {
    let mut cpu_tracker = CpuDeltaTracker::new();
    let mut per_core_tracker = PerCoreCpuTracker::new();
    for _ in 0..2 {
        let (mut stats, counters, per_core, _) = parse_stats(RECORDED).unwrap();
        if let Some(pct) = cpu_tracker.update(counters) {
            stats.cpu_usage_percent = pct;
        }
        stats.per_core_cpu_percent = per_core_tracker.update(&per_core);
        assert!((stats.cpu_usage_percent - 17.27).abs() < 0.001);
        assert!(stats.per_core_cpu_percent.is_empty());
        assert!(stats.is_unavailable(StatsMetric::PerCoreCpu));
    }
}

#[test]
fn missing_sections_mark_only_their_metric_unavailable() {
    // `top` and `netstat` missing (e.g. a locked-down host): the rest still parses.
    let cut = RECORDED.split("@@cpu").next().unwrap();
    let (stats, _, _, net) = parse_stats(cut).unwrap();
    assert!(stats.is_unavailable(StatsMetric::Cpu));
    assert!(stats.is_unavailable(StatsMetric::Network));
    assert!(stats.is_unavailable(StatsMetric::PerCoreCpu));
    assert!(!stats.is_unavailable(StatsMetric::Memory));
    assert!(!stats.is_unavailable(StatsMetric::Disk));
    assert_eq!(net, NetCounters::default());
    assert_eq!(stats.memory_total_kb, 16_777_216);
}

#[test]
fn empty_sections_are_unavailable_not_zero() {
    let output = "\
termihub-monitoring-os darwin
@@hostname
host
@@loadavg
{ 1.00 2.00 3.00 }
@@memsize
@@vmstat
@@swap
@@df
@@uname
@@cpu
@@net
";
    let (stats, _, _, _) = parse_stats(output).unwrap();
    for metric in [
        StatsMetric::Memory,
        StatsMetric::Swap,
        StatsMetric::Disk,
        StatsMetric::OsInfo,
        StatsMetric::Cpu,
        StatsMetric::Network,
        StatsMetric::Uptime,
    ] {
        assert!(
            stats.is_unavailable(metric),
            "{metric:?} should be unavailable"
        );
    }
    assert!(!stats.is_unavailable(StatsMetric::LoadAverage));
}

#[test]
fn marker_without_any_metric_is_an_error() {
    let output = "termihub-monitoring-os darwin\n@@hostname\nhost\n";
    assert!(parse_stats(output).is_err());
}

#[test]
fn swap_sizes_convert_units() {
    assert_eq!(parse_swap_size_kb("1024.00K"), Some(1024));
    assert_eq!(parse_swap_size_kb("2.00M"), Some(2048));
    assert_eq!(parse_swap_size_kb("1.00G"), Some(1_048_576));
    assert_eq!(parse_swap_size_kb("junk"), None);
    assert_eq!(
        parse_swapusage("total = 0.00M  used = 0.00M  free = 0.00M"),
        Some((0, 0))
    );
}

#[test]
fn top_cpu_line_parses_idle() {
    assert_eq!(
        parse_top_cpu_percent("CPU usage: 0.0% user, 0.0% sys, 100.0% idle"),
        Some(0.0)
    );
    assert_eq!(parse_top_cpu_percent("CPU usage: n/a"), None);
}

#[test]
fn boottime_and_loadavg_parse() {
    assert_eq!(
        parse_boottime_secs("{ sec = 42, usec = 7 } Thu Jan  1 00:00:42 1970"),
        Some(42)
    );
    assert_eq!(parse_boottime_secs("garbage"), None);
    assert_eq!(
        parse_loadavg("{ 0.5 0.25 0.125 }"),
        Some([0.5, 0.25, 0.125])
    );
    assert_eq!(parse_loadavg("{ }"), None);
}
