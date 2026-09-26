//! Monitoring types and parsers shared between the desktop and agent crates.

// Periodic HTTP monitor, hostable on the desktop or a remote agent (#2592).
// Behind the optional `http-monitor` feature so non-hosting consumers do not
// pull `reqwest`.
#[cfg(feature = "http-monitor")]
pub mod http_monitor;
// The local-host collector + monitoring provider live behind `local-shell`:
// they pull `sysinfo`, and the desktop/agent that surface local monitoring both
// enable that feature (PROD-0022).
#[cfg(feature = "local-shell")]
pub mod local_collector;
#[cfg(feature = "local-shell")]
pub mod local_provider;
// Local-machine process listing + kill via `sysinfo` (PROD-0028), behind
// `local-shell` alongside the local collector.
#[cfg(feature = "local-shell")]
pub mod local_process;
// Process listing + termination types, `ps` parser, and the cross-backend
// `ProcessManager` seam (PROD-0028). Pure logic — always compiled.
pub mod process;
// Exec-based monitoring provider for Docker containers + WSL distributions
// (#3182): both are Linux with `/proc`, so they run `MONITORING_COMMAND` via
// `docker exec` / `wsl.exe` and reuse the canonical parser + delta trackers.
// Enabled whenever either of those backends is compiled.
#[cfg(any(feature = "docker", feature = "wsl"))]
pub mod exec_provider;
pub mod parser;
pub mod provider;
pub mod status;
pub mod types;

#[cfg(feature = "local-shell")]
pub use local_collector::LocalCollector;
#[cfg(feature = "local-shell")]
pub use local_process::LocalProcessManager;
#[cfg(feature = "local-shell")]
pub use local_provider::LocalMonitoringProvider;

#[cfg(any(feature = "docker", feature = "wsl"))]
pub use exec_provider::{ExecMonitoringProvider, ProcStatsSource};

pub use process::{
    build_kill_command, parse_ps_output, sort_and_cap, ExecProcessManager, KillSignal,
    ProcessCommandOutput, ProcessError, ProcessExecSource, ProcessInfo, ProcessManager,
    MAX_PROCESSES, PROCESS_LIST_COMMAND,
};

pub use parser::{
    cpu_percent_from_delta, net_rate_from_delta, parse_cpu_line, parse_df_output,
    parse_meminfo_value, parse_net_dev, parse_stats, MONITORING_COMMAND,
};
pub use provider::{
    MonitoringProvider, MonitoringReceiver, MonitoringSender, MonitoringSubscription,
};
pub use status::{
    agent_recovery_budget, BackoffSchedule, CollectLoopState, MonitorStatus, MonitorStatusReason,
    MonitorStatusReceiver, MonitorStatusSender, MonitorStatusUpdate, BACKOFF_CAP,
    DEFAULT_BACKOFF_BASE, DEFAULT_COLLECT_TIMEOUT, DEFAULT_MAX_RECONNECT_ATTEMPTS,
    DEFAULT_STALE_THRESHOLD, PRE_LIVE_FAILURE_LIMIT_FACTOR,
};
pub use types::{CpuCounters, NetCounters, SystemStats};

use crate::errors::CoreError;
use std::time::Instant;

/// Default interval between system-monitoring stat collections, in milliseconds.
///
/// The single source of truth for the monitoring cadence, shared by the desktop
/// SSH monitor and the agent monitoring manager so the default is defined once.
/// Live-overridable per subscription; this is only the starting value.
pub const DEFAULT_MONITORING_INTERVAL_MS: u64 = 2000;

/// Stats collection trait — sync collection, consumers wrap as needed.
///
/// Desktop: SSH exec to remote host, parse output.
/// Agent: local `/proc` reading OR SSH exec for jump hosts.
pub trait StatsCollector: Send {
    /// Collect system stats for the given host label.
    ///
    /// Implementations run [`MONITORING_COMMAND`] and parse the output.
    fn collect(&mut self, host_label: &str) -> Result<SystemStats, CoreError>;
}

/// Maintains previous CPU counters for calculating usage deltas.
///
/// CPU usage percentage requires comparing two snapshots of cumulative
/// counters. This struct encapsulates that state so consumers don't need
/// to manage `Option<CpuCounters>` manually.
pub struct CpuDeltaTracker {
    previous: Option<CpuCounters>,
}

impl CpuDeltaTracker {
    /// Create a new tracker with no previous snapshot.
    pub fn new() -> Self {
        Self { previous: None }
    }

    /// Update with new counters, return CPU usage percentage.
    ///
    /// First call returns `None` (no previous snapshot to compare against).
    /// Subsequent calls return `Some(percentage)` where `0.0 <= percentage <= 100.0`.
    pub fn update(&mut self, current: CpuCounters) -> Option<f64> {
        let result = self
            .previous
            .as_ref()
            .map(|prev| cpu_percent_from_delta(prev, &current));
        self.previous = Some(current);
        result
    }
}

