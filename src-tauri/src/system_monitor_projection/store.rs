//! The authoritative, shared system-monitor state behind the
//! `system-monitors` projection region (#2224, Phase 5 of #2139).
//!
//! Models the per-host/session monitoring slice the frontend currently drives in
//! `appStore` (`monitors: Record<MonitorKey, MonitoringEntry>` and the
//! `monitoringStatsCache`): the connect / live / stale / paused lifecycle of each
//! monitor plus its last-known [`SystemStats`]. Built on the monitoring types
//! already shared with the agent crate (`termihub_core::monitoring`), so the view
//! model matches the frontend `MonitoringEntry` one-to-one.
//!
//! # Shared region — Open Design Decision #4
//!
//! A monitor subscribes a backend session's `MonitoringProvider` and the provider
//! pushes stats/status; that lifecycle is a property of the session, not of a
//! viewing client, so two clients observing the same monitored session see the
//! same stats (like SSH tunnels, [`crate::tunnel::projection`], and
//! session-lifecycle, [`crate::session_projection`]). The region is therefore a
//! single **shared** `system-monitors` region. The per-client choice of which
//! monitor the status bar renders (the active tab) is layout/presentation and
//! stays a frontend concern under partial projection.
//!
//! # Authoritative — drives the live UI
//!
//! The stateless-UI inversion is complete (#2283): this store is authoritative.
//! The status bar and Open Connections render from the `system-monitors` region
//! and frontend code dispatches the `monitor.*` transitions; the former `appStore`
//! monitoring reducers were removed.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use termihub_core::monitoring::{MonitorStatus, SystemStats};

/// Default monitoring refresh interval in milliseconds — mirrors the frontend
/// `DEFAULT_MONITORING_INTERVAL_MS` (#1233).
pub const DEFAULT_MONITORING_INTERVAL_MS: u64 = 2000;

/// The authoritative record for one monitored host/session — the render-ready
/// projection of the frontend `MonitoringEntry`. Keyed in the store by the owning
/// terminal session id (the stable `MonitorKey`).
///
/// Every field serialises (no `skip_serializing_if`) so the view model matches
/// the frontend `MonitoringEntry` shape exactly, keeping the eventual render cut
/// a pure parity swap.
// `SystemStats` (a field below) does not derive `PartialEq`, so this record
// can't either; tests compare via the serialised view model instead.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonitorEntry {
    /// Stable key identifying this monitor (the owning terminal session id).
    pub key: String,
    /// Human-readable host label shown in the UI.
    pub host: Option<String>,
    /// Backend session id used for the close RPC; equals `key` once the provider
    /// subscription is live, `None` until established (or after a failed open).
    pub monitor_session_id: Option<String>,
    /// Last-known stats for this host, or `None` before the first sample.
    pub stats: Option<SystemStats>,
    /// True while the initial connect (or a cache-primed reconnect) is in flight.
    pub loading: bool,
    /// Last error message for this host, or `None`.
    pub error: Option<String>,
    /// Observable collector-loop status (`live`/`stale`/…), or `None` when idle.
    pub status: Option<MonitorStatus>,
    /// Number of stats samples received on this connection (drives CPU priming).
    pub sample_count: u32,
    /// True while the user has paused collection (#1233); transport stays open.
    pub paused: bool,
    /// Per-entry refresh interval in milliseconds (#1233).
    pub interval_ms: u64,
}

impl MonitorEntry {
    /// A fresh, idle entry for a key (mirrors the frontend `emptyMonitor`).
    fn empty(key: &str, host: Option<String>) -> Self {
        Self {
            key: key.to_string(),
            host,
            monitor_session_id: None,
            stats: None,
            loading: false,
            error: None,
            status: None,
            sample_count: 0,
            paused: false,
            interval_ms: DEFAULT_MONITORING_INTERVAL_MS,
        }
    }
}

/// The private mutable core: the per-monitor map plus the last-known stats cache
/// (persisted across tab switches for instant display on reconnect). One mutex
/// guards it so intents never interleave — the substrate's single-writer contract
/// also holds within the store.
#[derive(Default)]
struct Inner {
    monitors: HashMap<String, MonitorEntry>,
    stats_cache: HashMap<String, SystemStats>,
    /// Keys of `monitors` touched since the last [`SystemMonitorStore::drain_delta`]
    /// (PERF-006). A superset of the actually-changed keys is always safe: an
    /// unchanged key contributes an empty sub-diff and never reorders the rest.
    dirty_monitors: HashSet<String>,
    /// Keys of `stats_cache` touched since the last drain (PERF-006).
    dirty_cache: HashSet<String>,
}

