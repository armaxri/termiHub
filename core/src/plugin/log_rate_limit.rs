//! Per-plugin rate limit for the ABI 1.1 host log callback (#3581).
//!
//! A native plugin logs through
//! [`PluginHostServices::log`](termihub_plugin_api::PluginHostServices::log).
//! Without a limit, a buggy plugin logging in a tight loop would flood the Log
//! Viewer's shared ring buffer (evicting every other target's entries) and grow
//! the log file. Every loaded plugin therefore owns one [`PluginLogLimiter`],
//! shared by all of its sessions and services handles.
//!
//! # Policy
//!
//! A **token bucket**: the bucket holds at most [`DEFAULT_LOG_BURST`] lines and
//! refills at [`DEFAULT_LOG_LINES_PER_SEC`] lines per second. A line that finds
//! the bucket empty is **dropped** (the callback still returns `Ok` — see
//! `termihub_plugin_api::context`). Dropped lines are counted, and the host
//! emits one `[<id>] N log lines suppressed …` warning per suppression window
//! of at least [`SUPPRESSION_SUMMARY_INTERVAL`].
//!
//! # When the summary is emitted
//!
//! The summary is emitted **lazily**, on the plugin's next log call (accepted or
//! dropped) once the window has closed, and — so a flood followed by silence is
//! never lost — when the limiter is dropped (the plugin is unloaded). A timer
//! thread per plugin was rejected: it would cost a thread (or a runtime
//! dependency in a crate that must stay runtime-agnostic) for every loaded
//! plugin, just to shorten the delay of a diagnostic line. During a flood the
//! calls keep coming, so the summary appears within about one interval; the
//! lazy path also caps the host's own summaries at one per interval, so a
//! plugin logging right at the edge of the rate cannot make the host double
//! its line count.
//!
//! # Thread safety
//!
//! Plugins may log from any number of threads. The bucket sits behind a
//! [`Mutex`]; a poisoned lock is recovered rather than unwrapped (nothing here
//! may panic across FFI), and the log line itself is emitted **after** the lock
//! is released so a slow subscriber never serialises the plugin's threads on
//! the bucket.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::host_context::{compose_plugin_log, PLUGIN_LOG_TARGET};

/// Lines a plugin may log back-to-back before the limit engages (the bucket
/// size). Generous enough for a startup banner or a short error cascade, and a
/// small fraction of the Log Viewer's 2000-entry buffer.
pub const DEFAULT_LOG_BURST: u32 = 100;

/// Sustained lines per second a plugin may log once its burst is spent. A
/// plugin at this rate indefinitely is still readable in the Log Viewer; more
/// is almost certainly a loop.
pub const DEFAULT_LOG_LINES_PER_SEC: u32 = 20;

/// Minimum length of one suppression window: the host emits at most one
/// "lines suppressed" summary per plugin per interval.
pub const SUPPRESSION_SUMMARY_INTERVAL: Duration = Duration::from_secs(1);

/// One token, in the bucket's fixed-point unit (nanotokens). Integer math keeps
/// the limiter exact and deterministic under an injected clock.
const TOKEN: u128 = 1_000_000_000;

/// The limiter's tunables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogRateLimitConfig {
    /// Bucket size: lines accepted back-to-back from a full bucket.
    pub burst: u32,
    /// Refill rate: sustained lines per second.
    pub lines_per_sec: u32,
    /// Minimum suppression-window length before a summary is emitted.
    pub summary_interval: Duration,
}

impl Default for LogRateLimitConfig {
    fn default() -> Self {
        Self {
            burst: DEFAULT_LOG_BURST,
            lines_per_sec: DEFAULT_LOG_LINES_PER_SEC,
            summary_interval: SUPPRESSION_SUMMARY_INTERVAL,
        }
    }
}

/// The time source. Injectable so tests are deterministic (no sleeps).
pub(crate) type Clock = Box<dyn Fn() -> Instant + Send + Sync>;

/// What the host should do with one log call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Admission {
    /// Emit the plugin's line (`false` = drop it).
    pub emit: bool,
    /// Emit a "N lines suppressed" summary **before** the line, if `Some(N)`.
    pub summary: Option<u64>,
}

/// Mutable bucket state.
#[derive(Debug)]
struct Bucket {
    /// Available tokens, in nanotokens.
    tokens: u128,
    /// When `tokens` was last refilled.
    last_refill: Instant,
    /// Lines dropped in the current suppression window.
    suppressed: u64,
    /// When the current suppression window opened (its first drop).
    window_start: Option<Instant>,
    /// Tag for the unload-time summary: the host-trusted id of the handle
    /// whose line was first dropped in this window.
    tag: Option<String>,
}

