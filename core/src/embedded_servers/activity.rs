//! Per-server access log and detailed activity statistics (PROD-034, PROD-036).
//!
//! Every embedded HTTP/FTP/TFTP server records one [`AccessLogEntry`] per
//! request (HTTP request, FTP command, TFTP RRQ/WRQ) into its
//! [`ServerActivity`]. The log is a bounded in-memory ring buffer
//! ([`ACCESS_LOG_CAPACITY`] entries): once full, the oldest entry is evicted and
//! a `dropped` counter is bumped, so memory stays bounded however busy the
//! server gets.
//!
//! # Never blocks serving
//!
//! Recording is an O(1) push under a short, uncontended [`Mutex`] — no I/O, no
//! `await`, no allocation proportional to the log size. The serving path
//! therefore never waits on the log. Aggregations that could grow without bound
//! (distinct paths / clients) are capped at [`MAX_TRACKED_KEYS`] keys each.
//!
//! # Secrets
//!
//! Entries carry the client address, the (FTP / HTTP Basic) *username*, the
//! method/command and the path — never a password or `Authorization` header,
//! and for HTTP never the query string (which may carry tokens). Every string
//! field is truncated to [`MAX_FIELD_CHARS`] characters.
//!
//! # Incremental reads
//!
//! Each entry gets a monotonically increasing `seq`. A reader passes the last
//! `seq` it has seen and receives only newer entries ([`ServerActivity::snapshot`]).
//! [`ServerActivity::clear`] empties the log and bumps an `epoch` so a reader
//! knows to drop what it already holds; `seq` keeps increasing across a clear.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::config::ServerStats;

/// Maximum number of access-log entries kept per server. Older entries are
/// evicted (and counted in `dropped`) once the ring is full.
pub const ACCESS_LOG_CAPACITY: usize = 1000;

/// Maximum number of distinct paths / clients tracked for the "top" lists.
/// When full, the least-hit key is evicted to make room for a new one, so the
/// aggregation stays bounded under a scan of unique paths.
pub const MAX_TRACKED_KEYS: usize = 200;

/// How many entries the "top paths" / "top clients" lists return.
pub const TOP_N: usize = 5;

/// Maximum number of concurrently tracked in-flight transfers. Beyond this a
/// transfer is still served, just not listed in `current_transfers`.
pub const MAX_TRACKED_TRANSFERS: usize = 256;

/// Maximum length (in characters) of any string field stored in an entry.
pub const MAX_FIELD_CHARS: usize = 256;

/// One recorded request / command / transfer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccessLogEntry {
    /// Monotonic sequence number (starts at 1, survives [`ServerActivity::clear`]).
    pub seq: u64,
    /// RFC 3339 timestamp at which the request completed.
    pub timestamp: String,
    /// Client IP address, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    /// Authenticated / attempted username (FTP login, HTTP Basic). Never a
    /// password.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// HTTP method, FTP command (`LOGIN`, `RETR`, `STOR`, …) or TFTP `RRQ`/`WRQ`.
    pub method: String,
    /// Requested path, when the request names one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Result: the HTTP status code, or `ok` / `denied` / `error` / `aborted` /
    /// `timeout` / `busy` for FTP and TFTP.
    pub status: String,
    /// Whether the request succeeded (drives the error counter).
    pub success: bool,
    /// Payload bytes transferred (sent or received).
    pub bytes: u64,
    /// Wall-clock duration of the request, when measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Short human-readable detail for a failure (no secrets).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Input to [`ServerActivity::record`]: an [`AccessLogEntry`] before it is
/// stamped with a `seq` and timestamp.
#[derive(Debug, Clone, Default)]
pub struct AccessRecord {
    client: Option<String>,
    user: Option<String>,
    method: String,
    path: Option<String>,
    status: String,
    success: bool,
    bytes: u64,
    duration: Option<Duration>,
    detail: Option<String>,
}

impl AccessRecord {
    /// Start a record for `method` finishing with `status` / `success`.
    pub fn new(method: impl Into<String>, status: impl Into<String>, success: bool) -> Self {
        Self {
            method: method.into(),
            status: status.into(),
            success,
            ..Self::default()
        }
    }

    /// Override the result (e.g. a transfer that turned out to be aborted).
    pub fn outcome(mut self, status: impl Into<String>, success: bool) -> Self {
        self.status = status.into();
        self.success = success;
        self
    }

