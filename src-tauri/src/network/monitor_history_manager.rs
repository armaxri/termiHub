//! Bounded, persisted check history for the HTTP monitors (#3462).
//!
//! Every check a monitor produces — desktop-hosted (the event bridge) or
//! agent-hosted (the `service.status` poller, #2592) — is recorded here on the
//! backend, so a monitor's chart and table survive a stop/resume and an app
//! restart whether or not the panel was open. The bounds are enforced here:
//!
//! * [`MAX_CHECKS_PER_MONITOR`] — the newest checks kept per monitor; older
//!   ones are evicted as new ones arrive.
//! * [`MAX_CHECK_AGE_DAYS`] — checks older than this are pruned on load,
//!   persist and list; a monitor whose checks all expired is dropped.
//! * [`MAX_MONITORS`] — the number of monitors with a stored history; beyond
//!   it the monitor checked least recently is evicted.
//! * [`MAX_ERROR_CHARS`] — the longest stored failure reason.
//!
//! A stored check is ~70 bytes of compact JSON, so the worst case on disk is
//! about 50 monitors × 1,000 checks × 70 B ≈ 3.5 MiB; typical use (a few
//! monitors) is a few hundred KiB.
//!
//! Monitors check as often as once a second, so the file is not rewritten on
//! every check: a record persists at most once per [`PERSIST_INTERVAL`] and
//! otherwise marks the store dirty. [`HttpMonitorHistoryManager::flush`] writes
//! pending checks — the monitor manager calls it on stop and on app shutdown.
//!
//! Recording honours the `networkToolHistoryEnabled` setting (#3456): while it
//! is off nothing is recorded (existing checks are kept until cleared).

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};
use tracing::warn;

use super::http_monitor::HttpCheckResult;
use super::monitor_history::{HttpMonitorCheck, HttpMonitorHistoryStore, HttpMonitorSeries};
use super::monitor_history_storage::HttpMonitorHistoryStorage;
use crate::connection::manager::ConnectionManager;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// The newest checks retained per monitor.
pub const MAX_CHECKS_PER_MONITOR: usize = 1_000;
/// Checks older than this many days are pruned.
pub const MAX_CHECK_AGE_DAYS: u64 = 7;
/// The most monitors with a stored history.
pub const MAX_MONITORS: usize = 50;
/// The longest stored failure reason, in characters.
pub const MAX_ERROR_CHARS: usize = 500;
/// The longest monitor id accepted (ids are UUIDs; anything longer is bogus).
pub const MAX_MONITOR_ID_LEN: usize = 128;
/// The minimum time between two disk writes caused by recording.
pub const PERSIST_INTERVAL: Duration = Duration::from_secs(10);

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// In-memory state behind the manager's lock.
struct Inner {
    store: HttpMonitorHistoryStore,
    /// Checks recorded since the last successful write.
    dirty: bool,
    /// When the store was last written; `None` before the first write.
    last_persist: Option<Instant>,
}

/// Central HTTP monitor check-history manager (#3462). Registered as Tauri
/// managed state; the recording hooks reach it through [`record_check`].
pub struct HttpMonitorHistoryManager {
    inner: Mutex<Inner>,
    storage: HttpMonitorHistoryStorage,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl HttpMonitorHistoryManager {
    /// Initialize from disk, with recovery on corruption. Expired checks are
    /// dropped in memory; the file catches up on the next write.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage = HttpMonitorHistoryStorage::new(app_handle)
            .context("Failed to initialize HTTP monitor history storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load HTTP monitor history")?;
        Ok(Self::from_parts(storage, result.data, result.warnings))
    }

    fn from_parts(
        storage: HttpMonitorHistoryStorage,
        mut store: HttpMonitorHistoryStore,
        warnings: Vec<RecoveryWarning>,
    ) -> Self {
        prune_expired(&mut store, now_ms());
        Self {
            inner: Mutex::new(Inner {
                store,
                dirty: false,
                last_persist: None,
            }),
            storage,
            recovery_warnings: Mutex::new(warnings),
        }
    }