/// A per-plugin token-bucket limiter for host log lines.
pub struct PluginLogLimiter {
    config: LogRateLimitConfig,
    clock: Clock,
    bucket: Mutex<Bucket>,
}

impl std::fmt::Debug for PluginLogLimiter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginLogLimiter")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl Default for PluginLogLimiter {
    fn default() -> Self {
        Self::new(LogRateLimitConfig::default())
    }
}

impl PluginLogLimiter {
    /// A limiter with `config` on the real monotonic clock, starting full.
    #[must_use]
    pub fn new(config: LogRateLimitConfig) -> Self {
        Self::with_clock(config, Box::new(Instant::now))
    }

    /// A limiter with `config` on an injected `clock`, starting full.
    pub(crate) fn with_clock(config: LogRateLimitConfig, clock: Clock) -> Self {
        let now = clock();
        Self {
            config,
            clock,
            bucket: Mutex::new(Bucket {
                tokens: u128::from(config.burst) * TOKEN,
                last_refill: now,
                suppressed: 0,
                window_start: None,
                tag: None,
            }),
        }
    }

    /// The limiter's tunables.
    #[must_use]
    pub fn config(&self) -> LogRateLimitConfig {
        self.config
    }

    fn lock(&self) -> MutexGuard<'_, Bucket> {
        // A panic while holding the lock cannot leave the bucket inconsistent
        // in a way that matters (worst case one miscounted line), and nothing
        // here may panic across FFI — so recover instead of unwrapping.
        self.bucket
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Decide one log call from the handle tagged `tag`, at the clock's now.
    pub(crate) fn admit(&self, tag: &str) -> Admission {
        self.admit_at((self.clock)(), tag)
    }

    /// Decide one log call from the handle tagged `tag`, at `now`.
    pub(crate) fn admit_at(&self, now: Instant, tag: &str) -> Admission {
        let config = self.config;
        let mut bucket = self.lock();

        // Refill. A clock that steps backwards refills nothing (never panics).
        let elapsed = now.saturating_duration_since(bucket.last_refill);
        if now > bucket.last_refill {
            bucket.last_refill = now;
        }
        let capacity = u128::from(config.burst) * TOKEN;
        let refill = elapsed
            .as_nanos()
            .saturating_mul(u128::from(config.lines_per_sec));
        bucket.tokens = bucket.tokens.saturating_add(refill).min(capacity);

        let emit = if bucket.tokens >= TOKEN {
            bucket.tokens -= TOKEN;
            true
        } else {
            if bucket.suppressed == 0 {
                bucket.window_start = Some(now);
            }
            if bucket.tag.is_none() {
                bucket.tag = Some(tag.to_owned());
            }
            bucket.suppressed = bucket.suppressed.saturating_add(1);
            false
        };

        let window_closed = bucket
            .window_start
            .is_some_and(|start| now.saturating_duration_since(start) >= config.summary_interval);
        let summary = if bucket.suppressed > 0 && window_closed {
            let count = bucket.suppressed;
            bucket.suppressed = 0;
            bucket.window_start = None;
            bucket.tag = None;
            Some(count)
        } else {
            None
        };
        Admission { emit, summary }
    }

    /// Lines dropped in the still-open suppression window.
    #[must_use]
    pub fn pending_suppressed(&self) -> u64 {
        self.lock().suppressed
    }
}

impl Drop for PluginLogLimiter {
    /// Flush a still-open window, so a flood followed by silence is still
    /// reported when the plugin is unloaded.
    fn drop(&mut self) {
        let bucket = self
            .bucket
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if bucket.suppressed > 0 {
            if let Some(tag) = bucket.tag.take() {
                emit_suppression_summary(&tag, bucket.suppressed);
            }
            bucket.suppressed = 0;
        }
    }
}

/// The summary text for `count` dropped lines (without the `[<id>]` tag).
pub(crate) fn suppression_summary_text(count: u64) -> String {
    let noun = if count == 1 { "line" } else { "lines" };
    format!("{count} log {noun} suppressed (host log rate limit exceeded)")
}

/// Emit the suppression summary for plugin `plugin_id` as a warning.
pub(crate) fn emit_suppression_summary(plugin_id: &str, count: u64) {
    let line = compose_plugin_log(plugin_id, &suppression_summary_text(count));
    tracing::warn!(target: PLUGIN_LOG_TARGET, "{line}");
}

#[cfg(test)]
#[path = "log_rate_limit_tests.rs"]
mod tests;