impl Default for CpuDeltaTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// Maintains one [`CpuDeltaTracker`] per logical core for per-core usage (#3178).
///
/// Per-core CPU percentages are delta-based just like the aggregate, so each core
/// needs its own previous-snapshot state. This wraps a `Vec<CpuDeltaTracker>` and
/// mirrors [`CpuDeltaTracker::update`]'s priming behaviour: the first sample (and
/// the first sample after the core count changes, e.g. CPU hotplug) reports
/// `0.0` for every core.
pub struct PerCoreCpuTracker {
    trackers: Vec<CpuDeltaTracker>,
}

impl PerCoreCpuTracker {
    /// Create a tracker with no cores primed yet.
    pub fn new() -> Self {
        Self {
            trackers: Vec::new(),
        }
    }

    /// Update with the current per-core counters, returning each core's usage
    /// percentage (`0.0 <= pct <= 100.0`) in core order.
    ///
    /// The first call returns all-`0.0` (no prior snapshot). When the number of
    /// reported cores changes, the trackers are reset so the next sample re-primes
    /// rather than diffing mismatched cores.
    pub fn update(&mut self, current: &[CpuCounters]) -> Vec<f64> {
        if self.trackers.len() != current.len() {
            self.trackers = (0..current.len()).map(|_| CpuDeltaTracker::new()).collect();
        }
        current
            .iter()
            .zip(self.trackers.iter_mut())
            .map(|(counters, tracker)| tracker.update(counters.clone()).unwrap_or(0.0))
            .collect()
    }
}

impl Default for PerCoreCpuTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// Maintains previous network counters + timestamp for calculating throughput.
///
/// Network throughput (bytes/sec) requires diffing two cumulative counter
/// snapshots over the wall-clock interval between them. This struct encapsulates
/// that state, mirroring [`CpuDeltaTracker`], so consumers do not manage the
/// `Option<(NetCounters, Instant)>` themselves.
pub struct NetDeltaTracker {
    previous: Option<(NetCounters, Instant)>,
}

impl NetDeltaTracker {
    /// Create a new tracker with no previous snapshot.
    pub fn new() -> Self {
        Self { previous: None }
    }

    /// Update with new cumulative counters observed at `now`, returning
    /// `(rx_bytes_per_sec, tx_bytes_per_sec)`.
    ///
    /// The first call returns `(0.0, 0.0)` (no prior snapshot to diff against).
    pub fn update(&mut self, current: NetCounters, now: Instant) -> (f64, f64) {
        let result = self
            .previous
            .as_ref()
            .map(|(prev, prev_instant)| {
                let elapsed = now.duration_since(*prev_instant).as_secs_f64();
                net_rate_from_delta(prev, &current, elapsed)
            })
            .unwrap_or((0.0, 0.0));
        self.previous = Some((current, now));
        result
    }
}

