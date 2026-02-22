//! Monitoring types and parsers shared between the desktop and agent crates.

pub mod parser;
pub mod types;

pub use parser::{
    cpu_percent_from_delta, parse_cpu_line, parse_df_output, parse_meminfo_value, parse_stats,
    MONITORING_COMMAND,
};
pub use types::{CpuCounters, SystemStats};

use crate::errors::CoreError;

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
}
