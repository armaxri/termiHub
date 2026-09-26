//! Unit tests for the per-plugin host log rate limiter (#3581). Time is driven
//! explicitly (`admit_at`, or an injected manual clock) — no sleeps.

use super::*;
use std::sync::Arc;

const MS: Duration = Duration::from_millis(1);

fn config(burst: u32, lines_per_sec: u32) -> LogRateLimitConfig {
    LogRateLimitConfig {
        burst,
        lines_per_sec,
        summary_interval: Duration::from_secs(1),
    }
}

/// A limiter on a manual clock starting at the returned instant.
fn limiter(burst: u32, lines_per_sec: u32) -> (PluginLogLimiter, Instant) {
    let t0 = Instant::now();
    (
        PluginLogLimiter::with_clock(config(burst, lines_per_sec), Box::new(move || t0)),
        t0,
    )
}

/// Admit `n` lines at `now`; return how many were emitted and every summary.
fn flood(l: &PluginLogLimiter, now: Instant, n: usize) -> (usize, Vec<u64>) {
    let mut emitted = 0;
    let mut summaries = Vec::new();
    for _ in 0..n {
        let a = l.admit_at(now, "echo");
        emitted += usize::from(a.emit);
        summaries.extend(a.summary);
    }
    (emitted, summaries)
}

#[test]
fn defaults_are_the_documented_values() {
    let c = LogRateLimitConfig::default();
    assert_eq!(c.burst, 100);
    assert_eq!(c.lines_per_sec, 20);
    assert_eq!(c.summary_interval, Duration::from_secs(1));
    assert_eq!(PluginLogLimiter::default().config(), c);
}

#[test]
fn a_burst_up_to_the_bucket_size_passes() {
    let (l, t0) = limiter(100, 20);
    let (emitted, summaries) = flood(&l, t0, 100);
    assert_eq!(emitted, 100);
    assert!(summaries.is_empty());
    assert_eq!(l.pending_suppressed(), 0);
}

#[test]
fn lines_beyond_the_burst_are_dropped() {
    let (l, t0) = limiter(100, 20);
    let (emitted, summaries) = flood(&l, t0, 150);
    assert_eq!(emitted, 100);
    assert!(summaries.is_empty(), "the window has not closed yet");
    assert_eq!(l.pending_suppressed(), 50);
}

#[test]
fn a_sustained_flood_is_capped_at_the_refill_rate() {
    let (l, t0) = limiter(100, 20);
    // 10 s of a tight loop: 1000 calls every 10 ms (100k calls/s).
    let mut emitted = 0;
    let mut suppressed = 0;
    for step in 0..=1000u32 {
        let now = t0 + 10 * MS * step;
        let (e, s) = flood(&l, now, 1000);
        emitted += e;
        suppressed += s.iter().sum::<u64>();
    }
    // Burst + 10 s × 20 lines/s, exactly (integer bucket, exact clock).
    assert_eq!(emitted, 100 + 200);
    // Every other call was dropped and counted by a summary (or is pending).
    let total = 1001 * 1000;
    assert_eq!(
        suppressed + l.pending_suppressed(),
        (total - emitted) as u64
    );
}

#[test]
fn the_bucket_refills_but_never_beyond_its_size() {
    let (l, t0) = limiter(10, 20);
    assert_eq!(flood(&l, t0, 10).0, 10);
    // 50 ms at 20 lines/s refills exactly one line.
    assert_eq!(flood(&l, t0 + 50 * MS, 5).0, 1);
    // A long idle refills to the bucket size, not more.
    assert_eq!(flood(&l, t0 + Duration::from_secs(3600), 50).0, 10);
}

#[test]
fn the_summary_is_emitted_once_the_window_closes() {
    let (l, t0) = limiter(2, 20);
    assert_eq!(flood(&l, t0, 5), (2, vec![]));
    assert_eq!(l.pending_suppressed(), 3);
    // Before the window closes: a refilled line is accepted, no summary yet.
    let a = l.admit_at(t0 + 500 * MS, "echo");
    assert_eq!(
        a,
        Admission {
            emit: true,
            summary: None
        }
    );
    // After it closes, the next call carries the summary exactly once.
    let a = l.admit_at(t0 + 1000 * MS, "echo");
    assert_eq!(
        a,
        Admission {
            emit: true,
            summary: Some(3)
        }
    );
    assert_eq!(l.pending_suppressed(), 0);
    let a = l.admit_at(t0 + 1001 * MS, "echo");
    assert_eq!(a.summary, None, "one summary per window");
}