/// A serialized description of the region entries touched since the previous
/// [`SystemMonitorStore::drain_delta`] — the input to the region's incremental
/// publish (PERF-006). Built in O(touched entries), not O(whole region). A
/// `None` value marks an entry that is now **absent** (removed), so the
/// projection emits a `remove` for it.
#[derive(Debug, Default)]
pub struct RegionDelta {
    /// `(key, Some(serialized MonitorEntry) | None-if-removed)`.
    pub monitors: Vec<(String, Option<Value>)>,
    /// `(key, Some(serialized SystemStats) | None-if-removed)`.
    pub stats_cache: Vec<(String, Option<Value>)>,
}

/// The system-monitor authority. Owns one [`MonitorEntry`] per monitored
/// host/session, keyed by `MonitorKey`, plus the last-known stats cache. The
/// single shared `system-monitors` region projects this state.
#[derive(Default)]
pub struct SystemMonitorStore {
    inner: Mutex<Inner>,
}

impl SystemMonitorStore {
    /// A store with no monitors yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// The render-ready view model for the whole region:
    /// `{ "monitors": { "<key>": MonitorEntry, ... }, "statsCache": { … } }`.
    ///
    /// Pure with respect to monitor state (never mutates), so the projector can
    /// safely diff two consecutive snapshots.
    pub fn snapshot(&self) -> Value {
        let inner = self.lock();
        let mut monitors = Map::with_capacity(inner.monitors.len());
        for (key, entry) in &inner.monitors {
            if let Ok(value) = serde_json::to_value(entry) {
                monitors.insert(key.clone(), value);
            }
        }
        let mut cache = Map::with_capacity(inner.stats_cache.len());
        for (key, stats) in &inner.stats_cache {
            if let Ok(value) = serde_json::to_value(stats) {
                cache.insert(key.clone(), value);
            }
        }
        json!({ "monitors": Value::Object(monitors), "statsCache": Value::Object(cache) })
    }

    /// `monitor.open` — begin an initial connect. Upserts a fresh loading entry
    /// (status `connecting`, `monitorSessionId` still `None`) primed with any
    /// cached stats for the key, mirroring the frontend `connectMonitoring` start.
    pub fn open(&self, key: &str, host: Option<String>, interval_ms: Option<u64>) {
        let mut inner = self.lock();
        let cached = inner.stats_cache.get(key).cloned();
        let mut entry = MonitorEntry::empty(key, host);
        entry.loading = true;
        entry.status = Some(MonitorStatus::Connecting);
        entry.stats = cached;
        entry.interval_ms = interval_ms.unwrap_or(DEFAULT_MONITORING_INTERVAL_MS);
        inner.monitors.insert(key.to_string(), entry);
        inner.dirty_monitors.insert(key.to_string());
    }

    /// `monitor.opened` — the provider subscription is live. Settles the entry:
    /// `monitorSessionId = key`, `loading = false`, status `live`.
    pub fn opened(&self, key: &str) {
        let mut inner = self.lock();
        if let Some(entry) = inner.monitors.get_mut(key) {
            entry.monitor_session_id = Some(key.to_string());
            entry.loading = false;
            entry.status = Some(MonitorStatus::Live);
            entry.error = None;
        }
        inner.dirty_monitors.insert(key.to_string());
    }

    /// `monitor.openFailed` — the initial connect errored. Clears the loading
    /// state and records the error (mirrors the failed-open branch that detaches
    /// listeners and leaves `monitorSessionId` null).
    pub fn open_failed(&self, key: &str, error: Option<String>) {
        let mut inner = self.lock();
        if let Some(entry) = inner.monitors.get_mut(key) {
            entry.monitor_session_id = None;
            entry.loading = false;
            entry.status = None;
            entry.error = error;
        }
        inner.dirty_monitors.insert(key.to_string());
    }

    /// `monitor.stats` — a stats sample arrived. Updates the entry's stats,
    /// increments the sample count, and refreshes the last-known cache so a later
    /// reconnect shows the value instantly. A no-op for an unknown key.
    pub fn stats(&self, key: &str, stats: SystemStats) {
        let mut inner = self.lock();
        inner.stats_cache.insert(key.to_string(), stats.clone());
        inner.dirty_cache.insert(key.to_string());
        if let Some(entry) = inner.monitors.get_mut(key) {
            entry.stats = Some(stats);
            entry.sample_count = entry.sample_count.saturating_add(1);
        }
        inner.dirty_monitors.insert(key.to_string());
    }

    /// `monitor.status` — an observable collector-loop status update arrived.
    pub fn set_status(&self, key: &str, status: MonitorStatus) {
        let mut inner = self.lock();
        if let Some(entry) = inner.monitors.get_mut(key) {
            entry.status = Some(status);
        }
        inner.dirty_monitors.insert(key.to_string());
    }

