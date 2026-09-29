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

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use termihub_core::monitoring::{MonitorStatus, MonitorStatusReason, SystemStats};

/// Default monitoring refresh interval in milliseconds — mirrors the frontend
/// `DEFAULT_MONITORING_INTERVAL_MS` (#1233).
pub const DEFAULT_MONITORING_INTERVAL_MS: u64 = 2000;

/// Samples retained per monitor in the `history` ring of the region (#3204).
///
/// Equal to the client-side rolling window it replaces (`MONITOR_HISTORY_CAP` in
/// `src/store/useMonitorHistory.ts`): 90 samples is three minutes at the default
/// 2 s cadence. The memory cost is `samples x bytes/sample x live monitors` — see
/// "System-monitor history retention" in `docs/architecture.md` for the
/// calculation (roughly 0.2-0.5 MB per monitor, a few MB at a realistic twenty
/// monitors). Fixed rather than user-configurable: the cost is small and
/// bounded by the live monitors, and the UI draws exactly this many points.
pub const MONITOR_HISTORY_CAPACITY: usize = 90;

/// One retained sample in a monitor's history ring (#3204): the full
/// [`SystemStats`] the collector produced (including its `source` and
/// `unavailableMetrics`, #3202) plus its ordinal on the current connection.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct MonitorHistorySample {
    /// The monitor's `sampleCount` once this sample was folded in (1-based on
    /// the current connection). Lets a consumer tell the priming first sample —
    /// whose CPU and network rates have no prior delta — from the rest.
    pub sample_count: u32,
    /// The sample itself.
    #[cfg_attr(test, ts(type = "import(\"./SystemStats\").SystemStats"))]
    pub stats: SystemStats,
}

/// The authoritative record for one monitored host/session — the render-ready
/// projection of the frontend `MonitoringEntry`. Keyed in the store by the owning
/// terminal session id (the stable `MonitorKey`).
///
/// Every field serialises (no `skip_serializing_if`) so the view model matches
/// the frontend `MonitoringEntry` shape exactly, keeping the render cut
/// a pure parity swap.
// `SystemStats` (a field below) does not derive `PartialEq`, so this record
// can't either; tests compare via the serialised view model instead.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../src/types/generated/",
        rename = "MonitoringEntry"
    )
)]
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
    #[cfg_attr(test, ts(type = "import(\"./SystemStats\").SystemStats | null"))]
    pub stats: Option<SystemStats>,
    /// True while the initial connect (or a cache-primed reconnect) is in flight.
    pub loading: bool,
    /// Last error message for this host, or `None`.
    pub error: Option<String>,
    /// Observable collector-loop status (`live`/`stale`/…), or `None` when idle.
    #[cfg_attr(test, ts(type = "import(\"./MonitorStatus\").MonitorStatus | null"))]
    pub status: Option<MonitorStatus>,
    /// Why the loop left `Live` — the failure kind behind a `stale` /
    /// `reconnecting` / `offline` status (`transport` / `parse` / `silent`),
    /// or `None` while healthy (#3301). Lets the UI say "remote output
    /// unreadable" rather than always "connection lost". Defaulted on
    /// deserialize so a `monitor.replace` seed without it stays valid.
    #[serde(default)]
    #[cfg_attr(
        test,
        ts(
            optional,
            type = "import(\"./MonitorStatusReason\").MonitorStatusReason | null"
        )
    )]
    pub status_reason: Option<MonitorStatusReason>,
    /// Number of stats samples received on this connection (drives CPU priming).
    pub sample_count: u32,
    /// True while the user has paused collection (#1233); transport stays open.
    pub paused: bool,
    /// Per-entry refresh interval in milliseconds (#1233).
    #[cfg_attr(test, ts(type = "number"))]
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
            status_reason: None,
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
    /// The bounded per-monitor history ring (#3204), oldest first. Only live
    /// monitors (keys of `monitors`) carry one, so its memory is bounded by
    /// `live monitors x capacity`.
    history: HashMap<String, VecDeque<MonitorHistorySample>>,
    /// How each ring changed since the last drain (#3204). Unlike the two
    /// maps above, a ring is not re-serialized whole on every sample: an
    /// [`HistoryDirty::Append`] drains to just the new samples.
    dirty_history: HashMap<String, HistoryDirty>,
}

