//! SSH-tunnels projection: the Phase-2 pilot domain (#2150, part of #2139).
//!
//! This is the first real domain migrated onto the stateless-UI projection
//! substrate (#2149, [`crate::projection`]). The authoritative tunnel state and
//! lifecycle already live in Rust ([`TunnelManager`]); this module exposes that
//! authority to the UI as a versioned, multi-subscriber projection region and
//! turns the UI's tunnel mutations into [`Intent`]s — a strangler migration that
//! leaves the manager and the existing typed commands/events untouched.
//!
//! # The `tunnels` region
//!
//! A single **shared** region (per Open Design Decision #4: infrastructure
//! domains are shared, so two clients see the same tunnels and a change from one
//! projects to both). Its render-ready view model mirrors the frontend tunnel
//! slice one-to-one:
//!
//! ```json
//! {
//!   "tunnels": [ TunnelConfig, ... ],        // the saved configs
//!   "states":  { "<tunnelId>": TunnelState } // live status + error + stats
//! }
//! ```
//!
//! [`build_tunnel_view`] is the pure snapshot function; [`publish_tunnels`]
//! diffs and fans out a new snapshot after any authoritative change. Status
//! transitions publish automatically because [`crate::tunnel::tunnel_manager`]'s
//! status-emit choke point calls [`publish_tunnels`]; config changes publish
//! from their own sites. The 1 Hz live-stats tick instead publishes a
//! stats-only delta via [`publish_tunnel_stats`] (#4574), patching just
//! `states.<id>.stats` rather than rebuilding the whole view.
//!
//! # Intents
//!
//! | kind               | payload            | effect                                   |
//! | ------------------ | ------------------ | ---------------------------------------- |
//! | `tunnel.create`    | a `TunnelConfig`   | upsert (create or edit) a saved config   |
//! | `tunnel.remove`    | `{ "id": "…" }`    | delete a saved config (stops it first)   |
//! | `tunnel.start`     | `{ "id": "…" }`    | start a tunnel (async; result as diffs)  |
//! | `tunnel.stop`      | `{ "id": "…" }`    | stop an active tunnel                     |
//! | `tunnel.reconnect` | `{ "id": "…" }`    | force stop-then-start (async)            |
//! | `tunnel.startForConnection` | `{ "connectionId": "…" }` | start the connection's `startWithConnection` tunnels (async) |
//!
//! Per the substrate contract the result of an intent is never returned inline —
//! it always arrives as a projection diff on the `tunnels` region. `start` and
//! `reconnect` therefore run their blocking SSH handshake off the dispatcher's
//! single-writer thread ([`tauri::async_runtime::spawn_blocking`]) and ack
//! immediately; the `connecting` → `connected` / `error` transitions stream in
//! as diffs from the manager's own status-emit path.

use std::sync::Arc;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::commands::projection::ProjectionState;
use crate::projection::{
    compute_ops, report_perf006_divergence, DiffOp, HandlerRegistry, Intent, ProducedRegion,
    Projector,
};
use crate::tunnel::config::{TunnelConfig, TunnelState, TunnelStats, TunnelStatus};
use crate::tunnel::tunnel_manager::TunnelManager;

/// The projection region id for the SSH-tunnels domain (shared, per Open Design
/// Decision #4).
pub const TUNNELS_REGION: &str = "tunnels";

/// Build the render-ready `tunnels` view model from the authoritative config
/// list and live per-tunnel states.
///
/// Pure (no locking, no IO) so it is unit-testable directly, and so the
/// projector can safely diff two consecutive snapshots. `states` is keyed by
/// tunnel id to mirror the frontend slice's `tunnelStates` map.
pub fn tunnel_view_from(tunnels: Vec<TunnelConfig>, states: Vec<TunnelState>) -> Value {
    let mut states_map = Map::with_capacity(states.len());
    for state in states {
        if let Ok(value) = serde_json::to_value(&state) {
            states_map.insert(state.tunnel_id.clone(), value);
        }
    }
    json!({ "tunnels": tunnels, "states": Value::Object(states_map) })
}