    /// `monitor.setPaused` — pause or resume one monitor (#1233). The transport
    /// stays open; the badge flips to `paused` / `live`.
    pub fn set_paused(&self, key: &str, paused: bool) {
        let mut inner = self.lock();
        if let Some(entry) = inner.monitors.get_mut(key) {
            entry.paused = paused;
            entry.status = Some(if paused {
                MonitorStatus::Paused
            } else {
                MonitorStatus::Live
            });
        }
        inner.dirty_monitors.insert(key.to_string());
    }

    /// `monitor.setInterval` — change one monitor's refresh interval (#1233).
    pub fn set_interval(&self, key: &str, interval_ms: u64) {
        let mut inner = self.lock();
        if let Some(entry) = inner.monitors.get_mut(key) {
            entry.interval_ms = interval_ms;
        }
        inner.dirty_monitors.insert(key.to_string());
    }

    /// `monitor.clearError` — dismiss a monitor's error banner. A no-op when the
    /// key is unknown or already clear.
    pub fn clear_error(&self, key: &str) {
        let mut inner = self.lock();
        if let Some(entry) = inner.monitors.get_mut(key) {
            entry.error = None;
        }
        inner.dirty_monitors.insert(key.to_string());
    }

    /// `monitor.close` — disconnect one monitor and drop its entry. The stats
    /// cache is retained so a later reconnect can prime instantly (mirrors
    /// `disconnectMonitoring`, which keeps the cache). Idempotent.
    pub fn close(&self, key: &str) {
        let mut inner = self.lock();
        inner.monitors.remove(key);
        inner.dirty_monitors.insert(key.to_string());
    }

    /// `monitor.replace` — overwrite the whole monitor map and stats cache with a
    /// caller-supplied snapshot. Used by the frontend to keep the shared region a
    /// faithful copy of the monitoring slice — the analog of the layout bridge's
    /// `layout.replace` seed. This store is authoritative (the former `appStore`
    /// reducers were removed, #2283). Idempotent server-side: replacing with the
    /// same content yields no diff.
    pub fn replace(
        &self,
        monitors: HashMap<String, MonitorEntry>,
        stats_cache: HashMap<String, SystemStats>,
    ) {
        let mut inner = self.lock();
        // Mark every key that could differ dirty: the old set (removals /
        // changes) and the incoming set (adds / changes), for both maps
        // (PERF-006). A whole-map replace is the one intrinsically O(region)
        // fold; the reduced diff then equals the whole-region diff exactly.
        let old_monitors: Vec<String> = inner.monitors.keys().cloned().collect();
        inner.dirty_monitors.extend(old_monitors);
        inner.dirty_monitors.extend(monitors.keys().cloned());
        let old_cache: Vec<String> = inner.stats_cache.keys().cloned().collect();
        inner.dirty_cache.extend(old_cache);
        inner.dirty_cache.extend(stats_cache.keys().cloned());
        inner.monitors = monitors;
        inner.stats_cache = stats_cache;
    }

    /// Drain the dirty-key sets, serializing each touched entry's current value
    /// (or `None` if it was removed) — the input to the region's incremental
    /// publish (PERF-006). O(number of touched entries).
    ///
    /// Draining and serializing under the single store lock keeps the returned
    /// [`RegionDelta`] a consistent view of the touched entries at one instant.
    /// A serialization failure is treated as absence (matching [`Self::snapshot`],
    /// which likewise omits an entry it cannot serialize), so the region converges
    /// on the same result either way.
    pub fn drain_delta(&self) -> RegionDelta {
        let mut inner = self.lock();
        let monitor_keys: Vec<String> = inner.dirty_monitors.drain().collect();
        let cache_keys: Vec<String> = inner.dirty_cache.drain().collect();
        let monitors = monitor_keys
            .into_iter()
            .map(|key| {
                let value = inner
                    .monitors
                    .get(&key)
                    .and_then(|entry| serde_json::to_value(entry).ok());
                (key, value)
            })
            .collect();
        let stats_cache = cache_keys
            .into_iter()
            .map(|key| {
                let value = inner
                    .stats_cache
                    .get(&key)
                    .and_then(|stats| serde_json::to_value(stats).ok());
                (key, value)
            })
            .collect();
        RegionDelta {
            monitors,
            stats_cache,
        }
    }

    /// Read one monitor entry (test / diagnostics helper).
    #[cfg(test)]
    pub fn get(&self, key: &str) -> Option<MonitorEntry> {
        self.lock().monitors.get(key).cloned()
    }

    /// Read the cached last-known stats for a key (test / diagnostics helper).
    #[cfg(test)]
    pub fn cached_stats(&self, key: &str) -> Option<SystemStats> {
        self.lock().stats_cache.get(key).cloned()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Short critical sections only; a poisoned lock means another thread
        // panicked mid-mutation (a bug) — recover rather than cascade.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