/// How one history ring changed since the last drain (#3204).
#[derive(Clone, Copy, Debug)]
enum HistoryDirty {
    /// The ring was created, replaced, cleared or removed: republish it whole.
    Reset,
    /// Only samples were pushed: `evicted` from the front of the ring as last
    /// drained, then `appended` at the back.
    Append { evicted: usize, appended: usize },
}

impl Inner {
    /// Replace (or with `None`, remove) one ring and mark it for a whole
    /// republish.
    fn reset_history(&mut self, key: &str, ring: Option<VecDeque<MonitorHistorySample>>) {
        match ring {
            Some(ring) => {
                self.history.insert(key.to_string(), ring);
            }
            None => {
                self.history.remove(key);
            }
        }
        self.dirty_history
            .insert(key.to_string(), HistoryDirty::Reset);
    }

    /// Push one sample onto a key's ring, evicting from the front past
    /// `capacity`, and record the append for the next drain.
    fn push_history(&mut self, key: &str, sample: MonitorHistorySample, capacity: usize) {
        if capacity == 0 {
            return;
        }
        if !self.history.contains_key(key) {
            // First sample on a ring that does not exist yet (e.g. a monitor
            // mirrored in by `replace`): publish the new ring whole.
            self.reset_history(key, Some(VecDeque::with_capacity(capacity)));
        }
        let Some(ring) = self.history.get_mut(key) else {
            return;
        };
        let mut evicted = 0;
        while ring.len() >= capacity {
            ring.pop_front();
            evicted += 1;
        }
        ring.push_back(sample);

        let next = match self.dirty_history.get(key).copied() {
            None => HistoryDirty::Append {
                evicted,
                appended: 1,
            },
            Some(HistoryDirty::Reset) => HistoryDirty::Reset,
            Some(HistoryDirty::Append {
                evicted: e,
                appended: a,
            }) => {
                // More pushes than the ring holds since the last drain means
                // some appended samples were evicted again before anyone saw
                // them; a whole republish is then both simpler and smaller.
                if a + 1 > capacity {
                    HistoryDirty::Reset
                } else {
                    HistoryDirty::Append {
                        evicted: e + evicted,
                        appended: a + 1,
                    }
                }
            }
        };
        self.dirty_history.insert(key.to_string(), next);
    }
}

/// How one history ring moved since the previous drain — the history part of a
/// [`RegionDelta`] (#3204). Appends are deliberately *not* a whole-ring value:
/// the region emits one `remove` per eviction and one `add` per new sample, so a
/// steady-state sample costs one sample on the wire, never the ring.
#[derive(Debug)]
pub enum HistoryDelta {
    /// Republish the whole ring: `Some(serialized ring)`, or `None` once the
    /// ring is gone (its monitor closed).
    Reset(Option<Value>),
    /// Remove `evicted` samples from the front of the ring as last published,
    /// then append `appended` (serialized [`MonitorHistorySample`]s) starting at
    /// index `start` (the ring's length after the evictions).
    Append {
        evicted: usize,
        start: usize,
        appended: Vec<Value>,
    },
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
    /// `(key, how its history ring moved)`, sorted by key (#3204).
    pub history: Vec<(String, HistoryDelta)>,
}

/// The system-monitor authority. Owns one [`MonitorEntry`] per monitored
/// host/session, keyed by `MonitorKey`, plus the last-known stats cache. The
/// single shared `system-monitors` region projects this state.
pub struct SystemMonitorStore {
    inner: Mutex<Inner>,
    /// Samples retained per monitor ring (#3204).
    history_capacity: usize,
}

impl Default for SystemMonitorStore {
    fn default() -> Self {
        Self::with_history_capacity(MONITOR_HISTORY_CAPACITY)
    }
}

impl SystemMonitorStore {
    /// A store with no monitors yet, retaining [`MONITOR_HISTORY_CAPACITY`]
    /// samples per monitor.
    pub fn new() -> Self {
        Self::default()
    }