impl Default for NetDeltaTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_delta_tracker_first_call_returns_none() {
        let mut tracker = CpuDeltaTracker::new();
        let counters = CpuCounters {
            user: 100,
            nice: 10,
            system: 50,
            idle: 800,
            iowait: 20,
            irq: 5,
            softirq: 10,
            steal: 5,
        };
        assert!(tracker.update(counters).is_none());
    }

    #[test]
    fn cpu_delta_tracker_second_call_returns_percentage() {
        let mut tracker = CpuDeltaTracker::new();

        let first = CpuCounters {
            user: 10,
            nice: 0,
            system: 10,
            idle: 70,
            iowait: 10,
            irq: 0,
            softirq: 0,
            steal: 0,
        };
        let second = CpuCounters {
            user: 30,
            nice: 0,
            system: 30,
            idle: 110,
            iowait: 20,
            irq: 5,
            softirq: 5,
            steal: 0,
        };

        assert!(tracker.update(first).is_none());

        // delta total = 200-100 = 100, delta idle = (110+20)-(70+10) = 50, active = 50
        let pct = tracker
            .update(second)
            .expect("should return Some on second call");
        assert!((pct - 50.0).abs() < 0.01);
    }

    #[test]
    fn cpu_delta_tracker_multiple_updates() {
        let mut tracker = CpuDeltaTracker::new();

        let snap1 = CpuCounters {
            user: 100,
            nice: 0,
            system: 50,
            idle: 800,
            iowait: 50,
            irq: 0,
            softirq: 0,
            steal: 0,
        };
        let snap2 = CpuCounters {
            user: 200,
            nice: 0,
            system: 100,
            idle: 1600,
            iowait: 100,
            irq: 0,
            softirq: 0,
            steal: 0,
        };
        let snap3 = CpuCounters {
            user: 400,
            nice: 0,
            system: 200,
            idle: 1800,
            iowait: 100,
            irq: 0,
            softirq: 0,
            steal: 0,
        };

        assert!(tracker.update(snap1).is_none());

        // snap1→snap2: total delta = 2000-1000 = 1000, idle delta = (1600+100)-(800+50) = 850, active = 150
        let pct2 = tracker.update(snap2).expect("should return Some");
        assert!((pct2 - 15.0).abs() < 0.01);

        // snap2→snap3: total delta = 2500-2000 = 500, idle delta = (1800+100)-(1600+100) = 200, active = 300
        let pct3 = tracker.update(snap3).expect("should return Some");
        assert!((pct3 - 60.0).abs() < 0.01);
    }

    #[test]
    fn cpu_delta_tracker_default() {
        let mut tracker = CpuDeltaTracker::default();
        let counters = CpuCounters {
            user: 50,
            ..Default::default()
        };
        // Default should behave the same as new() — first call returns None
        assert!(tracker.update(counters).is_none());
    }

    #[test]
    fn per_core_cpu_tracker_first_call_returns_zeros() {
        let mut tracker = PerCoreCpuTracker::new();
        let cores = vec![
            CpuCounters {
                user: 100,
                idle: 900,
                ..Default::default()
            },
            CpuCounters {
                user: 200,
                idle: 800,
                ..Default::default()
            },
        ];
        let pct = tracker.update(&cores);
        assert_eq!(pct, vec![0.0, 0.0]);
    }

    #[test]
    fn per_core_cpu_tracker_second_call_returns_per_core_percentages() {
        let mut tracker = PerCoreCpuTracker::new();

        // Prime.
        let first = vec![
            CpuCounters {
                user: 10,
                idle: 90,
                ..Default::default()
            },
            CpuCounters {
                user: 10,
                idle: 90,
                ..Default::default()
            },
        ];
        assert_eq!(tracker.update(&first), vec![0.0, 0.0]);

        // core0: +10 active / +100 total = 10%. core1: +50 active / +100 total = 50%.
        let second = vec![
            CpuCounters {
                user: 20,
                idle: 180,
                ..Default::default()
            },
            CpuCounters {
                user: 60,
                idle: 140,
                ..Default::default()
            },
        ];
        let pct = tracker.update(&second);
        assert_eq!(pct.len(), 2);
        assert!((pct[0] - 10.0).abs() < 0.01, "core0 pct was {}", pct[0]);
        assert!((pct[1] - 50.0).abs() < 0.01, "core1 pct was {}", pct[1]);
        // Every per-core value stays within range.
        assert!(pct.iter().all(|p| (0.0..=100.0).contains(p)));
    }

    #[test]
    fn per_core_cpu_tracker_core_count_change_re_primes() {
        let mut tracker = PerCoreCpuTracker::new();
        let two = vec![CpuCounters::default(), CpuCounters::default()];
        let _ = tracker.update(&two);
        // Core count changes (e.g. hotplug): the next sample re-primes to 0.0.
        let four = vec![
            CpuCounters::default(),
            CpuCounters::default(),
            CpuCounters::default(),
            CpuCounters::default(),
        ];
        assert_eq!(tracker.update(&four), vec![0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn per_core_cpu_tracker_empty_input_yields_empty() {
        let mut tracker = PerCoreCpuTracker::new();
        assert!(tracker.update(&[]).is_empty());
    }

    #[test]
    fn net_delta_tracker_first_call_returns_zero() {
        let mut tracker = NetDeltaTracker::new();
        let counters = NetCounters {
            rx_bytes: 1_000,
            tx_bytes: 2_000,
        };
        let (rx, tx) = tracker.update(counters, Instant::now());
        assert!((rx - 0.0).abs() < 0.001);
        assert!((tx - 0.0).abs() < 0.001);
    }

    #[test]
    fn net_delta_tracker_second_call_returns_rate() {
        let mut tracker = NetDeltaTracker::new();
        let start = Instant::now();
        // Prime with the first snapshot.
        let _ = tracker.update(
            NetCounters {
                rx_bytes: 1_000,
                tx_bytes: 2_000,
            },
            start,
        );
        // Second snapshot 2s later: +2000 rx / +4000 tx → 1000 / 2000 B/s.
        let (rx, tx) = tracker.update(
            NetCounters {
                rx_bytes: 3_000,
                tx_bytes: 6_000,
            },
            start + std::time::Duration::from_secs(2),
        );
        assert!((rx - 1000.0).abs() < 0.001, "rx rate was {rx}");
        assert!((tx - 2000.0).abs() < 0.001, "tx rate was {tx}");
    }

    #[test]
    fn net_delta_tracker_default_matches_new() {
        let mut tracker = NetDeltaTracker::default();
        let (rx, tx) = tracker.update(NetCounters::default(), Instant::now());
        assert!((rx - 0.0).abs() < 0.001);
        assert!((tx - 0.0).abs() < 0.001);
    }
}
