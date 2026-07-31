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

use serde_json::Value;
use tauri::{AppHandle, Manager};

use termihub_core::monitoring::{MonitorStatus, SystemStats};

use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};
use crate::system_monitor_projection::store::{MonitorEntry, SystemMonitorStore};

/// The projection region id for the system-monitor domain (shared, per Open
/// Design Decision #4).
pub const SYSTEM_MONITORS_REGION: &str = "system-monitors";

/// Publish the `system-monitors` region from the store, fanning a diff out to
/// every subscriber and returning the advanced region for the intent ack (empty
/// when the view did not change).
pub fn publish_monitors(projector: &Projector, store: &SystemMonitorStore) -> Vec<ProducedRegion> {
    match projector.publish(SYSTEM_MONITORS_REGION, store.snapshot()) {
        Some(version) => vec![ProducedRegion {
            region: SYSTEM_MONITORS_REGION.to_string(),
            version,
        }],
        None => Vec::new(),
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
