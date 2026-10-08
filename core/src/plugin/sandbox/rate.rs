//! The per-runner output rate cap (#4203, concept "Untrusted peer").
//!
//! A runner may push `Output` frames as fast as the channel carries them (PR
//! #4200 measured ~3.5 GB/s); when no subscriber is attached the host drops
//! them as fast as they arrive, so a flooding plugin would keep one host
//! thread busy forever. The host therefore meters every `Output` byte of a
//! runner — across all of its sessions — with a token bucket: a sustained
//! rate plus a burst budget. Running the budget dry is a protocol violation
//! and kills the runner like any other ([`super::peer`]).
//!
//! The default sits far above the ≥ 100 MB/s throughput floor of the
//! performance budget: a terminal cannot render anywhere near it, and a
//! subscriber that falls behind already backpressures the runner (the host
//! blocks on delivery, which refills the bucket), so only a plugin flooding
//! output nobody consumes reaches it.

use std::time::{Duration, Instant};

/// The cap on one runner's `Output` bytes, across all its sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputRateCap {
    /// Sustained rate the budget refills at, in bytes per second.
    pub bytes_per_second: u64,
    /// Bytes a runner may send at once on top of the sustained rate (the
    /// bucket's size; it starts full).
    pub burst_bytes: u64,
}

impl OutputRateCap {
    /// Default sustained rate: 512 MiB/s, five times the throughput floor.
    pub const DEFAULT_BYTES_PER_SECOND: u64 = 512 * 1024 * 1024;
    /// Default burst budget: 1 GiB (the 256 MiB throughput run fits whole).
    pub const DEFAULT_BURST_BYTES: u64 = 1024 * 1024 * 1024;
}

impl Default for OutputRateCap {
    fn default() -> Self {
        Self {
            bytes_per_second: Self::DEFAULT_BYTES_PER_SECOND,
            burst_bytes: Self::DEFAULT_BURST_BYTES,
        }
    }
}

/// Token bucket enforcing an [`OutputRateCap`].
#[derive(Debug)]
pub(super) struct OutputMeter {
    cap: OutputRateCap,
    /// Bytes the runner may still send right now.
    available: u64,
    /// When `available` was last refilled.
    refilled: Instant,
}

impl OutputMeter {
    /// A full bucket for `cap`, as of `now`.
    pub(super) fn new(cap: OutputRateCap, now: Instant) -> Self {
        Self {
            cap,
            available: cap.burst_bytes,
            refilled: now,
        }
    }

    /// Charge `bytes` sent at `now`. `Err` (with a description) when the
    /// runner exceeded its cap: the caller treats it as a violation.
    pub(super) fn charge(&mut self, bytes: usize, now: Instant) -> Result<(), String> {
        self.refill(now);
        let bytes = u64::try_from(bytes).unwrap_or(u64::MAX);
        match self.available.checked_sub(bytes) {
            Some(rest) => {
                self.available = rest;
                Ok(())
            }
            None => Err(format!(
                "output rate cap exceeded ({} bytes/s, {} bytes burst)",
                self.cap.bytes_per_second, self.cap.burst_bytes
            )),
        }
    }

    fn refill(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.refilled);
        let earned = refill_bytes(self.cap.bytes_per_second, elapsed);
        if earned == 0 {
            // Too little time for a whole byte: keep the remainder accruing
            // rather than resetting the clock (tiny frames would never refill).
            return;
        }
        let refilled = self.available.saturating_add(earned);
        if refilled >= self.cap.burst_bytes {
            self.available = self.cap.burst_bytes;
            self.refilled = now;
        } else {
            self.available = refilled;
            // Advance the clock only by the time those whole bytes took, so
            // the fraction of a byte left over keeps accruing.
            self.refilled += time_for(self.cap.bytes_per_second, earned).min(elapsed);
        }
    }
}

/// Bytes earned at `rate` bytes/s over `elapsed`, saturating.
fn refill_bytes(rate: u64, elapsed: Duration) -> u64 {
    let earned = u128::from(rate) * elapsed.as_nanos() / 1_000_000_000;
    u64::try_from(earned).unwrap_or(u64::MAX)
}

