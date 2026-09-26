//! Pure retry/backoff, resume-offset, and throughput math (issue #1336).
//!
//! All three are needed by the FTP executor but have zero I/O, so they live
//! here as free functions / small structs and are unit-tested directly:
//!
//! - [`backoff_delay`] — exponential backoff schedule for auto-retry.
//! - [`resume_offset`] — the `REST` byte offset for resuming a partial transfer.
//! - [`ThroughputMeter`] — an EMA of bytes/sec plus an ETA estimate.
//! - [`SourceFingerprint`] / [`decide_resume`] — the safe-resume gate shared by
//!   the offset-resuming executors (PARITY-004).

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
    // `BASE_BACKOFF * 2^(failed_attempts - 1)` via the shared capped-exponential
    // MATH (DUP-007 / LIBBE-004). Attempts are 1-based here, so `failed_attempts
    // - 1` is passed to the 0-based helper. There is no delay cap (the retry
    // budget above bounds it), so `Duration::MAX` is passed as the cap; the
    // helper's saturating arithmetic keeps a large attempt from overflowing.
    Some(crate::util::backoff::capped_exponential_delay(
        BASE_BACKOFF,
        failed_attempts - 1,
        Duration::MAX,
    ))
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

/// Identity of a transfer's **source** file at a point in time: its size plus
/// (when the backend reports one) its modification time (PARITY-004, #3567).
///
/// A resume may only append the not-yet-copied tail when the source is still
/// the *same* file it was when the earlier bytes were copied — otherwise the
/// destination would end up as a splice of two different versions. The
/// executors capture a baseline when the transfer starts and re-capture before
/// every resumed attempt; any difference restarts the copy from byte zero.
///
/// `mtime` is opaque and only ever compared against a fingerprint taken from
/// the same source by the same backend (SFTP reports whole seconds, the local
/// filesystem nanoseconds), so its unit does not matter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceFingerprint {
    /// Source size in bytes.
    pub size: u64,
    /// Source modification time in a backend-specific unit, when known.
    pub mtime: Option<u64>,
}

impl SourceFingerprint {
    /// Whether `current` still describes the same source as `self` (the
    /// baseline): the sizes match, and the modification times match whenever
    /// both are known. A missing mtime on either side falls back to size only.
    pub fn same_source(&self, current: &SourceFingerprint) -> bool {
        if self.size != current.size {
            return false;
        }
        match (self.mtime, current.mtime) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        }
    }
}

/// What a resumed attempt should do, decided by [`decide_resume`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeDecision {
    /// Append from this verified byte offset (`> 0`).
    Resume(u64),
    /// Start from byte zero: nothing to resume (fresh transfer / offset `0`),
    /// or resume is disabled.
    Fresh,
    /// Start from byte zero because the source changed (or can no longer be
    /// identified) since the earlier bytes were copied.
    RestartSourceChanged,
    /// Start from byte zero because the destination partial cannot be trusted
    /// (absent, un-stattable, longer than we wrote, or already complete).
    RestartUnverified,
}

impl ResumeDecision {
    /// The byte offset the attempt starts from.
    pub fn offset(self) -> u64 {
        match self {
            ResumeDecision::Resume(offset) => offset,
            _ => 0,
        }
    }
}

