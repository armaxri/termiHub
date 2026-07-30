//! Layout projection: the client-scoped `layout@<clientId>` region and the
//! `layout.*` intents (#2151, part of #2139).
//!
//! Exposes the authoritative [`LayoutStore`] to each attached client as its own
//! versioned, multi-subscriber projection region and turns the four structural
//! layout mutations into [`Intent`]s — mirroring the SSH-tunnels pilot
//! ([`crate::tunnel::projection`]), the reference registration pattern for the
//! substrate ([`crate::projection`]).
//!
//! # The `layout@<clientId>` region
//!
//! **Client-scoped** (per Open Design Decision #1/#6: multi-client is in scope,
//! and layout is per-window view arrangement — moving a tab on one client need
//! not move it on another). Each client gets its own region, seeded lazily and
//! mutated via `intent.client_id`. Its render-ready view model is the panel tree
//! plus the focused panel:
//!
//! ```json
//! { "root": <PanelNode>, "activePanelId": "panel-…" }
//! ```
//!
//! # Intents
//!
//! | kind                        | payload                                  | effect                                        |
//! | --------------------------- | ---------------------------------------- | --------------------------------------------- |
//! | `layout.split`              | `{ panelId, direction, position }`       | split a leaf, inserting a new empty leaf       |
//! | `layout.merge`              | `{ sourcePanelId, targetPanelId }`       | move all tabs into the target, drop the source |
//! | `layout.moveTab`            | `{ tabId, targetPanelId, edge }`         | move a tab (center = merge; edge = split)      |
//! | `layout.closeTabStructure`  | `{ tabId }`                              | remove a tab; drop its leaf if left empty      |
//!
//! # Shadow mode
//!
//! Registered and fully served, but **not** driving the live UI: no frontend
//! subscribes to `layout@<clientId>` or dispatches `layout.*` yet, so these
//! intents mutate only the shadow store and project to regions nobody renders.
//! The `appStore` panel-tree reducers and `SplitView` remain authoritative. Per
//! the substrate contract the result of an intent is never returned inline — it
//! always arrives as a projection diff on the client's `layout` region.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::layout::store::{LayoutError, LayoutStore};
use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};

/// The projection region id for a client's layout (`layout@<clientId>`).
pub fn layout_region(client_id: &str) -> String {
    format!("layout@{client_id}")
}

/// Publish a client's `layout` region from the store, fanning a diff out to
/// every subscriber and returning the advanced region for the intent ack (empty
/// when the view did not change).
pub fn publish_layout(
    projector: &Projector,
    store: &LayoutStore,
    client_id: &str,
) -> Vec<ProducedRegion> {
    let region = layout_region(client_id);
    match projector.publish(&region, store.snapshot(client_id)) {
        Some(version) => vec![ProducedRegion { region, version }],
        None => Vec::new(),
    }
}

/// Register the four `layout.*` intents on a handler registry.
///
/// Each route resolves the managed [`LayoutStore`] lazily (so it rejects
/// gracefully rather than panicking if the store is somehow absent), mutates the
/// dispatching client's tree via [`intent.client_id`](Intent::client_id), and
/// publishes that client's region. All four transforms are pure/fast tree edits,
/// so they run inline on the dispatcher's single writer.
pub fn register_layout_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("layout.split", move |intent, projector| {
        let store = store_of(&handle)?;
        let panel_id = required_str(intent, "panelId")?;
        let direction = required_enum(intent, "direction")?;
        let position = required_enum(intent, "position")?;
        store
            .split(&intent.client_id, &panel_id, direction, position)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.merge", move |intent, projector| {
        let store = store_of(&handle)?;
        let source = required_str(intent, "sourcePanelId")?;
        let target = required_str(intent, "targetPanelId")?;
        store
            .merge(&intent.client_id, &source, &target)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.moveTab", move |intent, projector| {
        let store = store_of(&handle)?;
        let tab_id = required_str(intent, "tabId")?;
        let target = required_str(intent, "targetPanelId")?;
        let edge = required_enum(intent, "edge")?;
        store
            .move_tab(&intent.client_id, &tab_id, &target, edge)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle;
    registry.route("layout.closeTabStructure", move |intent, projector| {
        let store = store_of(&handle)?;
        let tab_id = required_str(intent, "tabId")?;
        store
            .close_tab_structure(&intent.client_id, &tab_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });
}

/// Resolve the managed layout store, or a rejectable error if it is absent.
fn store_of(app_handle: &AppHandle) -> Result<Arc<LayoutStore>, (String, String)> {
    app_handle
        .try_state::<Arc<LayoutStore>>()
        .map(|state| (*state).clone())
        .ok_or_else(|| {
            (
                "unavailable".to_string(),
                "layout store is not initialized".to_string(),
            )
        })
}

/// Turn a [`LayoutError`] into an intent-ack `(code, message)` pair.
fn to_ack_err(err: LayoutError) -> (String, String) {
    (err.code().to_string(), err.to_string())
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

/// Extract and deserialize a required enum field (e.g. `direction`, `edge`).
fn required_enum<T: DeserializeOwned>(intent: &Intent, key: &str) -> Result<T, (String, String)> {
    let value = intent
        .payload
        .get(key)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))?;
    serde_json::from_value(value.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid '{key}': {e}")))
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
