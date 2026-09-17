//! Shared capped-exponential-backoff MATH for reconnect/retry loops (DUP-007 /
//! LIBBE-004).
//!
//! Several reconnect and retry loops across the workspace independently
//! hand-rolled the same `delay = base * 2^attempt` (clamped to a cap)
//! computation. This module provides the single source of that MATH so the
//! sites stop reimplementing it.
//!
//! Scope is deliberately narrow: this consolidates only the per-attempt **delay
//! value**. Each call site keeps its own control flow — when and whether to
//! retry, the attempt budget, the alive/cancel checks, and how it sleeps. The
//! delay value produced here is bit-identical to what each migrated site
//! produced before (same base, same factor of 2, same cap, same saturating
//! rounding); see the unit tests for the per-site sequences.
//!
//! The jittered, `f64`-millisecond, configurable-factor schedule used by the
//! agentless auto-reconnect state machine lives in
//! [`crate::reconnect_backoff`] and is intentionally *not* folded in here: it is
//! a different numeric domain (floating-point + symmetric random jitter,
//! proven against TypeScript golden vectors) and routing it through this integer
//! helper would change its rounding and jitter semantics.

use std::time::Duration;

/// Capped exponential backoff delay for a 0-based `attempt` index.
///
/// Returns `base * 2^attempt`, clamped to `cap`. Arithmetic is saturating, so a
/// large `attempt` can never overflow: once the doubled value would exceed
/// `cap`, the result plateaus at exactly `cap`.
///
/// The growth factor is fixed at 2 — the value every migrated site used. Callers
/// that number attempts from 1 pass `attempt - 1` (use
/// [`u32::saturating_sub`]) to keep the first delay equal to `base`.
///
/// # Examples
///
/// ```
/// use std::time::Duration;
/// use termihub_core::util::backoff::capped_exponential_delay;
///
/// let base = Duration::from_secs(1);
/// let cap = Duration::from_secs(30);
/// assert_eq!(capped_exponential_delay(base, 0, cap), Duration::from_secs(1));
/// assert_eq!(capped_exponential_delay(base, 4, cap), Duration::from_secs(16));
/// // Plateaus at the cap once doubling would exceed it.
/// assert_eq!(capped_exponential_delay(base, 5, cap), Duration::from_secs(30));
/// assert_eq!(capped_exponential_delay(base, 99, cap), Duration::from_secs(30));
/// ```
pub fn capped_exponential_delay(base: Duration, attempt: u32, cap: Duration) -> Duration {
    let factor = 2u32.saturating_pow(attempt);
    base.saturating_mul(factor).min(cap)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The first N delays for a 0-based attempt index.
    fn sequence(base: Duration, cap: Duration, n: u32) -> Vec<Duration> {
        (0..n)
            .map(|attempt| capped_exponential_delay(base, attempt, cap))
            .collect()
    }

    #[test]
    fn doubles_from_base_then_clamps_to_cap() {
        let base = Duration::from_secs(1);
        let cap = Duration::from_secs(30);
        // base, base*2, base*4, … clamped to cap.
        assert_eq!(
            sequence(base, cap, 8),
            vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4),
                Duration::from_secs(8),
                Duration::from_secs(16),
                Duration::from_secs(30),
                Duration::from_secs(30),
                Duration::from_secs(30),
            ]
        );
    }

    #[test]
    fn saturates_without_overflow_for_huge_attempts() {
        let base = Duration::from_secs(1);
        let cap = Duration::from_secs(30);
        // A very large attempt must not panic and must plateau at the cap.
        assert_eq!(capped_exponential_delay(base, u32::MAX, cap), cap);
        assert_eq!(capped_exponential_delay(base, 1_000, cap), cap);
    }

    #[test]
    fn first_delay_equals_base() {
        assert_eq!(
            capped_exponential_delay(Duration::from_millis(250), 0, Duration::from_secs(10)),
            Duration::from_millis(250)
        );
    }

    // ── Per-site exact-sequence guards ────────────────────────────────────
    // Each of the following asserts the migrated site's delay sequence is
    // bit-identical to what its hand-rolled computation produced before the
    // consolidation (DUP-007). The pre-consolidation formulas are reproduced in
    // each test's comment.

    /// `core::monitoring::status::BackoffSchedule::next_delay` (0-based):
    /// `base.saturating_mul(2u32.saturating_pow(attempt)).min(cap)` with
    /// `base = 1s`, `cap = 30s`.
    #[test]
    fn matches_monitoring_backoff_schedule() {
        let base = DEFAULT_BASE_1S;
        let cap = CAP_30S;
        assert_eq!(
            sequence(base, cap, 8),
            vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4),
                Duration::from_secs(8),
                Duration::from_secs(16),
                Duration::from_secs(30),
                Duration::from_secs(30),
                Duration::from_secs(30),
            ]
        );
    }

    /// `src-tauri tunnel_manager::backoff_delay` (1-based):
    /// `base.saturating_mul(2u32.saturating_pow(attempt - 1)).min(cap)`.
    /// Callers pass `attempt.saturating_sub(1)` to the shared helper.
    #[test]
    fn matches_tunnel_backoff_1_based() {
        let base = Duration::from_secs(1);
        let cap = Duration::from_secs(30);
        // Old: for n in 1..=max { base * 2^(n-1) clamped to cap }.
        let old = |attempt: u32| -> Duration {
            let factor = 2u32.saturating_pow(attempt.saturating_sub(1));
            base.saturating_mul(factor).min(cap)
        };
        for n in 1..=12u32 {
            assert_eq!(
                capped_exponential_delay(base, n.saturating_sub(1), cap),
                old(n),
                "1-based attempt {n}"
            );
        }
    }

    /// `src-tauri terminal::agent_manager` reconnect (0-based):
    /// `Duration::from_secs(min(2u64.pow(attempt), 30))` for attempt in 0..10.
    #[test]
    fn matches_agent_manager_reconnect() {
        let base = Duration::from_secs(1);
        let cap = Duration::from_secs(30);
        // Old computation over the real, bounded attempt domain (MAX_RETRIES=10).
        let old = |attempt: u32| Duration::from_secs(2u64.pow(attempt).min(30));
        for attempt in 0..10u32 {
            assert_eq!(
                capped_exponential_delay(base, attempt, cap),
                old(attempt),
                "agent-manager attempt {attempt}"
            );
        }
    }

    /// `src-tauri files::transfer::retry::backoff_delay` (1-based
    /// `failed_attempts`): `BASE.saturating_mul(1u32.checked_shl(n-1))` with
    /// `BASE = 1s` and no cap (the retry budget bounds it). Callers pass
    /// `failed_attempts - 1` and an effectively-unbounded cap.
    #[test]
    fn matches_ftp_retry_backoff() {
        let base = Duration::from_secs(1);
        // Old shift form over the real domain (failed_attempts 1..MAX_RETRIES).
        let old = |failed: u32| -> Duration {
            let factor = 1u32.checked_shl(failed - 1).unwrap_or(u32::MAX);
            base.saturating_mul(factor)
        };
        for failed in 1..=8u32 {
            assert_eq!(
                capped_exponential_delay(base, failed - 1, Duration::MAX),
                old(failed),
                "ftp-retry failed_attempts {failed}"
            );
        }
    }

    /// `core::monitoring::http_monitor::PollSchedule::record` (0-based
    /// `consecutive_failures`): `interval.saturating_mul(min(1<<failures, 30))`.
    /// Routed as `capped_exponential_delay(interval, failures, interval*30)`,
    /// which is identical because `interval*min(2^f,cap) == min(interval*2^f,
    /// interval*cap)` for a positive interval.
    #[test]
    fn matches_http_monitor_backoff() {
        let interval = Duration::from_secs(5);
        let max_mult = 30u32;
        let cap = interval.saturating_mul(max_mult);
        let old = |failures: u32| -> Duration {
            let mult = if failures == 0 {
                1
            } else {
                1u32.checked_shl(failures).unwrap_or(u32::MAX).min(max_mult)
            };
            interval.saturating_mul(mult)
        };
        for failures in 0..64u32 {
            assert_eq!(
                capped_exponential_delay(interval, failures, cap),
                old(failures),
                "http-monitor consecutive_failures {failures}"
            );
        }
    }

    /// `core::backends::ftp::reconnect::reconnect_backoff` (0-based):
    /// `100ms * (1 << min(attempt, 4))`, itself clamped to 2000ms. Because the
    /// shift is capped at 4 the value plateaus at 1600ms (the 2000ms clamp is
    /// never reached), so the shared helper reproduces it with `cap = 1600ms`.
    #[test]
    fn matches_ftp_reconnect_backoff() {
        let base = Duration::from_millis(100);
        let cap = Duration::from_millis(1600);
        // Old shift-capped computation.
        let old = |attempt: usize| -> Duration {
            let shift = attempt.min(4) as u32;
            let ms = 100u64.saturating_mul(1u64 << shift);
            Duration::from_millis(ms.min(2000))
        };
        for attempt in 0..12usize {
            assert_eq!(
                capped_exponential_delay(base, attempt as u32, cap),
                old(attempt),
                "ftp attempt {attempt}"
            );
        }
        // Far-out attempt still plateaus identically.
        assert_eq!(capped_exponential_delay(base, 100, cap), old(100));
    }

    const DEFAULT_BASE_1S: Duration = Duration::from_secs(1);
    const CAP_30S: Duration = Duration::from_secs(30);
}
