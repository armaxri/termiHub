//! System-monitor projection: the shared `system-monitors` region and the
//! `monitor.*` intents (#2224, part of #2139).
//!
//! Exposes the authoritative [`SystemMonitorStore`] as one versioned,
//! multi-subscriber projection region and turns the monitoring transitions the
//! frontend currently drives into [`Intent`]s — mirroring the SSH-tunnels pilot
//! ([`crate::tunnel::projection`]) and the session-lifecycle region
//! ([`crate::session_projection::projection`]).
//!
//! # The `system-monitors` region
//!
//! **Shared** (Open Design Decision #4: infrastructure domains are shared). A
//! monitor rides a backend session's `MonitoringProvider`; its stats/status are a
//! property of the session, not of a viewing client, so two clients see the same
//! monitor. The view model:
//!
//! ```json
//! { "monitors": { "<key>": MonitorEntry, ... }, "statsCache": { "<key>": SystemStats } }
//! ```
//!
//! # Intents
//!
//! | kind                   | payload                       | effect                                   |
//! | ---------------------- | ----------------------------- | ---------------------------------------- |
//! | `monitor.open`         | `{ key, host?, intervalMs? }` | begin an initial connect (→ connecting)  |
//! | `monitor.opened`       | `{ key }`                     | provider subscription live (→ live)      |
//! | `monitor.openFailed`   | `{ key, error? }`             | initial connect errored                  |
//! | `monitor.stats`        | `{ key, stats }`              | a stats sample arrived                   |
//! | `monitor.status`       | `{ key, status }`             | collector-loop status update             |
//! | `monitor.setPaused`    | `{ key, paused }`             | pause/resume collection (#1233)          |
//! | `monitor.setInterval`  | `{ key, intervalMs }`         | change refresh cadence (#1233)           |
//! | `monitor.clearError`   | `{ key }`                     | dismiss the error banner                 |
//! | `monitor.close`        | `{ key }`                     | disconnect and drop the entry            |
//! | `monitor.replace`      | `{ monitors, statsCache }`    | overwrite the whole map (render mirror)  |
//!
//! # Authoritative — drives the live UI (#2224)
//!
//! The status bar and Open Connections **render** monitor stats/status from this
//! region (`useProjectedMonitors`) and the granular `monitor.*` transitions
//! mutate the store, which is authoritative — the former `appStore` monitoring
//! reducers and the render/mutation-cut flags were removed (#2283).
//! `monitor.replace` remains the whole-map overwrite intent. Per the substrate
//! contract the result of an intent is never returned inline — it always arrives
//! as a projection diff on the `system-monitors` region.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use termihub_core::monitoring::{MonitorStatus, MonitorStatusReason, SystemStats};

use crate::commands::projection::ProjectionState;
use crate::projection::{
    compute_ops, optional_str, perf006_divergence, report_perf006_divergence, required_bool,
    required_str, DiffOp, HandlerRegistry, Intent, ProducedRegion, Projector,
};
use crate::system_monitor_projection::store::{MonitorEntry, RegionDelta, SystemMonitorStore};

/// The projection region id for the system-monitor domain (shared, per Open
/// Design Decision #4).
pub const SYSTEM_MONITORS_REGION: &str = "system-monitors";