    /// A store retaining `capacity` history samples per monitor (tests use a
    /// small ring to exercise eviction; `0` disables history).
    pub fn with_history_capacity(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            history_capacity: capacity,
        }
    }

    /// Samples retained per monitor ring (test / diagnostics helper).
    #[cfg(test)]
    pub fn history_capacity(&self) -> usize {
        self.history_capacity
    }

    /// The render-ready view model for the whole region:
    /// `{ "history": { "<key>": [MonitorHistorySample] }, "monitors": { "<key>":
    /// MonitorEntry, ... }, "statsCache": { … } }`.
    ///
    /// Pure with respect to monitor state (never mutates), so the projector can
    /// safely diff two consecutive snapshots.
    pub fn snapshot(&self) -> Value {
        snapshot_of(&self.lock())
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
        // A (re)connect is a fresh session — its `sampleCount` restarts at 0 —
        // so the history ring restarts too rather than graphing across the gap.
        inner.reset_history(key, Some(VecDeque::new()));
    }

    /// `monitor.opened` — the provider subscription is live. Settles the entry:
    /// `monitorSessionId = key`, `loading = false`, status `live`.
    pub fn opened(&self, key: &str) {
        let mut inner = self.lock();
        if let Some(entry) = inner.monitors.get_mut(key) {
            entry.monitor_session_id = Some(key.to_string());
            entry.loading = false;
            entry.status = Some(MonitorStatus::Live);
            entry.status_reason = None;
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
            entry.status_reason = None;
            entry.error = error;
        }
        inner.dirty_monitors.insert(key.to_string());
    }

    /// `monitor.stats` — a stats sample arrived. Updates the entry's stats,
    /// increments the sample count, refreshes the last-known cache so a later
    /// reconnect shows the value instantly, and appends the sample to the
    /// monitor's bounded history ring (#3204). For an unknown key only the cache
    /// is refreshed — history is retained for live monitors only.
    pub fn stats(&self, key: &str, stats: SystemStats) {
        let mut inner = self.lock();
        inner.stats_cache.insert(key.to_string(), stats.clone());
        inner.dirty_cache.insert(key.to_string());
        let mut retained = None;
        if let Some(entry) = inner.monitors.get_mut(key) {
            entry.sample_count = entry.sample_count.saturating_add(1);
            retained = Some(MonitorHistorySample {
                sample_count: entry.sample_count,
                stats: stats.clone(),
            });
            entry.stats = Some(stats);
        }
        inner.dirty_monitors.insert(key.to_string());
        if let Some(sample) = retained {
            inner.push_history(key, sample, self.history_capacity);
        }
    }

    /// `monitor.status` — an observable collector-loop status update arrived,
    /// with the failure kind behind it (`None` for a healthy status, #3301).
    pub fn set_status(
        &self,
        key: &str,
        status: MonitorStatus,
        reason: Option<MonitorStatusReason>,
    ) {
        let mut inner = self.lock();
        if let Some(entry) = inner.monitors.get_mut(key) {
            entry.status = Some(status);
            entry.status_reason = reason;
        }
        inner.dirty_monitors.insert(key.to_string());
    }

    /// `monitor.setPaused` — pause or resume one monitor (#1233). The transport
    /// stays open; the badge flips to `paused` / `live`.
    pub fn set_paused(&self, key: &str, paused: bool) {
        let mut inner = self.lock();
        if let Some(entry) = inner.monitors.get_mut(key) {
            entry.paused = paused;
            entry.status_reason = None;
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

    /// `monitor.close` — disconnect one monitor and drop its entry and history
    /// ring. The stats cache is retained so a later reconnect can prime
    /// instantly (mirrors `disconnectMonitoring`, which keeps the cache).
    /// Idempotent.
    pub fn close(&self, key: &str) {
        let mut inner = self.lock();
        inner.monitors.remove(key);
        inner.dirty_monitors.insert(key.to_string());
        if inner.history.contains_key(key) {
            inner.reset_history(key, None);
        }
    }

    /// `monitor.replace` — overwrite the whole monitor map, stats cache and
    /// history rings with a caller-supplied snapshot. A ring is kept only for a
    /// key present in `monitors` and only its newest samples up to the capacity,
    /// so a replace cannot exceed the history bound. Used by the frontend to keep the shared region a
    /// faithful copy of the monitoring slice — the analog of the layout bridge's
    /// `layout.replace` seed. This store is authoritative (the former `appStore`
    /// reducers were removed, #2283). Idempotent server-side: replacing with the
    /// same content yields no diff.
    pub fn replace(
        &self,
        monitors: HashMap<String, MonitorEntry>,
        stats_cache: HashMap<String, SystemStats>,
        history: HashMap<String, Vec<MonitorHistorySample>>,
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
        let old_rings: Vec<String> = inner.history.keys().cloned().collect();
        for key in old_rings {
            inner.reset_history(&key, None);
        }
        let capacity = self.history_capacity;
        for (key, samples) in history {
            if capacity == 0 || !monitors.contains_key(&key) {
                continue;
            }
            let skip = samples.len().saturating_sub(capacity);
            let ring: VecDeque<_> = samples.into_iter().skip(skip).collect();
            inner.reset_history(&key, Some(ring));
        }
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
        drain_delta_of(&mut self.lock())
    }

    /// [`Self::drain_delta`] plus a whole-region [`Self::snapshot`], both taken
    /// under **one** store lock so no fold can land between them (#3788, the
    /// #3780 pattern). The snapshot is therefore exactly the state the drained
    /// delta brings the region to — the ground truth for the debug PERF-006
    /// cross-check in [`crate::system_monitor_projection::projection`]. A fresh
    /// `snapshot()` taken after the drain would also contain any fold that raced
    /// in afterwards (still dirty, published next), failing the check spuriously.
    pub fn drain_delta_with_snapshot(&self) -> (RegionDelta, Value) {
        let mut inner = self.lock();
        let delta = drain_delta_of(&mut inner);
        (delta, snapshot_of(&inner))
    }

    /// Read one monitor entry (test / diagnostics helper).
    #[cfg(test)]
    pub fn get(&self, key: &str) -> Option<MonitorEntry> {
        self.lock().monitors.get(key).cloned()
    }

    /// Read one monitor's retained history ring, oldest first (empty when it
    /// has none) — test / diagnostics helper.
    #[cfg(test)]
    pub fn history(&self, key: &str) -> Vec<MonitorHistorySample> {
        self.lock()
            .history
            .get(key)
            .map(|ring| ring.iter().cloned().collect())
            .unwrap_or_default()
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

/// The whole-region view model of the locked store (see
/// [`SystemMonitorStore::snapshot`]).
fn snapshot_of(inner: &Inner) -> Value {
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
    let mut history = Map::with_capacity(inner.history.len());
    for (key, ring) in &inner.history {
        if let Ok(value) = serde_json::to_value(ring) {
            history.insert(key.clone(), value);
        }
    }
    json!({
        "history": Value::Object(history),
        "monitors": Value::Object(monitors),
        "statsCache": Value::Object(cache),
    })
}

/// Drain the locked store's dirty sets into a [`RegionDelta`] (see
/// [`SystemMonitorStore::drain_delta`]).
fn drain_delta_of(inner: &mut Inner) -> RegionDelta {
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
    let mut history_keys: Vec<(String, HistoryDirty)> = inner.dirty_history.drain().collect();
    history_keys.sort_by(|a, b| a.0.cmp(&b.0));
    let history = history_keys
        .into_iter()
        .map(|(key, dirty)| {
            let delta = history_delta_of(inner.history.get(&key), dirty);
            (key, delta)
        })
        .collect();
    RegionDelta {
        monitors,
        stats_cache,
        history,
    }
}

/// Serialize how one ring moved since the last drain: the whole ring for a
/// reset, or only the appended tail for an append (#3204). A serialization
/// failure degrades to a whole-ring reset, which is always correct.
fn history_delta_of(
    ring: Option<&VecDeque<MonitorHistorySample>>,
    dirty: HistoryDirty,
) -> HistoryDelta {
    let Some(ring) = ring else {
        return HistoryDelta::Reset(None);
    };
    let whole = || HistoryDelta::Reset(serde_json::to_value(ring).ok());
    match dirty {
        HistoryDirty::Reset => whole(),
        HistoryDirty::Append { evicted, appended } => {
            let Some(start) = ring.len().checked_sub(appended) else {
                return whole();
            };
            let values: Option<Vec<Value>> = ring
                .iter()
                .skip(start)
                .map(|sample| serde_json::to_value(sample).ok())
                .collect();
            match values {
                Some(appended) => HistoryDelta::Append {
                    evicted,
                    start,
                    appended,
                },
                None => whole(),
            }
        }
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