    /// Attach the client's IP address.
    pub fn client(mut self, ip: IpAddr) -> Self {
        self.client = Some(ip.to_string());
        self
    }

    /// Attach the username (never the password).
    pub fn user(mut self, user: impl Into<String>) -> Self {
        self.user = Some(user.into());
        self
    }

    /// Attach the requested path.
    pub fn path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    /// Attach the number of payload bytes transferred.
    pub fn bytes(mut self, bytes: u64) -> Self {
        self.bytes = bytes;
        self
    }

    /// Attach the elapsed time since `started`.
    pub fn elapsed_since(mut self, started: Instant) -> Self {
        self.duration = Some(started.elapsed());
        self
    }

    /// Attach a short failure detail.
    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// A `key → hits` pair in a "top" list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopEntry {
    pub key: String,
    pub count: u64,
}

/// A transfer currently in flight.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    pub id: u64,
    /// Method / command that started the transfer (`GET`, `RETR`, `WRQ`, …).
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Bytes moved so far.
    pub bytes: u64,
    /// RFC 3339 start time.
    pub started_at: String,
}

/// Detailed per-server statistics (PROD-036).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetailedStats {
    /// Live connection/byte counters of the current run (zero when stopped).
    pub active_connections: u64,
    pub total_connections: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    /// Requests recorded since the log was last cleared.
    pub total_requests: u64,
    /// Failed requests recorded since the log was last cleared.
    pub errors: u64,
    /// Most-requested paths since the log was last cleared.
    pub top_paths: Vec<TopEntry>,
    /// Most active clients since the log was last cleared.
    pub top_clients: Vec<TopEntry>,
    /// Transfers in flight right now.
    pub current_transfers: Vec<TransferInfo>,
}

/// Incremental activity read returned to the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    /// Entries with `seq` greater than the requested cursor, oldest first.
    pub entries: Vec<AccessLogEntry>,
    /// Highest `seq` assigned so far (the cursor for the next read).
    pub latest_seq: u64,
    /// Bumped on every clear; a reader holding a different epoch must discard
    /// its buffered entries.
    pub epoch: u64,
    /// Entries evicted from the ring since the last clear.
    pub dropped: u64,
    /// Ring capacity ([`ACCESS_LOG_CAPACITY`]).
    pub capacity: usize,
    pub stats: DetailedStats,
}

/// Hit counter over a bounded key set.
#[derive(Debug, Default)]
struct BoundedCounter {
    counts: HashMap<String, u64>,
}

impl BoundedCounter {
    fn hit(&mut self, key: &str) {
        if let Some(count) = self.counts.get_mut(key) {
            *count += 1;
            return;
        }
        if self.counts.len() >= MAX_TRACKED_KEYS {
            // Evict the least-hit key (O(MAX_TRACKED_KEYS), only on a new key
            // arriving at a full table).
            if let Some(victim) = self
                .counts
                .iter()
                .min_by_key(|(_, c)| **c)
                .map(|(k, _)| k.clone())
            {
                self.counts.remove(&victim);
            }
        }
        self.counts.insert(key.to_string(), 1);
    }

    fn top(&self, n: usize) -> Vec<TopEntry> {
        let mut all: Vec<TopEntry> = self
            .counts
            .iter()
            .map(|(key, count)| TopEntry {
                key: key.clone(),
                count: *count,
            })
            .collect();
        all.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
        all.truncate(n);
        all
    }
}

/// A tracked in-flight transfer (bytes updated lock-free through its guard).
#[derive(Debug)]
struct LiveTransfer {
    method: String,
    client: Option<String>,
    path: Option<String>,
    bytes: Arc<AtomicU64>,
    started_at: String,
}

#[derive(Debug, Default)]
struct ActivityInner {
    log: VecDeque<AccessLogEntry>,
    latest_seq: u64,
    epoch: u64,
    dropped: u64,
    total_requests: u64,
    errors: u64,
    paths: BoundedCounter,
    clients: BoundedCounter,
    transfers: HashMap<u64, LiveTransfer>,
    next_transfer_id: u64,
}

/// Bounded access log + detailed statistics for one embedded server.
///
/// Owned by the server's service across restarts (so the log survives a
/// stop/start) and shared with the running server via `Arc`.
#[derive(Debug, Default)]
pub struct ServerActivity {
    inner: Mutex<ActivityInner>,
}

