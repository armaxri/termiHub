//! Credential checks shared by the embedded servers: constant-time secret
//! comparison and a server-wide failed-login throttle (CORE2-003, #4292).
//!
//! # Constant-time comparison
//!
//! [`secret_eq`] reduces both sides to a SHA-256 digest and compares the
//! digests with [`subtle`], so neither the content nor the length of a secret
//! leaks through an early-exit byte comparison. Callers that check a username
//! and a password combine the two [`subtle::Choice`]s with `&` so a wrong
//! username is not distinguishable from a wrong password by timing.
//!
//! # Failed-login throttle
//!
//! The FTP server builds a fresh libunftp server per control connection
//! (#3996), so any lockout libunftp keeps would reset on every reconnect.
//! [`LoginThrottle`] lives for the whole server run instead and is shared by
//! every session: after [`MAX_FAILED_LOGINS`] failures from one client IP
//! within [`FAILURE_WINDOW`], that IP is refused for [`LOCKOUT`] without its
//! credentials being checked. The table is bounded by [`MAX_TRACKED_CLIENTS`]:
//! expired entries are pruned first, then the least recently active entry is
//! evicted, so a scan from many addresses cannot grow it without bound.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Constant-time equality of two secrets.
///
/// Each side is first reduced to a fixed-length SHA-256 digest, then the two
/// digests are compared in constant time. Hashing first makes the comparison
/// constant-time regardless of input length, so the secret's length cannot leak
/// through the early-exit on a length mismatch that a direct slice comparison
/// would expose.
pub(super) fn secret_eq(a: &[u8], b: &[u8]) -> subtle::Choice {
    let da = Sha256::digest(a);
    let db = Sha256::digest(b);
    da.as_slice().ct_eq(db.as_slice())
}

/// Failed logins from one client IP, within [`FAILURE_WINDOW`], that trigger a
/// lockout.
pub(super) const MAX_FAILED_LOGINS: u32 = 5;

/// The window in which [`MAX_FAILED_LOGINS`] failures trigger a lockout. It
/// starts at the first failure; once it has passed the count starts over.
pub(super) const FAILURE_WINDOW: Duration = Duration::from_secs(60);

/// How long a client IP is refused once it has been locked out.
pub(super) const LOCKOUT: Duration = Duration::from_secs(60);

/// Maximum number of client IPs the throttle tracks at once.
pub(super) const MAX_TRACKED_CLIENTS: usize = 1024;

/// Failure state of one client IP.
#[derive(Debug, Clone, Copy)]
struct ClientFailures {
    failures: u32,
    window_start: Instant,
    locked_until: Option<Instant>,
    last_seen: Instant,
}

impl ClientFailures {
    /// Whether this entry no longer affects anything at `now`: its window has
    /// passed and it is not (or no longer) locked out.
    fn expired(&self, now: Instant) -> bool {
        let window_over = now.saturating_duration_since(self.window_start) >= FAILURE_WINDOW;
        let unlocked = self.locked_until.is_none_or(|until| now >= until);
        window_over && unlocked
    }
}

/// Server-wide failed-login throttle keyed by client IP (see the module docs).
#[derive(Debug, Default)]
pub(super) struct LoginThrottle {
    clients: Mutex<HashMap<IpAddr, ClientFailures>>,
}

impl LoginThrottle {
    /// An empty throttle.
    pub(super) fn new() -> Self {
        Self::default()
    }

    fn clients(&self) -> MutexGuard<'_, HashMap<IpAddr, ClientFailures>> {
        // The map holds plain counters; a panic mid-update cannot leave it in
        // a state worse than a lost count, so a poisoned lock is still usable.
        self.clients.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether `client` is currently locked out.
    pub(super) fn is_locked(&self, client: IpAddr) -> bool {
        self.is_locked_at(client, Instant::now())
    }

    /// Record a failed login from `client`.
    pub(super) fn record_failure(&self, client: IpAddr) {
        self.record_failure_at(client, Instant::now());
    }

    /// Record a successful login from `client`, which clears its failures.
    pub(super) fn record_success(&self, client: IpAddr) {
        self.clients().remove(&client);
    }

    pub(super) fn is_locked_at(&self, client: IpAddr, now: Instant) -> bool {
        self.clients()
            .get(&client)
            .and_then(|entry| entry.locked_until)
            .is_some_and(|until| now < until)
    }

    pub(super) fn record_failure_at(&self, client: IpAddr, now: Instant) {
        let mut clients = self.clients();
        if !clients.contains_key(&client) && clients.len() >= MAX_TRACKED_CLIENTS {
            make_room(&mut clients, now);
        }
        let entry = clients.entry(client).or_insert(ClientFailures {
            failures: 0,
            window_start: now,
            locked_until: None,
            last_seen: now,
        });
        if entry.expired(now) {
            *entry = ClientFailures {
                failures: 0,
                window_start: now,
                locked_until: None,
                last_seen: now,
            };
        }
        entry.failures = entry.failures.saturating_add(1);
        entry.last_seen = now;
        if entry.failures >= MAX_FAILED_LOGINS && entry.locked_until.is_none() {
            entry.locked_until = Some(now + LOCKOUT);
        }
    }

