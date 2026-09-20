//! Monitoring types and parsers shared between the desktop and agent crates.

// Periodic HTTP monitor, hostable on the desktop or a remote agent (#2592).
// Behind the optional `http-monitor` feature so non-hosting consumers do not
// pull `reqwest`.
#[cfg(feature = "http-monitor")]
pub mod http_monitor;
pub mod parser;
pub mod provider;
pub mod status;
pub mod types;

pub use parser::{
    cpu_percent_from_delta, net_rate_from_delta, parse_cpu_line, parse_df_output,
    parse_meminfo_value, parse_net_dev, parse_stats, MONITORING_COMMAND,
};
pub use provider::{
    MonitoringProvider, MonitoringReceiver, MonitoringSender, MonitoringSubscription,
};
pub use status::{
    BackoffSchedule, CollectLoopState, MonitorStatus, MonitorStatusReceiver, MonitorStatusSender,
    BACKOFF_CAP, DEFAULT_BACKOFF_BASE, DEFAULT_MAX_RECONNECT_ATTEMPTS, DEFAULT_STALE_THRESHOLD,
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
