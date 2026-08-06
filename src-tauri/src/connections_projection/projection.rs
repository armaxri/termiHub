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
//! | `connection.replace`        | `{ folders?, connections? }`     | overwrite the whole slice (render-cut mirror)|
//!
//! `connection.replace` is the whole-slice seed the frontend render cut (#2225)
//! uses to keep the shared `connections` region a faithful copy of `appStore`'s
//! connections slice while `appStore` stays authoritative — the analog of the
//! agents bridge's `agent.replace`. The per-transition intents above drive the
//! store once the mutation cut lands (a later step).
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

use crate::commands::projection::ProjectionState;
use crate::connection::config::{ConnectionFolder, SavedConnection};
use crate::connection::manager::ConnectionManager;
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

/// Fold the [`ConnectionManager`]'s authoritative connections tree — the main
/// persisted store **and** the external-file overlay — into the managed
/// [`ConnectionsStore`] **server-side** and fan the resulting `connections` region
/// diff out to every subscriber (#2389/#2394, prerequisite for #2225).
///
/// This is the server-authority counterpart to the `connection.*` intents
/// [`register_connection_intents`] registers: the same store transitions the
/// frontend currently mirrors via `connection.*` intents are reflected here **at
/// the source** — the instant a saved-connection / folder mutation
/// (`save_connection` / `delete_connection` / `move_connection_to_file` /
/// `save_folder` / `delete_folder` / import) or an external-file change
/// (`reload_external_connections` / `save_external_file`) lands in the persisted
/// [`ConnectionManager`] authority — with no client round-trip required for the
/// store to be correct.
///
/// It reflects the manager's **whole** post-mutation view via
/// [`ConnectionManager::load_unified_view`] + [`ConnectionsStore::replace`] rather
/// than replaying one fine-grained store op per call. This is deliberate: the
/// manager is a *coarse* authority — a single `save_connection` may recompute the
/// path-based id, deduplicate sibling names, re-home children, and migrate
/// credentials — so replaying the intent-level ops (`add` / `update` / …) against
/// the store would drift from the persisted truth. Reflecting the manager's
/// authoritative snapshot guarantees the region always equals what was actually
/// persisted.
///
/// The unified view is exactly the set the frontend `appStore` slice holds: the
/// main store's folders + connections with every **enabled external file**'s
/// flattened connections appended (each carrying its `source_file`), so #2225's
/// render cut is non-lossy for external-file connections (#2394). External-file
/// **load errors** are handled the way the frontend does — a file that fails to
/// load contributes no rows (the error is not modelled in the region; the
/// frontend only logs it, it is not part of the `appStore` connections slice).
/// The projector coalesces an unchanged snapshot to no diff, so a mutation that
/// leaves the unified tree untouched is a no-op.
///
/// It is **additive**: the per-transition `connection.*` intents and the
/// render-cut `connection.replace` mirror stay in place, and nothing in the live
/// UI subscribes to the region yet, so this changes no user-facing behavior.
/// Dropping the now-redundant client re-dispatch is the later #2225
/// render/mutation inversion.
///
/// Best-effort and non-fatal: if the store, the connection manager, or the
/// projection state is not managed (e.g. a headless unit-test app that never ran
/// `setup()`), or the disk reload inside `load_unified_view` fails, the fold is
/// skipped rather than erroring. The `replace` runs to completion synchronously
/// before the publish, so the store lock is never held across an await.
pub fn fold_connections_from_manager<R: tauri::Runtime>(app_handle: &AppHandle<R>) {
    let Some(store) = app_handle.try_state::<Arc<ConnectionsStore>>() else {
        return;
    };
    let store: Arc<ConnectionsStore> = (*store).clone();
    let Some(manager) = app_handle.try_state::<ConnectionManager>() else {
        return;
    };
    let Ok(view) = manager.load_unified_view() else {
        return;
    };
    store.replace(view.folders, view.connections);
    if let Some(projection) = app_handle.try_state::<ProjectionState>() {
        publish_connections(&projection.projector, &store);
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

    let handle = app_handle.clone();
    registry.route("connection.toggleFolder", move |intent, projector| {
        let store = store_of(&handle)?;
        store.toggle_folder(&required_str(intent, "folderId")?);
        Ok(publish_connections(projector, &store))
    });

    let handle = app_handle;
    registry.route("connection.replace", move |intent, projector| {
        let store = store_of(&handle)?;
        let (folders, connections) = required_replace(intent)?;
        store.replace(folders, connections);
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

/// Parse a `connection.replace` payload into the whole-slice snapshot the
/// render-cut mirror carries: `{ folders: [ConnectionFolder], connections:
/// [SavedConnection] }` — the shape of [`ConnectionsStore::snapshot`]. Any field
/// absent or `null` is treated as an empty array, so a mirror that clears the
/// whole tree is expressible; a present-but-malformed field is a `bad_payload`
/// rejection that advances nothing.
#[allow(clippy::type_complexity)]
fn required_replace(
    intent: &Intent,
) -> Result<(Vec<ConnectionFolder>, Vec<SavedConnection>), (String, String)> {
    Ok((
        optional_typed(intent, "folders")?,
        optional_typed(intent, "connections")?,
    ))
}

/// Parse an optional typed field, treating an absent or `null` value as the
/// type's default (an empty list). Lets a mirror that clears a whole array be
/// expressed by omitting the field; a present-but-malformed field is a
/// `bad_payload` rejection.
fn optional_typed<T: serde::de::DeserializeOwned + Default>(
    intent: &Intent,
    key: &str,
) -> Result<T, (String, String)> {
    match intent.payload.get(key) {
        None | Some(Value::Null) => Ok(T::default()),
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|e| ("bad_payload".to_string(), format!("invalid {key}: {e}"))),
    }
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