/// Truncate `s` to at most [`MAX_FIELD_CHARS`] characters.
fn clamp(s: String) -> String {
    if s.chars().count() <= MAX_FIELD_CHARS {
        s
    } else {
        let mut out: String = s.chars().take(MAX_FIELD_CHARS - 1).collect();
        out.push('…');
        out
    }
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl ServerActivity {
    /// A fresh, empty activity record wrapped in an `Arc`.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Lock the inner state, recovering from a poisoned lock (the data is plain
    /// counters and a log — always valid to keep using).
    fn lock(&self) -> MutexGuard<'_, ActivityInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Record one completed request. O(1); never blocks on I/O.
    pub fn record(&self, record: AccessRecord) {
        let AccessRecord {
            client,
            user,
            method,
            path,
            status,
            success,
            bytes,
            duration,
            detail,
        } = record;
        let client = client.map(clamp);
        let path = path.map(clamp);
        let timestamp = now_rfc3339();

        let mut inner = self.lock();
        inner.latest_seq += 1;
        inner.total_requests += 1;
        if !success {
            inner.errors += 1;
        }
        if let Some(p) = &path {
            inner.paths.hit(p);
        }
        if let Some(c) = &client {
            inner.clients.hit(c);
        }
        let entry = AccessLogEntry {
            seq: inner.latest_seq,
            timestamp,
            client,
            user: user.map(clamp),
            method: clamp(method),
            path,
            status: clamp(status),
            success,
            bytes,
            duration_ms: duration.map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX)),
            detail: detail.map(clamp),
        };
        if inner.log.len() >= ACCESS_LOG_CAPACITY {
            inner.log.pop_front();
            inner.dropped += 1;
        }
        inner.log.push_back(entry);
    }

    /// Register an in-flight transfer; it is listed in `current_transfers`
    /// until the returned guard is dropped.
    pub fn begin_transfer(
        self: &Arc<Self>,
        method: &str,
        client: Option<IpAddr>,
        path: Option<&str>,
    ) -> TransferGuard {
        let bytes = Arc::new(AtomicU64::new(0));
        let mut inner = self.lock();
        let id = if inner.transfers.len() < MAX_TRACKED_TRANSFERS {
            inner.next_transfer_id += 1;
            let id = inner.next_transfer_id;
            inner.transfers.insert(
                id,
                LiveTransfer {
                    method: method.to_string(),
                    client: client.map(|c| c.to_string()),
                    path: path.map(|p| clamp(p.to_string())),
                    bytes: Arc::clone(&bytes),
                    started_at: now_rfc3339(),
                },
            );
            Some(id)
        } else {
            None
        };
        TransferGuard {
            activity: Arc::clone(self),
            id,
            bytes,
        }
    }

    /// Empty the log and reset the request/error/top counters. In-flight
    /// transfers are kept; `seq` keeps increasing and `epoch` is bumped.
    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.log.clear();
        inner.dropped = 0;
        inner.total_requests = 0;
        inner.errors = 0;
        inner.paths = BoundedCounter::default();
        inner.clients = BoundedCounter::default();
        inner.epoch += 1;
    }

    /// Read entries newer than `since` (all entries when `None`) plus the
    /// detailed stats, combining in the live counters of the current run.
    pub fn snapshot(&self, since: Option<u64>, live: &ServerStats) -> ActivitySnapshot {
        let inner = self.lock();
        let since = since.unwrap_or(0);
        // A cursor ahead of `latest_seq` belongs to another activity instance
        // (e.g. a deleted and re-created server): hand back everything.
        let since = if since > inner.latest_seq { 0 } else { since };
        let entries: Vec<AccessLogEntry> = inner
            .log
            .iter()
            .filter(|e| e.seq > since)
            .cloned()
            .collect();
        let mut current_transfers: Vec<TransferInfo> = inner
            .transfers
            .iter()
            .map(|(id, t)| TransferInfo {
                id: *id,
                method: t.method.clone(),
                client: t.client.clone(),
                path: t.path.clone(),
                bytes: t.bytes.load(Ordering::Relaxed),
                started_at: t.started_at.clone(),
            })
            .collect();
        current_transfers.sort_by_key(|t| t.id);
        ActivitySnapshot {
            entries,
            latest_seq: inner.latest_seq,
            epoch: inner.epoch,
            dropped: inner.dropped,
            capacity: ACCESS_LOG_CAPACITY,
            stats: DetailedStats {
                active_connections: live.active_connections,
                total_connections: live.total_connections,
                bytes_sent: live.bytes_sent,
                bytes_received: live.bytes_received,
                total_requests: inner.total_requests,
                errors: inner.errors,
                top_paths: inner.paths.top(TOP_N),
                top_clients: inner.clients.top(TOP_N),
                current_transfers,
            },
        }
    }
}