/// The current `tunnels` view model for a manager (its configs + live statuses).
pub fn build_tunnel_view(manager: &TunnelManager) -> Value {
    let tunnels = manager.get_tunnels().unwrap_or_default();
    let states = manager.get_statuses().unwrap_or_default();
    tunnel_view_from(tunnels, states)
}

/// Publish the `tunnels` region from managed state, fanning a diff out to every
/// subscriber.
///
/// A no-op when either the [`ProjectionState`] or the [`TunnelManager`] is not
/// managed yet (early startup / tunnel-storage init failure). Deadlock-safe:
/// [`build_tunnel_view`] re-locks the manager's mutexes, and every caller (the
/// status-emit choke point, the stats emitter, the intent handlers) invokes this
/// outside any held manager lock.
///
/// The view is built **under the region lock** ([`Projector::publish_with`],
/// #3788): those callers run on different threads, and a view built before the
/// lock could be published over a newer one a racing caller had already landed,
/// leaving the region stale. Lock order is region lock → manager mutexes; the
/// manager never touches the projector while holding one of its mutexes.
pub fn publish_tunnels<R: tauri::Runtime>(app_handle: &AppHandle<R>) {
    let (Some(projection), Some(manager)) = (
        app_handle.try_state::<ProjectionState>(),
        app_handle.try_state::<Arc<TunnelManager>>(),
    ) else {
        return;
    };
    projection
        .projector
        .publish_with(TUNNELS_REGION, || build_tunnel_view(&manager));
}

/// Publish only the live per-tunnel stats onto the `tunnels` region, as an
/// incremental delta (#4574, the optional half of PERF2-007 / #4344).
///
/// The 1 Hz stats tick (the desktop stats emitter and the agent `tunnel.status`
/// poller) changes nothing but `states.<id>.stats`, so instead of rebuilding,
/// re-serializing and structurally diffing the whole view ([`publish_tunnels`])
/// it goes through [`Projector::publish_delta`] like the other hot regions
/// (#2878): the closure patches just the changed stats subtrees in place and
/// emits exactly their ops. Status and config changes keep using the full
/// [`publish_tunnels`].
///
/// The samples are read **under the region lock**, inside the delta closure —
/// the same build-under-lock guarantee [`publish_tunnels`] has (#3788) — so a
/// delta can never land older stats over a newer full publish. Lock order stays
/// region lock → manager mutexes. A no-op when either state is not managed.
pub fn publish_tunnel_stats<R: tauri::Runtime>(app_handle: &AppHandle<R>) {
    let (Some(projection), Some(manager)) = (
        app_handle.try_state::<ProjectionState>(),
        app_handle.try_state::<Arc<TunnelManager>>(),
    ) else {
        return;
    };
    publish_stats_delta(&projection.projector, || manager.live_stats());
}

/// Publish a stats-only delta of the `tunnels` region to `projector`, with the
/// samples produced by `samples` **under the region lock** (#4574).
///
/// Debug builds cross-check the incremental ops against the whole-region diff
/// of the old and new views (PERF-006); on a mismatch the frame carries the
/// whole-region ops instead (so subscribers stay exact) and the divergence is
/// reported after the fan-out. Returns the new version, or `None` when no
/// projected stats changed (no frame, no version bump).
pub(crate) fn publish_stats_delta(
    projector: &Projector,
    samples: impl FnOnce() -> Vec<(String, TunnelStats)>,
) -> Option<u64> {
    let mut divergence = None;
    let published = projector.publish_delta(TUNNELS_REGION, |view| {
        let samples = samples();
        if cfg!(debug_assertions) {
            let old = view.clone();
            let ops = apply_tunnel_stats_delta(view, &samples);
            let expected = compute_ops(&old, view);
            if ops != expected {
                divergence = Some(format!(
                    "incremental ops {ops:?} != whole-region ops {expected:?}"
                ));
                return expected;
            }
            ops
        } else {
            apply_tunnel_stats_delta(view, &samples)
        }
    });
    if let Some(reason) = divergence {
        report_perf006_divergence(TUNNELS_REGION, &reason);
    }
    published
}