#[test]
fn a_dropped_call_can_close_the_window_too() {
    let (l, t0) = limiter(1, 1);
    assert_eq!(flood(&l, t0, 4), (1, vec![]));
    // At 999 ms the bucket is still empty; at 1000 ms the window closes. The
    // 1000 ms call gets the refilled token and reports the three drops.
    assert_eq!(l.admit_at(t0 + 999 * MS, "echo").summary, None);
    let a = l.admit_at(t0 + 1000 * MS, "echo");
    assert_eq!(
        a,
        Admission {
            emit: true,
            summary: Some(4)
        }
    );
    // A flood that keeps dropping still reports once per interval.
    let (_, s) = flood(&l, t0 + 1500 * MS, 10);
    assert!(s.is_empty());
    let (_, s) = flood(&l, t0 + 2500 * MS, 10);
    assert_eq!(s, vec![10]);
}

#[test]
fn summaries_are_capped_at_one_per_interval_at_the_edge_rate() {
    // A plugin logging at exactly twice the rate forever: the host adds at
    // most one summary line per second on top of the accepted lines.
    let (l, t0) = limiter(1, 10);
    let mut summaries = 0;
    for step in 0..200u32 {
        summaries += flood(&l, t0 + 50 * MS * step, 1).1.len();
    }
    assert!(summaries <= 10, "{summaries} summaries in 10 s");
    assert!(summaries >= 9, "the flood is still reported: {summaries}");
}

#[test]
fn a_backwards_clock_refills_nothing_and_does_not_panic() {
    let (l, t0) = limiter(1, 20);
    let later = t0 + Duration::from_secs(1);
    assert!(l.admit_at(later, "echo").emit);
    assert!(!l.admit_at(t0, "echo").emit);
}

#[test]
fn the_injected_clock_drives_admit() {
    let now = Arc::new(Mutex::new(Instant::now()));
    let clock_now = Arc::clone(&now);
    let l =
        PluginLogLimiter::with_clock(config(1, 1), Box::new(move || *clock_now.lock().unwrap()));
    assert!(l.admit("echo").emit);
    assert!(!l.admit("echo").emit);
    *now.lock().unwrap() += Duration::from_secs(1);
    assert_eq!(
        l.admit("echo"),
        Admission {
            emit: true,
            summary: Some(1)
        }
    );
}

#[test]
fn limiters_are_independent_per_plugin() {
    let (noisy, t0) = limiter(5, 20);
    let (quiet, _) = limiter(5, 20);
    flood(&noisy, t0, 10_000);
    assert_eq!(flood(&quiet, t0, 5).0, 5);
    assert_eq!(quiet.pending_suppressed(), 0);
}

#[test]
fn concurrent_callers_share_one_budget() {
    let (l, t0) = limiter(100, 20);
    let l = Arc::new(l);
    let emitted: usize = std::thread::scope(|s| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let l = Arc::clone(&l);
                s.spawn(move || flood(&l, t0, 1000).0)
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).sum()
    });
    assert_eq!(emitted, 100);
    assert_eq!(l.pending_suppressed(), 8000 - 100);
}

#[test]
fn a_poisoned_lock_is_recovered_not_propagated() {
    let (l, t0) = limiter(1, 20);
    let l = Arc::new(l);
    let poisoner = Arc::clone(&l);
    let _ = std::thread::spawn(move || {
        let _guard = poisoner.bucket.lock().unwrap();
        panic!("poison the bucket");
    })
    .join();
    assert!(l.bucket.is_poisoned());
    assert!(l.admit_at(t0, "echo").emit);
    assert!(!l.admit_at(t0, "echo").emit);
}

#[test]
fn dropping_with_a_pending_window_flushes_without_panicking() {
    let (l, t0) = limiter(1, 20);
    flood(&l, t0, 5);
    assert_eq!(l.pending_suppressed(), 4);
    drop(l); // emits the summary; must not panic
}

#[test]
fn the_summary_text_names_the_count() {
    assert_eq!(
        compose_plugin_log("echo", &suppression_summary_text(42)),
        "[echo] 42 log lines suppressed (host log rate limit exceeded)"
    );
    assert_eq!(
        suppression_summary_text(1),
        "1 log line suppressed (host log rate limit exceeded)"
    );
}