/// RAII handle for an in-flight transfer. Dropping it removes the transfer
/// from `current_transfers`, so no exit path (error, abort, panic) can leak it.
#[derive(Debug)]
pub struct TransferGuard {
    activity: Arc<ServerActivity>,
    /// `None` when the tracking table was full (the transfer is not listed).
    id: Option<u64>,
    bytes: Arc<AtomicU64>,
}

impl TransferGuard {
    /// Add `n` bytes to this transfer's progress.
    pub fn add_bytes(&self, n: u64) {
        self.bytes.fetch_add(n, Ordering::Relaxed);
    }

    /// Bytes moved so far.
    pub fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            self.activity.lock().transfers.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("valid ip")
    }

    fn live() -> ServerStats {
        ServerStats::default()
    }

    #[test]
    fn record_assigns_increasing_seq_and_fields() {
        let activity = ServerActivity::new();
        activity.record(
            AccessRecord::new("GET", "200", true)
                .client(ip("10.0.0.5"))
                .path("/fw.bin")
                .bytes(42),
        );
        activity.record(AccessRecord::new("GET", "404", false).path("/nope"));

        let snap = activity.snapshot(None, &live());
        assert_eq!(snap.entries.len(), 2);
        assert_eq!(snap.entries[0].seq, 1);
        assert_eq!(snap.entries[1].seq, 2);
        assert_eq!(snap.latest_seq, 2);
        assert_eq!(snap.entries[0].client.as_deref(), Some("10.0.0.5"));
        assert_eq!(snap.entries[0].path.as_deref(), Some("/fw.bin"));
        assert_eq!(snap.entries[0].bytes, 42);
        assert!(snap.entries[0].success);
        assert!(!snap.entries[1].success);
    }

    #[test]
    fn snapshot_since_cursor_is_incremental() {
        let activity = ServerActivity::new();
        for _ in 0..3 {
            activity.record(AccessRecord::new("RRQ", "ok", true));
        }
        let first = activity.snapshot(None, &live());
        assert_eq!(first.entries.len(), 3);

        activity.record(AccessRecord::new("WRQ", "ok", true));
        let next = activity.snapshot(Some(first.latest_seq), &live());
        assert_eq!(next.entries.len(), 1);
        assert_eq!(next.entries[0].method, "WRQ");

        // Nothing new → empty delta.
        let empty = activity.snapshot(Some(next.latest_seq), &live());
        assert!(empty.entries.is_empty());
    }

    #[test]
    fn cursor_ahead_of_log_returns_everything() {
        let activity = ServerActivity::new();
        activity.record(AccessRecord::new("GET", "200", true));
        let snap = activity.snapshot(Some(999), &live());
        assert_eq!(snap.entries.len(), 1);
    }

    #[test]
    fn ring_buffer_is_capped_and_counts_dropped() {
        let activity = ServerActivity::new();
        let extra = 25;
        for i in 0..(ACCESS_LOG_CAPACITY + extra) {
            activity.record(AccessRecord::new("GET", "200", true).path(format!("/f{i}")));
        }
        let snap = activity.snapshot(None, &live());
        assert_eq!(snap.entries.len(), ACCESS_LOG_CAPACITY);
        assert_eq!(snap.dropped, extra as u64);
        assert_eq!(snap.capacity, ACCESS_LOG_CAPACITY);
        // Drop-oldest: the first surviving entry is the (extra+1)-th recorded.
        assert_eq!(snap.entries[0].seq, extra as u64 + 1);
        assert_eq!(
            snap.entries.last().map(|e| e.seq),
            Some((ACCESS_LOG_CAPACITY + extra) as u64)
        );
        // Totals count every request, not just the retained ones.
        assert_eq!(
            snap.stats.total_requests,
            (ACCESS_LOG_CAPACITY + extra) as u64
        );
    }

    #[test]
    fn stats_math_counts_errors_and_top_lists() {
        let activity = ServerActivity::new();
        for _ in 0..3 {
            activity.record(
                AccessRecord::new("GET", "200", true)
                    .client(ip("10.0.0.1"))
                    .path("/a"),
            );
        }
        activity.record(
            AccessRecord::new("GET", "404", false)
                .client(ip("10.0.0.2"))
                .path("/b"),
        );
        activity.record(
            AccessRecord::new("GET", "500", false)
                .client(ip("10.0.0.2"))
                .path("/a"),
        );

        let live = ServerStats {
            active_connections: 1,
            total_connections: 9,
            bytes_sent: 100,
            bytes_received: 7,
        };
        let stats = activity.snapshot(None, &live).stats;
        assert_eq!(stats.total_requests, 5);
        assert_eq!(stats.errors, 2);
        assert_eq!(stats.active_connections, 1);
        assert_eq!(stats.total_connections, 9);
        assert_eq!(stats.bytes_sent, 100);
        assert_eq!(stats.bytes_received, 7);
        assert_eq!(
            stats.top_paths,
            vec![
                TopEntry {
                    key: "/a".into(),
                    count: 4
                },
                TopEntry {
                    key: "/b".into(),
                    count: 1
                }
            ]
        );
        assert_eq!(stats.top_clients[0].key, "10.0.0.1");
        assert_eq!(stats.top_clients[0].count, 3);
        assert_eq!(stats.top_clients[1].count, 2);
    }

    #[test]
    fn top_lists_are_bounded() {
        let activity = ServerActivity::new();
        for i in 0..(MAX_TRACKED_KEYS * 3) {
            activity.record(AccessRecord::new("GET", "200", true).path(format!("/u{i}")));
        }
        let inner = activity.lock();
        assert!(inner.paths.counts.len() <= MAX_TRACKED_KEYS);
        drop(inner);
        let snap = activity.snapshot(None, &live());
        assert!(snap.stats.top_paths.len() <= TOP_N);
    }

    #[test]
    fn clear_empties_log_resets_counters_and_bumps_epoch() {
        let activity = ServerActivity::new();
        activity.record(AccessRecord::new("GET", "500", false).path("/x"));
        let before = activity.snapshot(None, &live());
        activity.clear();
        let after = activity.snapshot(None, &live());
        assert!(after.entries.is_empty());
        assert_eq!(after.stats.total_requests, 0);
        assert_eq!(after.stats.errors, 0);
        assert!(after.stats.top_paths.is_empty());
        assert_eq!(after.dropped, 0);
        assert_eq!(after.epoch, before.epoch + 1);
        // seq stays monotonic across a clear.
        activity.record(AccessRecord::new("GET", "200", true));
        let next = activity.snapshot(Some(after.latest_seq), &live());
        assert_eq!(next.entries[0].seq, before.latest_seq + 1);
    }

    #[test]
    fn transfer_guard_tracks_progress_and_releases_on_drop() {
        let activity = ServerActivity::new();
        let guard = activity.begin_transfer("RETR", Some(ip("10.0.0.9")), Some("/big.iso"));
        guard.add_bytes(512);
        guard.add_bytes(512);
        let snap = activity.snapshot(None, &live());
        assert_eq!(snap.stats.current_transfers.len(), 1);
        let t = &snap.stats.current_transfers[0];
        assert_eq!(t.method, "RETR");
        assert_eq!(t.bytes, 1024);
        assert_eq!(t.client.as_deref(), Some("10.0.0.9"));
        assert_eq!(guard.bytes(), 1024);

        drop(guard);
        let snap = activity.snapshot(None, &live());
        assert!(snap.stats.current_transfers.is_empty());
    }

    #[test]
    fn long_fields_are_truncated() {
        let activity = ServerActivity::new();
        let long = "a".repeat(MAX_FIELD_CHARS * 4);
        activity.record(AccessRecord::new("GET", "200", true).path(long));
        let snap = activity.snapshot(None, &live());
        let path = snap.entries[0].path.as_deref().unwrap_or_default();
        assert_eq!(path.chars().count(), MAX_FIELD_CHARS);
    }

    #[test]
    fn entry_serializes_camel_case_without_empty_optionals() {
        let activity = ServerActivity::new();
        activity.record(AccessRecord::new("RRQ", "ok", true));
        let snap = activity.snapshot(None, &live());
        let json = serde_json::to_value(&snap).expect("serialize");
        assert!(json.get("latestSeq").is_some());
        let entry = &json["entries"][0];
        assert!(entry.get("durationMs").is_none());
        assert!(entry.get("client").is_none());
        assert_eq!(entry["method"], "RRQ");
    }
}