/// Splice live stats samples into a `tunnels` view **in place** and return
/// exactly the ops that splice implies (#4574). Pure, so it is unit-testable.
///
/// Only a tunnel whose projected state is `connected` is patched — the only
/// status [`TunnelManager::get_statuses`] reports live stats for — so the
/// patched view is always one a full [`build_tunnel_view`] could have produced.
/// An id with no projected state (a config not yet published) or a non-connected
/// one is skipped: the status transition's own full publish carries it. An
/// unchanged sample emits nothing.
///
/// The ops are the diff of the reduced subtrees `{states: {<id>: {stats}}}` for
/// the changed ids. `json_patch::diff` visits object keys in sorted order and
/// each key's sub-diff depends only on that key's subtrees, so this equals the
/// whole-view diff when nothing but those stats changed (see `delta_splice`).
pub fn apply_tunnel_stats_delta(
    view: &mut Value,
    samples: &[(String, TunnelStats)],
) -> Vec<DiffOp> {
    let connected = serde_json::to_value(TunnelStatus::Connected).unwrap_or(Value::Null);
    let Some(states) = view.get("states").and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut old = Map::new();
    let mut new = Map::new();
    for (id, stats) in samples {
        let Some(entry) = states.get(id) else {
            continue;
        };
        if entry.get("status") != Some(&connected) {
            continue;
        }
        let Ok(new_stats) = serde_json::to_value(stats) else {
            continue;
        };
        let old_stats = entry.get("stats").cloned().unwrap_or(Value::Null);
        if old_stats == new_stats {
            continue;
        }
        old.insert(id.clone(), json!({ "stats": old_stats }));
        new.insert(id.clone(), json!({ "stats": new_stats }));
    }
    if new.is_empty() {
        return Vec::new();
    }

    let ops = compute_ops(
        &json!({ "states": Value::Object(old) }),
        &json!({ "states": Value::Object(new.clone()) }),
    );
    if let Some(states) = view.get_mut("states").and_then(Value::as_object_mut) {
        for (id, mut patch) in new {
            if let Some(entry) = states.get_mut(&id).and_then(Value::as_object_mut) {
                entry.insert("stats".to_string(), patch["stats"].take());
            }
        }
    }
    ops
}

