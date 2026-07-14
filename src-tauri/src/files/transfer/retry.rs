//! Pure retry/backoff, resume-offset, and throughput math (issue #1336).
//!
//! All three are needed by the FTP executor but have zero I/O, so they live
//! here as free functions / small structs and are unit-tested directly:
//!
//! - [`backoff_delay`] — exponential backoff schedule for auto-retry.
//! - [`resume_offset`] — the `REST` byte offset for resuming a partial transfer.
//! - [`ThroughputMeter`] — an EMA of bytes/sec plus an ETA estimate.

use std::time::Duration;

use super::state::MAX_RETRIES;

/// Base delay for the first retry. Attempt `n` waits `BASE * 2^(n-1)`:
/// attempt 1 → 1s, attempt 2 → 2s, attempt 3 → 4s.
pub const BASE_BACKOFF: Duration = Duration::from_secs(1);

/// The exponential-backoff delay to wait *before* the next attempt, given how
/// many attempts have already failed (`failed_attempts`, 1-based).
///
/// Returns `None` once the retry budget is exhausted (`failed_attempts >=
/// MAX_RETRIES`), signalling the caller to surface a permanent failure rather
/// than retry again.
///
/// - `failed_attempts == 1` → `Some(1s)` (wait before attempt 2)
/// - `failed_attempts == 2` → `Some(2s)` (wait before attempt 3)
/// - `failed_attempts >= 3` → `None` (give up; `failed (3/3)`)
pub fn backoff_delay(failed_attempts: u32) -> Option<Duration> {
    if failed_attempts == 0 || failed_attempts >= MAX_RETRIES {
        return None;
    }
    // 2^(failed_attempts - 1), saturating to avoid overflow on absurd inputs.
    let factor = 1u32.checked_shl(failed_attempts - 1).unwrap_or(u32::MAX);
    Some(BASE_BACKOFF.saturating_mul(factor))
}

/// The `REST` offset to resume a transfer from, given the bytes already present
/// at the destination and the (optional) known total size.
///
/// - Unknown total → resume from whatever is already there.
/// - Partial (`present < total`) → resume from `present`.
/// - Already complete or larger than expected (`present >= total`) → `0`
///   (start over; a stale/oversized partial can't be trusted for `REST`).
pub fn resume_offset(present_bytes: u64, total: Option<u64>) -> u64 {
    match total {
        None => present_bytes,
        Some(total) if present_bytes < total => present_bytes,
        Some(_) => 0,
    }
}

/// Exponential-moving-average throughput meter for a single transfer.
///
/// Fed incremental `(bytes_since_last, elapsed_since_last)` samples; reports a
/// smoothed bytes/sec and an ETA for the remaining bytes. Kept sample-driven
/// (no `Instant` inside) so it is fully deterministic under test.
#[derive(Debug, Clone)]
pub struct ThroughputMeter {
    /// Smoothing factor in `(0, 1]`; higher reacts faster to recent samples.
    alpha: f64,
    speed_bps: f64,
    seeded: bool,
}

impl ThroughputMeter {
    /// Create a meter with the given smoothing factor (clamped to `(0, 1]`).
    pub fn new(alpha: f64) -> Self {
        Self {
            alpha: alpha.clamp(f64::MIN_POSITIVE, 1.0),
            speed_bps: 0.0,
            seeded: false,
        }
    }

    /// Record a sample of `bytes` transferred over `elapsed`, returning the
    /// updated smoothed speed in bytes/sec. Zero-duration samples are ignored.
    pub fn record(&mut self, bytes: u64, elapsed: Duration) -> f64 {
        let secs = elapsed.as_secs_f64();
        if secs <= 0.0 {
            return self.speed_bps;
        }
        let instant = bytes as f64 / secs;
        if self.seeded {
            self.speed_bps = self.alpha * instant + (1.0 - self.alpha) * self.speed_bps;
        } else {
            self.speed_bps = instant;
            self.seeded = true;
        }
        self.speed_bps
    }

    /// The current smoothed speed in bytes/sec (rounded, saturating to `u64`).
    pub fn speed_bps(&self) -> u64 {
        if self.speed_bps.is_finite() && self.speed_bps > 0.0 {
            self.speed_bps.round() as u64
        } else {
            0
        }
    }

    /// Estimated seconds remaining to move `remaining` bytes at the current
    /// speed. `None` when speed is zero (indeterminate) or nothing remains.
    pub fn eta_secs(&self, remaining: u64) -> Option<u64> {
        if remaining == 0 {
            return Some(0);
        }
        if self.speed_bps <= 0.0 || !self.speed_bps.is_finite() {
            return None;
        }
        Some((remaining as f64 / self.speed_bps).ceil() as u64)
    }
}

impl Default for ThroughputMeter {
    fn default() -> Self {
        // 0.3 balances responsiveness against jitter for ~10 Hz progress ticks.
        Self::new(0.3)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_exponential_then_gives_up() {
        assert_eq!(backoff_delay(1), Some(Duration::from_secs(1)));
        assert_eq!(backoff_delay(2), Some(Duration::from_secs(2)));
        // After the 3rd failure the budget is exhausted → permanent failure.
        assert_eq!(backoff_delay(3), None);
        assert_eq!(backoff_delay(4), None);
    }

    #[test]
    fn backoff_zero_is_none() {
        // No failure yet → nothing to wait for.
        assert_eq!(backoff_delay(0), None);
    }

    #[test]
    fn resume_offset_with_unknown_total_uses_present() {
        assert_eq!(resume_offset(500, None), 500);
        assert_eq!(resume_offset(0, None), 0);
    }

    #[test]
    fn resume_offset_partial_resumes_from_present() {
        assert_eq!(resume_offset(300, Some(1000)), 300);
    }

    #[test]
    fn resume_offset_complete_or_oversized_restarts() {
        // Exactly complete → restart (0), don't REST past EOF.
        assert_eq!(resume_offset(1000, Some(1000)), 0);
        // Oversized/stale partial → restart.
        assert_eq!(resume_offset(1200, Some(1000)), 0);
    }

    #[test]
    fn throughput_seeds_then_smooths() {
        let mut m = ThroughputMeter::new(0.5);
        // First sample seeds: 1000 bytes in 1s = 1000 B/s.
        assert_eq!(m.record(1000, Duration::from_secs(1)), 1000.0);
        // Second sample: 2000 B/s instant, EMA = 0.5*2000 + 0.5*1000 = 1500.
        assert_eq!(m.record(2000, Duration::from_secs(1)), 1500.0);
        assert_eq!(m.speed_bps(), 1500);
    }

    #[test]
    fn zero_duration_sample_is_ignored() {
        let mut m = ThroughputMeter::new(0.5);
        m.record(1000, Duration::from_secs(1));
        // A zero-elapsed tick must not divide-by-zero or change the speed.
        assert_eq!(m.record(9999, Duration::ZERO), 1000.0);
    }

    #[test]
    fn eta_uses_current_speed() {
        let mut m = ThroughputMeter::new(1.0);
        m.record(1000, Duration::from_secs(1)); // 1000 B/s
                                                // 5000 remaining bytes at 1000 B/s → 5s.
        assert_eq!(m.eta_secs(5000), Some(5));
    }

    #[test]
    fn eta_is_none_when_speed_unknown() {
        let m = ThroughputMeter::default();
        assert_eq!(m.eta_secs(1000), None);
    }

    #[test]
    fn eta_zero_remaining_is_zero() {
        let m = ThroughputMeter::default();
        assert_eq!(m.eta_secs(0), Some(0));
    }
}