    /// Number of client IPs currently tracked.
    #[cfg(test)]
    pub(super) fn tracked(&self) -> usize {
        self.clients().len()
    }
}

/// Free at least one slot in a full table: drop every expired entry, and if
/// none was expired, evict the least recently active one.
fn make_room(clients: &mut HashMap<IpAddr, ClientFailures>, now: Instant) {
    clients.retain(|_, entry| !entry.expired(now));
    if clients.len() < MAX_TRACKED_CLIENTS {
        return;
    }
    if let Some(oldest) = clients
        .iter()
        .min_by_key(|(_, entry)| entry.last_seen)
        .map(|(ip, _)| *ip)
    {
        clients.remove(&oldest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(n: u32) -> IpAddr {
        IpAddr::from(std::net::Ipv4Addr::from(0x0a00_0000 | n))
    }

    #[test]
    fn secret_eq_matches_equal_and_rejects_different_secrets() {
        // The return type is `subtle::Choice`: the comparison goes through the
        // constant-time path, never through `==` on the raw bytes.
        let same: subtle::Choice = secret_eq(b"hunter2", b"hunter2");
        let different: subtle::Choice = secret_eq(b"hunter2", b"hunter3");
        let shorter: subtle::Choice = secret_eq(b"hunter2", b"hunter");
        assert!(bool::from(same));
        assert!(!bool::from(different));
        assert!(!bool::from(shorter));
        assert!(bool::from(secret_eq(b"", b"")));
    }

    #[test]
    fn locks_out_after_max_failures_within_the_window() {
        let throttle = LoginThrottle::new();
        let t0 = Instant::now();
        for i in 0..MAX_FAILED_LOGINS - 1 {
            throttle.record_failure_at(ip(1), t0 + Duration::from_secs(u64::from(i)));
            assert!(!throttle.is_locked_at(ip(1), t0 + Duration::from_secs(u64::from(i))));
        }
        let last = t0 + Duration::from_secs(10);
        throttle.record_failure_at(ip(1), last);
        assert!(throttle.is_locked_at(ip(1), last));
        // Another client is unaffected.
        assert!(!throttle.is_locked_at(ip(2), last));
        // Still locked just before the lockout ends, released after it.
        assert!(throttle.is_locked_at(ip(1), last + LOCKOUT - Duration::from_millis(1)));
        assert!(!throttle.is_locked_at(ip(1), last + LOCKOUT));
    }

    #[test]
    fn failures_spread_beyond_the_window_do_not_lock_out() {
        let throttle = LoginThrottle::new();
        let t0 = Instant::now();
        for i in 0..MAX_FAILED_LOGINS * 3 {
            let now = t0 + FAILURE_WINDOW * i / (MAX_FAILED_LOGINS - 1);
            throttle.record_failure_at(ip(1), now);
            assert!(!throttle.is_locked_at(ip(1), now), "locked at failure {i}");
        }
    }

    #[test]
    fn a_successful_login_clears_the_failures() {
        let throttle = LoginThrottle::new();
        let t0 = Instant::now();
        for _ in 0..MAX_FAILED_LOGINS - 1 {
            throttle.record_failure_at(ip(1), t0);
        }
        throttle.record_success(ip(1));
        throttle.record_failure_at(ip(1), t0);
        assert!(!throttle.is_locked_at(ip(1), t0));
        assert_eq!(throttle.tracked(), 1);
    }

    #[test]
    fn the_tracking_table_is_bounded() {
        let throttle = LoginThrottle::new();
        let t0 = Instant::now();
        let extra = 50u32;
        for n in 0..MAX_TRACKED_CLIENTS as u32 + extra {
            throttle.record_failure_at(ip(n), t0 + Duration::from_millis(u64::from(n)));
        }
        assert_eq!(throttle.tracked(), MAX_TRACKED_CLIENTS);
        // The least recently active entries were the ones evicted.
        let clients = throttle.clients();
        assert!(!clients.contains_key(&ip(0)));
        assert!(clients.contains_key(&ip(MAX_TRACKED_CLIENTS as u32 + extra - 1)));
    }

    #[test]
    fn expired_entries_are_pruned_before_live_ones_are_evicted() {
        let throttle = LoginThrottle::new();
        let t0 = Instant::now();
        // Fill the table, then lock out one client half-way through the
        // window, so it is still locked once the others have expired.
        let locked_at = t0 + FAILURE_WINDOW / 2;
        for n in 1..MAX_TRACKED_CLIENTS as u32 {
            throttle.record_failure_at(ip(n), t0);
        }
        for _ in 0..MAX_FAILED_LOGINS {
            throttle.record_failure_at(ip(0), locked_at);
        }
        // Once the window has passed for the unlocked ones, a new client
        // prunes them but keeps the still-locked client.
        let after_window = t0 + FAILURE_WINDOW + Duration::from_millis(1);
        assert!(throttle.is_locked_at(ip(0), locked_at));
        throttle.record_failure_at(ip(99_999), after_window);
        assert_eq!(throttle.tracked(), 2);
        assert!(throttle.is_locked_at(ip(0), after_window));
    }
}
