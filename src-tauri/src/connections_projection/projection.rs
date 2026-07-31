//! Connections-tree projection: the shared `connections` region and the
//! `connection.*` intents (#2225, part of #2139 and #2153).
//!
//! Exposes the authoritative [`ConnectionsStore`] as one versioned,
//! multi-subscriber projection region and turns the tree-mutation transitions the
//! frontend currently drives into [`Intent`]s — mirroring the SSH-tunnels pilot
//! ([`crate::tunnel::projection`]), the session-lifecycle shadow
//! ([`crate::session_projection::projection`]) and the system-monitor shadow
//! ([`crate::system_monitor_projection::projection`]).
//!
//! # The `connections` region
//!
//! **Shared** (Open Design Decision #4: the saved-connection config is one
//! persisted file, identical for every client). The view model:
//!
//! ```json
//! { "folders": [ConnectionFolder, …], "connections": [SavedConnection, …] }
//! ```
//!
//! # Intents
//!
//! | kind                        | payload                          | effect                                       |
//! | --------------------------- | -------------------------------- | -------------------------------------------- |
//! | `connection.add`            | `{ connection }`                 | append a saved connection                    |
//! | `connection.update`         | `{ connection }`                 | replace the entry with the same id (edit)    |
//! | `connection.remove`         | `{ connectionId }`               | drop a connection                            |
//! | `connection.move`           | `{ connectionId, folderId? }`    | move a connection (absent/null → root)       |
//! | `connection.addFolder`      | `{ folder }`                     | append a folder                              |
//! | `connection.removeFolder`   | `{ folderId }`                   | remove a folder, re-homing its children      |
//! | `connection.toggleFolder`   | `{ folderId }`                   | flip a folder's `isExpanded`                 |
//!
//! Ordering is array position, matching the on-disk `children` order; there is no
//! standalone reorder transition in the `appStore` today, so none is shadowed. If
//! one is added later it becomes a new `connection.*` intent.
//!
//! # Shadow mode
//!
//! Registered and fully served, but **not** driving the live UI: no frontend
//! subscribes to `connections` or dispatches `connection.*` yet, so these intents
//! mutate only the shadow store and project to a region nobody renders. The
//! `appStore` connections slice remains authoritative. Per the substrate contract
//! the result of an intent is never returned inline — it always arrives as a
//! projection diff on the `connections` region.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::connection::config::{ConnectionFolder, SavedConnection};
use crate::connections_projection::store::ConnectionsStore;
use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};

/// The projection region id for the connections-tree domain (shared, per Open
/// Design Decision #4).
pub const CONNECTIONS_REGION: &str = "connections";

/// Publish the `connections` region from the store, fanning a diff out to every
/// subscriber and returning the advanced region for the intent ack (empty when
/// the view did not change).
pub fn publish_connections(projector: &Projector, store: &ConnectionsStore) -> Vec<ProducedRegion> {
    match projector.publish(CONNECTIONS_REGION, store.snapshot()) {
        Some(version) => vec![ProducedRegion {
            region: CONNECTIONS_REGION.to_string(),
            version,
        }],
        None => Vec::new(),
    }
}

/// Register the `connection.*` intents on a handler registry.
///
/// Each route resolves the managed [`ConnectionsStore`] lazily (so it rejects
/// gracefully rather than panicking if the store is somehow absent), applies the
/// transition, and publishes the shared region. All transitions are pure/fast
/// array edits, so they run inline on the dispatcher's single writer.
pub fn register_connection_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("connection.add", move |intent, projector| {
        let store = store_of(&handle)?;
        store.add_connection(required_connection(intent)?);
        Ok(publish_connections(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("connection.update", move |intent, projector| {
        let store = store_of(&handle)?;
        store.update_connection(required_connection(intent)?);
        Ok(publish_connections(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("connection.remove", move |intent, projector| {
        let store = store_of(&handle)?;
        store.remove_connection(&required_str(intent, "connectionId")?);
        Ok(publish_connections(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("connection.move", move |intent, projector| {
        let store = store_of(&handle)?;
        store.move_connection(
            &required_str(intent, "connectionId")?,
            optional_str(intent, "folderId"),
        );
        Ok(publish_connections(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("connection.addFolder", move |intent, projector| {
        let store = store_of(&handle)?;
        store.add_folder(required_folder(intent)?);
        Ok(publish_connections(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("connection.removeFolder", move |intent, projector| {
        let store = store_of(&handle)?;
        store.remove_folder(&required_str(intent, "folderId")?);
        Ok(publish_connections(projector, &store))
    });

    let handle = app_handle;
    registry.route("connection.toggleFolder", move |intent, projector| {
        let store = store_of(&handle)?;
        store.toggle_folder(&required_str(intent, "folderId")?);
        Ok(publish_connections(projector, &store))
    });
}

/// Resolve the managed connections store, or a rejectable error if absent.
fn store_of(app_handle: &AppHandle) -> Result<Arc<ConnectionsStore>, (String, String)> {
    app_handle
        .try_state::<Arc<ConnectionsStore>>()
        .map(|state| (*state).clone())
        .ok_or_else(|| {
            (
                "unavailable".to_string(),
                "connections store is not initialized".to_string(),
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

/// Extract an optional string field; absent or `null` → `None`.
fn optional_str(intent: &Intent, key: &str) -> Option<String> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Parse the required `connection` object as a [`SavedConnection`].
fn required_connection(intent: &Intent) -> Result<SavedConnection, (String, String)> {
    let value = intent.payload.get("connection").ok_or_else(|| {
        (
            "bad_payload".to_string(),
            "missing 'connection'".to_string(),
        )
    })?;
    serde_json::from_value(value.clone()).map_err(|e| {
        (
            "bad_payload".to_string(),
            format!("invalid connection: {e}"),
        )
    })
}

/// Parse the required `folder` object as a [`ConnectionFolder`].
fn required_folder(intent: &Intent) -> Result<ConnectionFolder, (String, String)> {
    let value = intent
        .payload
        .get("folder")
        .ok_or_else(|| ("bad_payload".to_string(), "missing 'folder'".to_string()))?;
    serde_json::from_value(value.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid folder: {e}")))
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
