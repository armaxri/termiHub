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
//! status-emit choke point calls [`publish_tunnels`]; config/stats changes
//! publish from their own sites.
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
use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};
use crate::tunnel::config::{TunnelConfig, TunnelState};
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
pub fn publish_tunnels(app_handle: &AppHandle) {
    let (Some(projection), Some(manager)) = (
        app_handle.try_state::<ProjectionState>(),
        app_handle.try_state::<Arc<TunnelManager>>(),
    ) else {
        return;
    };
    let view = build_tunnel_view(&manager);
    projection.projector.publish(TUNNELS_REGION, view);
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

    let handle = app_handle;
    registry.route("tunnel.reconnect", move |intent, _projector| {
        let id = tunnel_id(intent)?;
        let manager = manager_of(&handle)?;
        tauri::async_runtime::spawn_blocking(move || {
            let _ = manager.stop_tunnel(&id);
            let _ = manager.start_tunnel(&id);
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
    match projector.publish(TUNNELS_REGION, build_tunnel_view(manager)) {
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
