//! System-monitor projection: the shared `system-monitors` region and the
//! `monitor.*` intents (#2224, part of #2139).
//!
//! Exposes the authoritative [`SystemMonitorStore`] as one versioned,
//! multi-subscriber projection region and turns the monitoring transitions the
//! frontend currently drives into [`Intent`]s — mirroring the SSH-tunnels pilot
//! ([`crate::tunnel::projection`]) and the session-lifecycle shadow
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
//! # Render cut (#2224 step 2)
//!
//! The status bar and Open Connections now **render** monitor stats/status from
//! this region (`useProjectedMonitors`), but `appStore` remains **authoritative**
//! — the mutation cut is a later step. To keep the render cut parity-safe, the
//! frontend keeps the region a faithful copy of `appStore` via `monitor.replace`
//! (the whole-map mirror) and only renders from the region when it deep-equals
//! `appStore`, falling back to `appStore` otherwise. The granular `monitor.*`
//! transitions stay served for the eventual mutation cut. Per the substrate
//! contract the result of an intent is never returned inline — it always arrives
//! as a projection diff on the `system-monitors` region.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use termihub_core::monitoring::{MonitorStatus, SystemStats};

use crate::commands::projection::ProjectionState;
use crate::projection::{compute_ops, DiffOp, HandlerRegistry, Intent, ProducedRegion, Projector};
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
pub fn publish_monitors(projector: &Projector, store: &SystemMonitorStore) -> Vec<ProducedRegion> {
    let delta = store.drain_delta();
    let published = projector.publish_delta(SYSTEM_MONITORS_REGION, |view| {
        apply_monitor_delta(view, &delta, store)
    });
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
/// [`publish_monitors`] (PERF-006).
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
/// Under `debug_assertions` this is cross-checked against a fresh whole-region
/// diff, so any dirty-tracking miss or ordering drift fails loudly in tests
/// rather than silently corrupting a subscriber's cache.
fn apply_monitor_delta(
    view: &mut Value,
    delta: &RegionDelta,
    store: &SystemMonitorStore,
) -> Vec<DiffOp> {
    // Fallback: an unseeded / unexpected view shape (e.g. the region was never
    // seeded with the empty-store baseline) → the original whole-region path,
    // byte-for-byte. Production always seeds the region in `lib.rs::setup()`.
    if !view.get("monitors").is_some_and(Value::is_object)
        || !view.get("statsCache").is_some_and(Value::is_object)
    {
        let full = store.snapshot();
        let ops = compute_ops(view, &full);
        *view = full;
        return ops;
    }

    #[cfg(debug_assertions)]
    let old_full = view.clone();

    let reduced_old = reduced_from_view(view, delta);
    let reduced_new = reduced_from_delta(delta);
    let ops = compute_ops(&reduced_old, &reduced_new);

    splice_subtrees(view, "monitors", &delta.monitors);
    splice_subtrees(view, "statsCache", &delta.stats_cache);

    #[cfg(debug_assertions)]
    {
        // Ground truth: the whole-region diff and a fresh full snapshot. The
        // incremental ops must equal the former, and the spliced view the latter
        // — either mismatch is a dirty-tracking / ordering bug, not a perf tweak.
        let fresh = store.snapshot();
        debug_assert_eq!(
            ops,
            compute_ops(&old_full, &fresh),
            "PERF-006: incremental monitor delta diverged from the whole-region diff"
        );
        debug_assert_eq!(
            *view, fresh,
            "PERF-006: spliced monitor view diverged from the store snapshot"
        );
    }

    ops
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
/// frontend) keeps the region a faithful mirror of `appStore`, so this changes no
/// user-facing behavior. Removing the now-redundant client re-dispatch is the
/// later #2224 render/mutation inversion.
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
        store.set_status(&key, required_status(intent)?);
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

/// Extract a required string field from an intent payload.
fn required_str(intent: &Intent, key: &str) -> Result<String, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

/// Extract an optional string field; absent → `None`.
fn optional_str(intent: &Intent, key: &str) -> Option<String> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Extract a required bool field from an intent payload.
fn required_bool(intent: &Intent, key: &str) -> Result<bool, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
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

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