    /// Take ownership of any recovery warnings (only the first call returns them).
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| std::mem::take(&mut *w))
            .unwrap_or_default()
    }

    /// A monitor's recorded checks, **oldest first** (chart order). With
    /// `limit`, only the newest `limit` checks are returned.
    pub fn list(
        &self,
        monitor_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<HttpCheckResult>, TerminalError> {
        let mut inner = self.lock()?;
        prune_expired(&mut inner.store, now_ms());
        let Some(series) = inner.store.monitors.iter().find(|s| s.id == monitor_id) else {
            return Ok(Vec::new());
        };
        let skip = limit
            .map(|l| series.checks.len().saturating_sub(l))
            .unwrap_or(0);
        Ok(series
            .checks
            .iter()
            .skip(skip)
            .map(|c| c.to_result(monitor_id))
            .collect())
    }

    /// Record one check. Persists at most once per [`PERSIST_INTERVAL`]; a
    /// check recorded inside the interval is written by the next persisting
    /// record or by [`flush`](Self::flush).
    pub fn record(&self, result: &HttpCheckResult) -> Result<(), TerminalError> {
        self.record_at(result, now_ms(), Instant::now())
    }

    fn record_at(
        &self,
        result: &HttpCheckResult,
        now_ms: u64,
        now: Instant,
    ) -> Result<(), TerminalError> {
        let monitor_id = result.monitor_id.trim();
        if monitor_id.is_empty() || monitor_id.len() > MAX_MONITOR_ID_LEN {
            return Err(TerminalError::NetworkError(
                "HTTP monitor check has an invalid monitor id".into(),
            ));
        }
        let mut check = HttpMonitorCheck::from_result(result);
        if let Some(err) = check.error.as_mut() {
            truncate_chars(err, MAX_ERROR_CHARS);
        }

        let mut inner = self.lock()?;
        append_check(&mut inner.store, monitor_id, check);
        inner.dirty = true;
        let due = inner
            .last_persist
            .is_none_or(|t| now.saturating_duration_since(t) >= PERSIST_INTERVAL);
        if due {
            prune_expired(&mut inner.store, now_ms);
            self.persist(&mut inner, now)?;
        }
        Ok(())
    }

    /// Write any checks recorded since the last write. A no-op when clean.
    pub fn flush(&self) -> Result<(), TerminalError> {
        let mut inner = self.lock()?;
        if !inner.dirty {
            return Ok(());
        }
        prune_expired(&mut inner.store, now_ms());
        self.persist(&mut inner, Instant::now())
    }

    /// Clear the history — of one monitor, or of every monitor when `None`.
    /// Persists immediately.
    pub fn clear(&self, monitor_id: Option<&str>) -> Result<(), TerminalError> {
        let mut inner = self.lock()?;
        let before = inner.store.monitors.len();
        match monitor_id {
            Some(id) => inner.store.monitors.retain(|s| s.id != id),
            None => inner.store.monitors.clear(),
        }
        if inner.store.monitors.len() == before && !inner.dirty && monitor_id.is_some() {
            return Ok(());
        }
        self.persist(&mut inner, Instant::now())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, TerminalError> {
        self.inner
            .lock()
            .map_err(|e| TerminalError::NetworkError(e.to_string()))
    }

    fn persist(&self, inner: &mut Inner, now: Instant) -> Result<(), TerminalError> {
        // Stamp the attempt even on failure so a failing disk is retried once
        // per interval, not on every check.
        inner.last_persist = Some(now);
        self.storage
            .save(&inner.store)
            .map_err(|e| TerminalError::NetworkError(e.to_string()))?;
        inner.dirty = false;
        Ok(())
    }
}

// ── Recording hooks ──────────────────────────────────────────────────────────

/// Whether monitor checks should be recorded: the shared
/// `networkToolHistoryEnabled` setting (#3456), on when unavailable.
fn history_enabled(app: &AppHandle) -> bool {
    app.try_state::<ConnectionManager>()
        .map(|m| m.get_settings().network_tool_history_enabled)
        .unwrap_or(true)
}

/// Record a check from a monitor (desktop- or agent-hosted). Best-effort: a
/// failure is logged, never surfaced — the live check still reaches the panel.
pub fn record_check(app: &AppHandle, result: &HttpCheckResult) {
    if !history_enabled(app) {
        return;
    }
    if let Some(mgr) = app.try_state::<HttpMonitorHistoryManager>() {
        if let Err(e) = mgr.record(result) {
            warn!(monitor_id = %result.monitor_id, "Failed to record HTTP monitor check: {e}");
        }
    }
}

/// Write pending checks to disk (on monitor stop and app shutdown).
pub fn flush_history(app: &AppHandle) {
    if let Some(mgr) = app.try_state::<HttpMonitorHistoryManager>() {
        if let Err(e) = mgr.flush() {
            warn!("Failed to flush HTTP monitor history: {e}");
        }
    }
}

/// Drop a removed monitor's history, so deleting a monitor leaves no orphan
/// series behind.
pub fn forget_monitor(app: &AppHandle, monitor_id: &str) {
    if let Some(mgr) = app.try_state::<HttpMonitorHistoryManager>() {
        if let Err(e) = mgr.clear(Some(monitor_id)) {
            warn!(monitor_id, "Failed to clear HTTP monitor history: {e}");
        }
    }
}

// ── Bounds ───────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Append `check` to `monitor_id`'s series, enforcing the per-monitor and
/// monitor-count caps. A check with the same timestamp as the series' newest
/// one is a duplicate sample and is dropped.
fn append_check(store: &mut HttpMonitorHistoryStore, monitor_id: &str, check: HttpMonitorCheck) {
    let idx = match store.monitors.iter().position(|s| s.id == monitor_id) {
        Some(idx) => idx,
        None => {
            store.monitors.push(HttpMonitorSeries {
                id: monitor_id.to_string(),
                checks: Vec::new(),
            });
            evict_excess_monitors(store, monitor_id);
            store
                .monitors
                .iter()
                .position(|s| s.id == monitor_id)
                .unwrap_or(store.monitors.len() - 1)
        }
    };
    let series = &mut store.monitors[idx];
    if series
        .checks
        .last()
        .is_some_and(|last| last.timestamp_ms == check.timestamp_ms)
    {
        return;
    }
    series.checks.push(check);
    let excess = series.checks.len().saturating_sub(MAX_CHECKS_PER_MONITOR);
    if excess > 0 {
        series.checks.drain(..excess);
    }
}

/// Keep at most [`MAX_MONITORS`] series, evicting the least recently checked
/// one(s) — never `keep_id`, the monitor that is being recorded right now.
fn evict_excess_monitors(store: &mut HttpMonitorHistoryStore, keep_id: &str) {
    while store.monitors.len() > MAX_MONITORS {
        let Some(victim) = store
            .monitors
            .iter()
            .enumerate()
            .filter(|(_, s)| s.id != keep_id)
            .min_by_key(|(_, s)| s.last_timestamp_ms())
            .map(|(i, _)| i)
        else {
            return;
        };
        store.monitors.remove(victim);
    }
}

/// Drop checks older than [`MAX_CHECK_AGE_DAYS`] before `now_ms`, and any
/// series left empty.
fn prune_expired(store: &mut HttpMonitorHistoryStore, now_ms: u64) {
    let cutoff = now_ms.saturating_sub(MAX_CHECK_AGE_DAYS * DAY_MS);
    for series in &mut store.monitors {
        series.checks.retain(|c| c.timestamp_ms >= cutoff);
    }
    store.monitors.retain(|s| !s.checks.is_empty());
}

/// Truncate `text` to at most `max` characters (on a char boundary).
fn truncate_chars(text: &mut String, max: usize) {
    if let Some((idx, _)) = text.char_indices().nth(max) {
        text.truncate(idx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn manager(dir: &TempDir) -> HttpMonitorHistoryManager {
        HttpMonitorHistoryManager::from_parts(
            HttpMonitorHistoryStorage::new_test(dir.path()),
            HttpMonitorHistoryStore::default(),
            Vec::new(),
        )
    }

    fn reload(dir: &TempDir) -> HttpMonitorHistoryManager {
        let storage = HttpMonitorHistoryStorage::new_test(dir.path());
        let loaded = storage.load_with_recovery().unwrap();
        HttpMonitorHistoryManager::from_parts(storage, loaded.data, loaded.warnings)
    }

    fn result(monitor_id: &str, ts: u64) -> HttpCheckResult {
        HttpCheckResult {
            monitor_id: monitor_id.to_string(),
            status_code: Some(200),
            latency_ms: Some(ts % 100),
            ok: true,
            error: None,
            timestamp_ms: ts,
        }
    }

    fn timestamps(checks: &[HttpCheckResult]) -> Vec<u64> {
        checks.iter().map(|c| c.timestamp_ms).collect()
    }

    #[test]
    fn records_and_lists_oldest_first_per_monitor() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        let now = now_ms();
        mgr.record(&result("a", now - 2)).unwrap();
        mgr.record(&result("b", now - 1)).unwrap();
        mgr.record(&result("a", now)).unwrap();

        let a = mgr.list("a", None).unwrap();
        assert_eq!(timestamps(&a), [now - 2, now]);
        assert!(a.iter().all(|c| c.monitor_id == "a"));
        assert_eq!(mgr.list("b", None).unwrap().len(), 1);
        assert!(mgr.list("unknown", None).unwrap().is_empty());
    }

    #[test]
    fn list_limit_returns_the_newest_checks() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        let now = now_ms();
        for i in 0..5 {
            mgr.record(&result("a", now - 10 + i)).unwrap();
        }
        let newest = mgr.list("a", Some(2)).unwrap();
        assert_eq!(timestamps(&newest), [now - 7, now - 6]);
        assert_eq!(mgr.list("a", Some(100)).unwrap().len(), 5);
    }

    #[test]
    fn per_monitor_cap_evicts_only_that_monitors_oldest() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        let now = now_ms();
        mgr.record(&result("other", now)).unwrap();
        let total = MAX_CHECKS_PER_MONITOR as u64 + 3;
        for i in 0..total {
            mgr.record(&result("busy", now - total + i)).unwrap();
        }
        let busy = mgr.list("busy", None).unwrap();
        assert_eq!(busy.len(), MAX_CHECKS_PER_MONITOR);
        assert_eq!(busy[0].timestamp_ms, now - total + 3, "oldest evicted");
        assert_eq!(busy.last().unwrap().timestamp_ms, now - 1);
        assert_eq!(mgr.list("other", None).unwrap().len(), 1);
    }

    #[test]
    fn monitor_cap_evicts_the_least_recently_checked_monitor() {
        let mut store = HttpMonitorHistoryStore::default();
        for i in 0..MAX_MONITORS as u64 {
            // Monitor 0 is the stalest; monitor 1 the freshest.
            let ts = if i == 1 { 10_000 } else { 100 + i };
            append_check(
                &mut store,
                &format!("m{i}"),
                HttpMonitorCheck::from_result(&result("x", ts)),
            );
        }
        append_check(
            &mut store,
            "new",
            HttpMonitorCheck::from_result(&result("x", 1)),
        );
        assert_eq!(store.monitors.len(), MAX_MONITORS);
        assert!(
            !store.monitors.iter().any(|s| s.id == "m0"),
            "stalest evicted"
        );
        assert!(store.monitors.iter().any(|s| s.id == "new"), "new one kept");
        assert!(store.monitors.iter().any(|s| s.id == "m1"));
    }

    #[test]
    fn expired_checks_and_empty_series_are_pruned() {
        let mut store = HttpMonitorHistoryStore::default();
        let now = now_ms();
        let old = now - (MAX_CHECK_AGE_DAYS + 1) * DAY_MS;
        let recent = now - (MAX_CHECK_AGE_DAYS - 1) * DAY_MS;
        append_check(
            &mut store,
            "a",
            HttpMonitorCheck::from_result(&result("a", old)),
        );
        append_check(
            &mut store,
            "a",
            HttpMonitorCheck::from_result(&result("a", recent)),
        );
        append_check(
            &mut store,
            "stale",
            HttpMonitorCheck::from_result(&result("stale", old)),
        );
        prune_expired(&mut store, now);
        assert_eq!(store.monitors.len(), 1);
        assert_eq!(store.monitors[0].id, "a");
        assert_eq!(store.monitors[0].checks.len(), 1);
        assert_eq!(store.monitors[0].checks[0].timestamp_ms, recent);
    }

    #[test]
    fn duplicate_sample_is_dropped() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        let now = now_ms();
        mgr.record(&result("a", now)).unwrap();
        mgr.record(&result("a", now)).unwrap();
        assert_eq!(mgr.list("a", None).unwrap().len(), 1);
    }

    #[test]
    fn long_error_is_shortened_and_bad_ids_are_rejected() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        let mut r = result("a", now_ms());
        r.ok = false;
        r.error = Some("é".repeat(MAX_ERROR_CHARS + 10));
        mgr.record(&r).unwrap();
        let stored = mgr.list("a", None).unwrap();
        assert_eq!(
            stored[0].error.as_ref().unwrap().chars().count(),
            MAX_ERROR_CHARS
        );

        assert!(mgr.record(&result("  ", now_ms())).is_err());
        assert!(mgr
            .record(&result(&"x".repeat(MAX_MONITOR_ID_LEN + 1), now_ms()))
            .is_err());
    }

    #[test]
    fn history_survives_a_reload() {
        let dir = TempDir::new().unwrap();
        let now = now_ms();
        {
            let mgr = manager(&dir);
            mgr.record(&result("a", now - 1)).unwrap();
            mgr.record(&result("a", now)).unwrap();
            mgr.flush().unwrap();
        }
        let mgr = reload(&dir);
        assert_eq!(timestamps(&mgr.list("a", None).unwrap()), [now - 1, now]);
    }

    #[test]
    fn records_inside_the_interval_are_written_on_flush() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        let now = now_ms();
        let t0 = Instant::now();
        // The first record persists immediately.
        mgr.record_at(&result("a", now - 1), now, t0).unwrap();
        assert_eq!(reload(&dir).list("a", None).unwrap().len(), 1);

        // A second one inside the interval is held in memory only…
        mgr.record_at(&result("a", now), now, t0 + Duration::from_secs(1))
            .unwrap();
        assert_eq!(reload(&dir).list("a", None).unwrap().len(), 1);

        // …until a flush writes it.
        mgr.flush().unwrap();
        assert_eq!(reload(&dir).list("a", None).unwrap().len(), 2);
    }

    #[test]
    fn a_record_after_the_interval_persists() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        let now = now_ms();
        let t0 = Instant::now();
        mgr.record_at(&result("a", now - 2), now, t0).unwrap();
        mgr.record_at(&result("a", now - 1), now, t0 + Duration::from_secs(1))
            .unwrap();
        mgr.record_at(&result("a", now), now, t0 + PERSIST_INTERVAL)
            .unwrap();
        assert_eq!(reload(&dir).list("a", None).unwrap().len(), 3);
    }

    #[test]
    fn flush_without_pending_checks_writes_nothing() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        mgr.flush().unwrap();
        assert!(!mgr.storage.file_path().exists());
    }

    #[test]
    fn clear_one_monitor_or_all() {
        let dir = TempDir::new().unwrap();
        let mgr = manager(&dir);
        let now = now_ms();
        mgr.record(&result("a", now)).unwrap();
        mgr.record(&result("b", now)).unwrap();

        mgr.clear(Some("a")).unwrap();
        assert!(mgr.list("a", None).unwrap().is_empty());
        assert_eq!(mgr.list("b", None).unwrap().len(), 1);
        // The clear is persisted, including the pending record of "b".
        assert_eq!(reload(&dir).list("b", None).unwrap().len(), 1);

        mgr.clear(None).unwrap();
        assert!(mgr.list("b", None).unwrap().is_empty());
        assert!(reload(&dir).list("b", None).unwrap().is_empty());
    }
}