/// Decide where a resumed attempt may safely start (PARITY-004, #3567). Pure.
///
/// - `requested` — the offset the previous attempt reached (`0` → [`Fresh`]).
/// - `baseline` / `current` — the source fingerprint when the transfer started
///   and right now. The source must be verifiably unchanged; an unknown
///   fingerprint on either side cannot be trusted →
///   [`RestartSourceChanged`].
/// - `present` — bytes actually at the destination right now.
/// - `total` — the source size (`0` = unknown).
///
/// The destination is **byte-verified**: it must hold a prefix we wrote, i.e.
/// `present <= requested`. A *shorter* partial is still trustworthy — the copy
/// writes sequentially, so after a dropped connection the bytes that landed are
/// a prefix of the (unchanged) source, and the pipelined writes that were lost
/// in flight are simply re-sent. The resume starts from `present`, never from
/// `requested`, so a lost write can never leave a hole. A destination *longer*
/// than we wrote, an un-stattable one, or one already at/over `total` restarts
/// from zero ([`RestartUnverified`]).
///
/// [`Fresh`]: ResumeDecision::Fresh
/// [`RestartSourceChanged`]: ResumeDecision::RestartSourceChanged
/// [`RestartUnverified`]: ResumeDecision::RestartUnverified
pub fn decide_resume(
    requested: u64,
    baseline: Option<SourceFingerprint>,
    current: Option<SourceFingerprint>,
    present: Option<u64>,
    total: u64,
) -> ResumeDecision {
    if requested == 0 {
        return ResumeDecision::Fresh;
    }
    match (baseline, current) {
        (Some(b), Some(c)) if b.same_source(&c) => {}
        _ => return ResumeDecision::RestartSourceChanged,
    }
    let Some(present) = present else {
        return ResumeDecision::RestartUnverified;
    };
    if present > requested {
        return ResumeDecision::RestartUnverified;
    }
    match resume_offset(present, (total > 0).then_some(total)) {
        0 => ResumeDecision::RestartUnverified,
        offset => ResumeDecision::Resume(offset),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(size: u64, mtime: Option<u64>) -> Option<SourceFingerprint> {
        Some(SourceFingerprint { size, mtime })
    }

    #[test]
    fn same_source_compares_size_and_known_mtimes() {
        let base = SourceFingerprint {
            size: 10,
            mtime: Some(5),
        };
        assert!(base.same_source(&SourceFingerprint {
            size: 10,
            mtime: Some(5)
        }));
        assert!(!base.same_source(&SourceFingerprint {
            size: 11,
            mtime: Some(5)
        }));
        assert!(!base.same_source(&SourceFingerprint {
            size: 10,
            mtime: Some(6)
        }));
        // Unknown mtime on either side → size decides.
        assert!(base.same_source(&SourceFingerprint {
            size: 10,
            mtime: None
        }));
    }

    #[test]
    fn decide_resume_zero_request_is_fresh() {
        assert_eq!(
            decide_resume(0, fp(10, None), fp(10, None), Some(0), 10),
            ResumeDecision::Fresh
        );
        assert_eq!(decide_resume(0, None, None, None, 0).offset(), 0);
    }

    #[test]
    fn decide_resume_exact_partial_resumes() {
        let d = decide_resume(300, fp(1000, Some(1)), fp(1000, Some(1)), Some(300), 1000);
        assert_eq!(d, ResumeDecision::Resume(300));
        assert_eq!(d.offset(), 300);
    }

    #[test]
    fn decide_resume_shorter_partial_resumes_from_present() {
        // Pipelined writes lost in flight on a drop: resume from what landed,
        // never from the optimistic counter (which would leave a hole).
        assert_eq!(
            decide_resume(300, fp(1000, None), fp(1000, None), Some(250), 1000),
            ResumeDecision::Resume(250)
        );
    }

    #[test]
    fn decide_resume_longer_or_missing_partial_restarts() {
        assert_eq!(
            decide_resume(300, fp(1000, None), fp(1000, None), Some(400), 1000),
            ResumeDecision::RestartUnverified
        );
        assert_eq!(
            decide_resume(300, fp(1000, None), fp(1000, None), None, 1000),
            ResumeDecision::RestartUnverified
        );
        assert_eq!(
            decide_resume(300, fp(1000, None), fp(1000, None), Some(0), 1000),
            ResumeDecision::RestartUnverified
        );
    }

    #[test]
    fn decide_resume_complete_partial_restarts() {
        assert_eq!(
            decide_resume(1000, fp(1000, None), fp(1000, None), Some(1000), 1000),
            ResumeDecision::RestartUnverified
        );
    }

    #[test]
    fn decide_resume_unknown_total_resumes_verified_partial() {
        assert_eq!(
            decide_resume(500, fp(0, None), fp(0, None), Some(500), 0),
            ResumeDecision::Resume(500)
        );
    }

    #[test]
    fn decide_resume_changed_source_restarts() {
        // Size changed.
        assert_eq!(
            decide_resume(300, fp(1000, Some(1)), fp(1200, Some(1)), Some(300), 1200),
            ResumeDecision::RestartSourceChanged
        );
        // Same size, rewritten (mtime moved).
        assert_eq!(
            decide_resume(300, fp(1000, Some(1)), fp(1000, Some(2)), Some(300), 1000),
            ResumeDecision::RestartSourceChanged
        );
    }

    #[test]
    fn decide_resume_unidentifiable_source_restarts() {
        assert_eq!(
            decide_resume(300, None, fp(1000, None), Some(300), 1000),
            ResumeDecision::RestartSourceChanged
        );
        assert_eq!(
            decide_resume(300, fp(1000, None), None, Some(300), 1000),
            ResumeDecision::RestartSourceChanged
        );
    }

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