/// Publish the `system-monitors` region from the store, fanning a diff out to
/// every subscriber and returning the advanced region for the intent ack (empty
/// when the view did not change).
///
/// # Incremental publish (PERF-006)
///
/// The region view is `{ "monitors": { <key>: MonitorEntry }, "statsCache": {
/// <key>: SystemStats } }`. The naive path re-serialized **all** entries and
/// diffed the whole tree on every fold — O(region) per fold, hence O(N²) over a
/// per-entry stream. Instead the store hands us only the entries it touched
/// ([`SystemMonitorStore::drain_delta`]); we diff just those against the held
/// view and splice them in place, bounding the cost to O(size of the change).
///
/// The emitted diff is **byte-identical** to the whole-region diff — see
/// [`apply_monitor_delta`] for why — so no subscriber can tell the two apart.
///
/// # Ordering under concurrent folds (#3788, the #3780 pattern)
///
/// Folds and publishes run on several threads at once: the intent dispatcher
/// (`monitor.*` routes), each session's monitoring collector task
/// ([`fold_monitor_transition`] from `monitoring_controller`), and the Tauri
/// monitoring commands (connect / disconnect / pause / interval).
/// The delta is therefore drained **inside** the region lock, in the same
/// critical section as the splice and the fan-out. Draining it before taking the
/// region lock let a racing fold-and-publish splice a *newer* value first, after
/// which this publish spliced its older, already-drained value over it — leaving
/// every subscriber stale with nothing left dirty to heal it. Under the region
/// lock, drains are applied in the order they are taken, so the region always
/// equals the store as of the latest drain; a fold landing after our drain stays
/// dirty and is carried by the next publish (its own folder always publishes
/// after it).
pub fn publish_monitors(projector: &Projector, store: &SystemMonitorStore) -> Vec<ProducedRegion> {
    let mut divergence = None;
    let published = projector.publish_delta(SYSTEM_MONITORS_REGION, |view| {
        // Debug builds also take the whole-region snapshot atomically with the
        // drain, as the ground truth for the PERF-006 cross-check.
        let (delta, truth) = if cfg!(debug_assertions) {
            let (delta, truth) = store.drain_delta_with_snapshot();
            (delta, Some(truth))
        } else {
            (store.drain_delta(), None)
        };
        #[cfg(test)]
        crate::projection::publish_hook::fire_after_drain();
        let (ops, diverged) =
            apply_monitor_delta(view, &delta, truth.as_ref(), || store.snapshot());
        divergence = diverged;
        ops
    });
    // Reported only after `publish_delta` returned: the (resynced) frame has
    // already been fanned out and the region lock released.
    if let Some(reason) = divergence {
        report_perf006_divergence(SYSTEM_MONITORS_REGION, &reason);
    }
    match published {
        Some(version) => vec![ProducedRegion {
            region: SYSTEM_MONITORS_REGION.to_string(),
            version,
        }],
        None => Vec::new(),
    }
}

/// Compute the RFC-6902 ops for a drained [`RegionDelta`] and splice its new
/// subtrees into the held region `view` in place — the incremental core of
/// [`publish_monitors`] (PERF-006). Returns the ops to fan out and, if the
/// cross-check failed, why.
///
/// ## Why the reduced diff is byte-identical to the whole-region diff
///
/// `json_patch::diff` has two properties this relies on: (1) object keys are
/// visited in **sorted** order (`serde_json` maps are `BTreeMap`s — no
/// `preserve_order`), and (2) each key's sub-diff depends **only** on that key's
/// old/new subtrees. So restricting both sides of the diff to just the touched
/// keys yields exactly the same ops — same paths, same values, same order — that
/// diffing the whole region would: the untouched keys produce no ops and, being
/// visited in the same sorted positions, never reorder the touched ones. The
/// top-level `{ monitors, statsCache }` wrapper is preserved on both reduced
/// sides so their own ordering (and absence of spurious top-level ops) matches
/// too.
///
/// ## The cross-check
///
/// When `truth` is given (debug builds: the whole-region snapshot taken under
/// the same store lock as the drain, so it is exactly the state this delta
/// brings the region to), the incremental result is cross-checked against it:
/// the ops must equal the whole-region diff and the spliced view must equal
/// `truth`. Any mismatch is a dirty-tracking / ordering bug. It is reported, and
/// the publish **resyncs** — the view is replaced by `truth` and the emitted ops
/// become the whole-region diff — so subscribers stay correct and no frame is
/// dropped. `snapshot` is only called for the unseeded-view fallback when no
/// `truth` is at hand.
fn apply_monitor_delta(
    view: &mut Value,
    delta: &RegionDelta,
    truth: Option<&Value>,
    snapshot: impl FnOnce() -> Value,
) -> (Vec<DiffOp>, Option<String>) {
    // Fallback: an unseeded / unexpected view shape (e.g. the region was never
    // seeded with the empty-store baseline) → the original whole-region path,
    // byte-for-byte. Production always seeds the region in `lib.rs::setup()`.
    if !view.get("monitors").is_some_and(Value::is_object)
        || !view.get("statsCache").is_some_and(Value::is_object)
    {
        let full = truth.cloned().unwrap_or_else(snapshot);
        let ops = compute_ops(view, &full);
        *view = full;
        return (ops, None);
    }

    let old_full = truth.map(|_| view.clone());

    let reduced_old = reduced_from_view(view, delta);
    let reduced_new = reduced_from_delta(delta);
    let ops = compute_ops(&reduced_old, &reduced_new);

    splice_subtrees(view, "monitors", &delta.monitors);
    splice_subtrees(view, "statsCache", &delta.stats_cache);

    if let (Some(truth), Some(old_full)) = (truth, old_full) {
        if let Some(reason) = perf006_divergence(&ops, &old_full, view, truth) {
            *view = truth.clone();
            return (compute_ops(&old_full, truth), Some(reason));
        }
    }

    (ops, None)
}