/// How long earning `bytes` takes at `rate` bytes/s (`rate` > 0).
fn time_for(rate: u64, bytes: u64) -> Duration {
    let nanos = u128::from(bytes) * 1_000_000_000 / u128::from(rate.max(1));
    Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: OutputRateCap = OutputRateCap {
        bytes_per_second: 1000,
        burst_bytes: 4000,
    };

    #[test]
    fn the_default_is_far_above_the_throughput_floor() {
        let cap = OutputRateCap::default();
        // ≥ 100 MB/s is the performance budget's floor (#4190).
        assert!(cap.bytes_per_second >= 5 * 100 * 1000 * 1000);
        assert!(cap.burst_bytes >= 256 * 1024 * 1024);
    }

    #[test]
    fn a_burst_up_to_the_budget_is_allowed() {
        let start = Instant::now();
        let mut meter = OutputMeter::new(CAP, start);
        assert!(meter.charge(4000, start).is_ok());
        assert!(meter.charge(1, start).is_err());
    }

    #[test]
    fn the_budget_refills_at_the_sustained_rate() {
        let start = Instant::now();
        let mut meter = OutputMeter::new(CAP, start);
        meter.charge(4000, start).unwrap();
        // Half a second later: 500 bytes earned.
        let later = start + Duration::from_millis(500);
        assert!(meter.charge(500, later).is_ok());
        assert!(meter.charge(1, later).is_err());
    }

    #[test]
    fn sending_at_the_sustained_rate_never_trips() {
        let start = Instant::now();
        let mut meter = OutputMeter::new(CAP, start);
        for ms in 0..10_000u64 {
            let now = start + Duration::from_millis(ms);
            assert!(meter.charge(1, now).is_ok(), "tripped at {ms} ms");
        }
    }

    #[test]
    fn a_sustained_flood_trips_once_the_burst_is_spent() {
        let start = Instant::now();
        let mut meter = OutputMeter::new(CAP, start);
        // Twice the rate: the 4000-byte burst lasts about four seconds.
        let tripped = (0..10_000u64).find(|ms| {
            let now = start + Duration::from_millis(*ms);
            meter.charge(2, now).is_err()
        });
        let ms = tripped.expect("the flood trips the cap");
        assert!((3900..=4100).contains(&ms), "tripped at {ms} ms");
    }

    #[test]
    fn idle_time_never_grows_the_budget_past_the_burst() {
        let start = Instant::now();
        let mut meter = OutputMeter::new(CAP, start);
        let much_later = start + Duration::from_secs(3600);
        assert!(meter.charge(4000, much_later).is_ok());
        assert!(meter.charge(1, much_later).is_err());
    }

    #[test]
    fn tiny_frames_still_accrue_refill() {
        let start = Instant::now();
        let mut meter = OutputMeter::new(CAP, start);
        meter.charge(4000, start).unwrap();
        // 1 000 frames 100 µs apart: each step earns 0.1 byte, so the clock
        // must not be reset on a zero refill; after 0.1 s, 100 bytes are due.
        let mut sent = 0;
        for i in 1..=1000u64 {
            let now = start + Duration::from_micros(100 * i);
            if meter.charge(1, now).is_ok() {
                sent += 1;
            }
        }
        assert!((95..=100).contains(&sent), "sent {sent}");
    }

    #[test]
    fn uneven_frame_spacing_keeps_the_full_rate() {
        let start = Instant::now();
        let mut meter = OutputMeter::new(CAP, start);
        meter.charge(4000, start).unwrap();
        // One byte every 1.9 ms earns ~1.9 bytes per step: the leftover
        // fraction must carry over, so ~526 bytes are due after one second.
        let mut sent = 0u64;
        for i in 1..=526u64 {
            let now = start + Duration::from_micros(1900 * i);
            while meter.charge(1, now).is_ok() {
                sent += 1;
            }
        }
        assert!((990..=1000).contains(&sent), "sent {sent}");
    }

    #[test]
    fn a_huge_frame_is_refused_not_overflowed() {
        let start = Instant::now();
        let mut meter = OutputMeter::new(CAP, start);
        assert!(meter.charge(usize::MAX, start).is_err());
        assert!(meter.charge(4000, start).is_ok());
    }
}