/// Register the SSH-tunnels domain intents on a handler registry.
///
/// Each route resolves the managed [`TunnelManager`] lazily (so a tunnel-storage
/// init failure rejects intents gracefully rather than panicking) and publishes
/// the region after the mutation. Fast mutations (`create` / `remove` / `stop`)
/// run inline; `start` / `reconnect` spawn their blocking work so the
/// single-writer dispatcher is never held across an SSH handshake.
pub fn register_tunnel_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("tunnel.create", move |intent, projector| {
        let config: TunnelConfig = parse_config(intent)?;
        let manager = manager_of(&handle)?;
        manager
            .save_tunnel(config)
            .map_err(|e| ("save_failed".to_string(), e.to_string()))?;
        Ok(publish_region(&manager, projector))
    });

    let handle = app_handle.clone();
    registry.route("tunnel.remove", move |intent, projector| {
        let id = tunnel_id(intent)?;
        let manager = manager_of(&handle)?;
        manager
            .delete_tunnel(&id)
            .map_err(|e| ("delete_failed".to_string(), e.to_string()))?;
        // `delete_tunnel` stops the tunnel first (which projects the stop), then
        // drops the config — publish once more to reflect the shorter list.
        Ok(publish_region(&manager, projector))
    });

    let handle = app_handle.clone();
    registry.route("tunnel.start", move |intent, _projector| {
        let id = tunnel_id(intent)?;
        let manager = manager_of(&handle)?;
        // Fire-and-forget: the blocking SSH handshake must not stall the
        // single-writer dispatcher. `connecting`/`connected`/`error` all reach
        // the UI as diffs via the manager's status-emit path.
        tauri::async_runtime::spawn_blocking(move || {
            let _ = manager.start_tunnel(&id);
        });
        Ok(Vec::new())
    });

    let handle = app_handle.clone();
    registry.route("tunnel.stop", move |intent, _projector| {
        let id = tunnel_id(intent)?;
        let manager = manager_of(&handle)?;
        manager
            .stop_tunnel(&id)
            .map_err(|e| ("stop_failed".to_string(), e.to_string()))?;
        // `stop_tunnel` emits `Disconnected`, which projects the change.
        Ok(Vec::new())
    });

    let handle = app_handle.clone();
    registry.route("tunnel.reconnect", move |intent, _projector| {
        let id = tunnel_id(intent)?;
        let manager = manager_of(&handle)?;
        tauri::async_runtime::spawn_blocking(move || {
            let _ = manager.stop_tunnel(&id);
            let _ = manager.start_tunnel(&id);
        });
        Ok(Vec::new())
    });

    // PROD-023: a terminal session for a saved SSH connection just connected —
    // bring up the tunnels bound to it with `startWithConnection`. The selection
    // and the skip-if-already-active guard live in the manager, so a repeated
    // dispatch (a second tab, a reconnect) is harmless. Fire-and-forget like
    // `tunnel.start`: each start's status reaches the UI as diffs.
    let handle = app_handle;
    registry.route("tunnel.startForConnection", move |intent, _projector| {
        let connection_id = connection_id(intent)?;
        let manager = manager_of(&handle)?;
        tauri::async_runtime::spawn_blocking(move || {
            let _ = manager.start_connection_tunnels(&connection_id);
        });
        Ok(Vec::new())
    });
}

/// Resolve the managed tunnel manager, or a rejectable error if it is absent.
fn manager_of(app_handle: &AppHandle) -> Result<Arc<TunnelManager>, (String, String)> {
    app_handle
        .try_state::<Arc<TunnelManager>>()
        .map(|state| (*state).clone())
        .ok_or_else(|| {
            (
                "unavailable".to_string(),
                "tunnel manager is not initialized".to_string(),
            )
        })
}

/// Extract the required `id` string from an intent payload.
fn tunnel_id(intent: &Intent) -> Result<String, (String, String)> {
    intent
        .payload
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ("bad_payload".to_string(), "missing tunnel id".to_string()))
}

/// Extract the required, non-empty `connectionId` string from an intent payload.
fn connection_id(intent: &Intent) -> Result<String, (String, String)> {
    intent
        .payload
        .get("connectionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            (
                "bad_payload".to_string(),
                "missing connection id".to_string(),
            )
        })
}

/// Parse a full [`TunnelConfig`] from an intent payload.
fn parse_config(intent: &Intent) -> Result<TunnelConfig, (String, String)> {
    serde_json::from_value(intent.payload.clone()).map_err(|e| {
        (
            "bad_payload".to_string(),
            format!("invalid tunnel config: {e}"),
        )
    })
}

/// Publish the region from a manager to the given projector, returning the
/// advanced region for the intent ack (empty when the view did not change).
fn publish_region(manager: &TunnelManager, projector: &Projector) -> Vec<ProducedRegion> {
    match projector.publish_with(TUNNELS_REGION, || build_tunnel_view(manager)) {
        Some(version) => vec![ProducedRegion {
            region: TUNNELS_REGION.to_string(),
            version,
        }],
        None => Vec::new(),
    }
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "projection_stats_delta_tests.rs"]
mod stats_delta_tests;