/// Build the reduced *old* view: the held `view`'s subtrees for exactly the
/// touched keys, wrapped in the `{ monitors, statsCache }` envelope.
fn reduced_from_view(view: &Value, delta: &RegionDelta) -> Value {
    json!({
        "monitors": pick_keys(view.get("monitors"), delta.monitors.iter().map(|(k, _)| k)),
        "statsCache": pick_keys(view.get("statsCache"), delta.stats_cache.iter().map(|(k, _)| k)),
    })
}

/// Build the reduced *new* view from the drained subtrees. A `None` value is an
/// absent (removed) entry and is simply omitted, so the diff emits a `remove`.
fn reduced_from_delta(delta: &RegionDelta) -> Value {
    json!({
        "monitors": subtree_map(&delta.monitors),
        "statsCache": subtree_map(&delta.stats_cache),
    })
}

/// Collect the named keys that are present in `src` into a fresh object.
fn pick_keys<'a>(src: Option<&Value>, keys: impl Iterator<Item = &'a String>) -> Value {
    let mut out = Map::new();
    if let Some(obj) = src.and_then(Value::as_object) {
        for key in keys {
            if let Some(value) = obj.get(key) {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

/// Collect the present (`Some`) entries of a drained subtree into a fresh object.
fn subtree_map(entries: &[(String, Option<Value>)]) -> Value {
    let mut out = Map::new();
    for (key, value) in entries {
        if let Some(value) = value {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

/// Splice the drained subtrees into `view[field]` in place: `Some` upserts the
/// entry, `None` removes it. A no-op if the field is somehow not an object.
fn splice_subtrees(view: &mut Value, field: &str, entries: &[(String, Option<Value>)]) {
    let Some(obj) = view.get_mut(field).and_then(Value::as_object_mut) else {
        return;
    };
    for (key, value) in entries {
        match value {
            Some(value) => {
                obj.insert(key.clone(), value.clone());
            }
            None => {
                obj.remove(key);
            }
        }
    }
}

/// Fold a monitoring transition into the managed [`SystemMonitorStore`]
/// **server-side** and fan the resulting `system-monitors` region diff out to
/// every subscriber (#2376, prerequisite for #2224).
///
/// This is the server-authority counterpart to [`register_monitor_intents`]: the
/// same store transitions the frontend currently mirrors via `monitor.*` intents
/// are applied here **at the source** — the instant the session collector loop
/// produces a stats sample / status change, or the session monitoring lifecycle
/// (connect / disconnect / pause / interval) advances — so the store is fed
/// server-side, with no client round-trip required for it to be correct. It is
/// **additive**: the existing Tauri event emission and the client `monitor.*`
/// mirror stay in place, and the render-cut seed (`seedMonitorsRegion` on the
/// frontend) keeps the region a faithful mirror of `appStore`, so this changed no
/// user-facing behavior when added. The now-redundant client re-dispatch was later
/// removed by the #2224 render/mutation inversion (#2283); the store is
/// authoritative and the live UI renders from the region.
///
/// Best-effort and non-fatal: if the store or the projection state is not managed
/// (e.g. a headless unit-test app that never ran `setup()`), the fold is skipped
/// rather than erroring — the client mirror still drives the region. The `apply`
/// closure runs to completion synchronously before the publish, so the store lock
/// is never held across an await.
pub fn fold_monitor_transition<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    apply: impl FnOnce(&SystemMonitorStore),
) {
    let Some(store) = app_handle.try_state::<Arc<SystemMonitorStore>>() else {
        return;
    };
    apply(store.inner().as_ref());
    if let Some(projection) = app_handle.try_state::<ProjectionState>() {
        publish_monitors(&projection.projector, store.inner().as_ref());
    }
}

/// Register the `monitor.*` intents on a handler registry.
///
/// Each route resolves the managed [`SystemMonitorStore`] lazily (so it rejects
/// gracefully rather than panicking if the store is somehow absent), applies the
/// transition, and publishes the shared region. All transitions are pure/fast map
/// edits, so they run inline on the dispatcher's single writer.
pub fn register_monitor_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("monitor.open", move |intent, projector| {
        let store = store_of(&handle)?;
        let key = required_str(intent, "key")?;
        store.open(
            &key,
            optional_str(intent, "host"),
            optional_u64(intent, "intervalMs"),
        );
        Ok(publish_monitors(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("monitor.opened", move |intent, projector| {
        let store = store_of(&handle)?;
        let key = required_str(intent, "key")?;
        store.opened(&key);
        Ok(publish_monitors(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("monitor.openFailed", move |intent, projector| {
        let store = store_of(&handle)?;
        let key = required_str(intent, "key")?;
        store.open_failed(&key, optional_str(intent, "error"));
        Ok(publish_monitors(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("monitor.stats", move |intent, projector| {
        let store = store_of(&handle)?;
        let key = required_str(intent, "key")?;
        store.stats(&key, required_stats(intent)?);
        Ok(publish_monitors(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("monitor.status", move |intent, projector| {
        let store = store_of(&handle)?;
        let key = required_str(intent, "key")?;
        store.set_status(&key, required_status(intent)?, optional_reason(intent)?);
        Ok(publish_monitors(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("monitor.setPaused", move |intent, projector| {
        let store = store_of(&handle)?;
        let key = required_str(intent, "key")?;
        store.set_paused(&key, required_bool(intent, "paused")?);
        Ok(publish_monitors(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("monitor.setInterval", move |intent, projector| {
        let store = store_of(&handle)?;
        let key = required_str(intent, "key")?;
        store.set_interval(&key, required_u64(intent, "intervalMs")?);
        Ok(publish_monitors(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("monitor.clearError", move |intent, projector| {
        let store = store_of(&handle)?;
        let key = required_str(intent, "key")?;
        store.clear_error(&key);
        Ok(publish_monitors(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("monitor.close", move |intent, projector| {
        let store = store_of(&handle)?;
        let key = required_str(intent, "key")?;
        store.close(&key);
        Ok(publish_monitors(projector, &store))
    });

    let handle = app_handle;
    registry.route("monitor.replace", move |intent, projector| {
        let store = store_of(&handle)?;
        let (monitors, stats_cache) = required_replace(intent)?;
        store.replace(monitors, stats_cache);
        Ok(publish_monitors(projector, &store))
    });
}

/// Resolve the managed system-monitor store, or a rejectable error if absent.
fn store_of(app_handle: &AppHandle) -> Result<Arc<SystemMonitorStore>, (String, String)> {
    app_handle
        .try_state::<Arc<SystemMonitorStore>>()
        .map(|state| (*state).clone())
        .ok_or_else(|| {
            (
                "unavailable".to_string(),
                "system-monitor store is not initialized".to_string(),
            )
        })
}

/// Extract a required u64 field from an intent payload.
fn required_u64(intent: &Intent, key: &str) -> Result<u64, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

/// Extract an optional u64 field; absent → `None`.
fn optional_u64(intent: &Intent, key: &str) -> Option<u64> {
    intent.payload.get(key).and_then(Value::as_u64)
}

/// Parse the required `stats` object as a [`SystemStats`].
fn required_stats(intent: &Intent) -> Result<SystemStats, (String, String)> {
    let value = intent
        .payload
        .get("stats")
        .ok_or_else(|| ("bad_payload".to_string(), "missing 'stats'".to_string()))?;
    serde_json::from_value(value.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid stats: {e}")))
}

/// Parse a `monitor.replace` payload into the whole-map snapshot the render-cut
/// mirror carries: `{ monitors: { <key>: MonitorEntry }, statsCache: { <key>:
/// SystemStats } }`. Either field absent is treated as an empty map, so a mirror
/// that clears all monitors is expressible; a present-but-malformed field is a
/// `bad_payload` rejection that advances nothing.
#[allow(clippy::type_complexity)]
fn required_replace(
    intent: &Intent,
) -> Result<(HashMap<String, MonitorEntry>, HashMap<String, SystemStats>), (String, String)> {
    let monitors = match intent.payload.get("monitors") {
        None | Some(Value::Null) => HashMap::new(),
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|e| ("bad_payload".to_string(), format!("invalid monitors: {e}")))?,
    };
    let stats_cache = match intent.payload.get("statsCache") {
        None | Some(Value::Null) => HashMap::new(),
        Some(value) => serde_json::from_value(value.clone()).map_err(|e| {
            (
                "bad_payload".to_string(),
                format!("invalid statsCache: {e}"),
            )
        })?,
    };
    Ok((monitors, stats_cache))
}

/// Parse the required `status` field as a [`MonitorStatus`].
fn required_status(intent: &Intent) -> Result<MonitorStatus, (String, String)> {
    let value = intent
        .payload
        .get("status")
        .ok_or_else(|| ("bad_payload".to_string(), "missing 'status'".to_string()))?;
    serde_json::from_value(value.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid status: {e}")))
}

/// Parse the optional `reason` field as a [`MonitorStatusReason`] (#3301).
///
/// Absent or `null` → `None`; a present-but-unknown value is a `bad_payload`
/// rejection, like a malformed `status`.
fn optional_reason(intent: &Intent) -> Result<Option<MonitorStatusReason>, (String, String)> {
    match intent.payload.get("reason") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|e| ("bad_payload".to_string(), format!("invalid reason: {e}"))),
    }
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "projection_race_tests.rs"]
mod race_tests;
