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
//! mutated via `intent.client_id`.
//!
//! The store is authoritative for the **full** multi-group layout
//! ([`LayoutStore::snapshot_full`] → `{ activeGroupId, groups: [...] }`), but the
//! published region keeps the **back-compat active-group** shape (#2283 slice A)
//! so the current render path is unaffected until a later slice flips the
//! frontend:
//!
//! ```json
//! { "root": <PanelNode>, "activePanelId": "panel-…" }
//! ```
//!
//! # Intents
//!
//! Every structural intent accepts an optional `groupId` (defaulting to the
//! active group). The group-level intents mutate the group set itself.
//!
//! | kind                        | payload                                        | effect                                        |
//! | --------------------------- | ---------------------------------------------- | --------------------------------------------- |
//! | `layout.split`              | `{ groupId?, panelId, direction, position }`   | split a leaf, inserting a new empty leaf       |
//! | `layout.merge`              | `{ groupId?, sourcePanelId, targetPanelId }`   | move all tabs into the target, drop the source |
//! | `layout.moveTab`            | `{ groupId?, tabId, targetPanelId, edge }`     | move a tab (center = merge; edge = split)      |
//! | `layout.closeTabStructure`  | `{ groupId?, tabId }`                          | remove a tab; drop its leaf if left empty      |
//! | `layout.addTab`             | `{ groupId?, panelId, tab }`                   | insert a minimal tab into a panel, focus it     |
//! | `layout.removePanel`        | `{ groupId?, panelId }`                        | drop a whole leaf panel, then simplify         |
//! | `layout.reorderTabs`        | `{ groupId?, panelId, oldIndex, newIndex }`    | reorder a tab within its leaf                   |
//! | `layout.setActivePanel`     | `{ groupId?, panelId }`                        | repoint the focused panel                       |
//! | `layout.setActiveTab`       | `{ groupId?, tabId }`                          | focus a tab within its leaf                     |
//! | `layout.resize`             | `{ groupId?, splitId, sizes }`                 | persist a split's child percentage sizes        |
//! | `layout.replace`            | `{ root, activePanelId }`                      | install a tree over the active group (seed path)|
//! | `layout.addGroup`           | `{ name? }`                                    | append a fresh group, make it active            |
//! | `layout.closeGroup`         | `{ groupId }`                                  | remove a group (rejects the last one)           |
//! | `layout.renameGroup`        | `{ groupId, name }`                            | rename a group                                  |
//! | `layout.setGroupColor`      | `{ groupId, color? }`                          | set/clear a group's accent colour               |
//! | `layout.setActiveGroup`     | `{ groupId }`                                  | switch the active group                         |
//! | `layout.reorderGroups`      | `{ fromIndex, toIndex }`                       | reorder the group set                           |
//! | `layout.moveTabToGroup`     | `{ tabId, fromPanelId, targetGroupId }`        | move a tab from the active group to another     |
//! | `layout.addGroupWithTab`    | `{ tabId, fromPanelId }`                       | pull a tab into a brand-new active group        |
//! | `layout.replaceGroups`      | `{ activeGroupId, groups }`                    | install a whole multi-group layout              |
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

use termihub_core::layout::panel_tree::{PanelNode, Tab};

use crate::layout::store::{GroupLayout, LayoutError, LayoutStore};
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
    // Group-aware widening (#2283 slice C): the region carries the full
    // multi-group view `{ groups, activeGroupId }` so the frontend renders every
    // tab group (composing the active one). Was the back-compat active-group
    // `{ root, activePanelId }` through slice A/B.
    match projector.publish(&region, store.snapshot_full(client_id)) {
        Some(version) => vec![ProducedRegion { region, version }],
        None => Vec::new(),
    }
}

/// Register the `layout.*` intents on a handler registry.
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
        let group = optional_str(intent, "groupId");
        let panel_id = required_str(intent, "panelId")?;
        let direction = required_enum(intent, "direction")?;
        let position = required_enum(intent, "position")?;
        store
            .split(
                &intent.client_id,
                group.as_deref(),
                &panel_id,
                direction,
                position,
            )
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.merge", move |intent, projector| {
        let store = store_of(&handle)?;
        let group = optional_str(intent, "groupId");
        let source = required_str(intent, "sourcePanelId")?;
        let target = required_str(intent, "targetPanelId")?;
        store
            .merge(&intent.client_id, group.as_deref(), &source, &target)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.moveTab", move |intent, projector| {
        let store = store_of(&handle)?;
        let group = optional_str(intent, "groupId");
        let tab_id = required_str(intent, "tabId")?;
        let target = required_str(intent, "targetPanelId")?;
        let edge = required_enum(intent, "edge")?;
        store
            .move_tab(&intent.client_id, group.as_deref(), &tab_id, &target, edge)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.closeTabStructure", move |intent, projector| {
        let store = store_of(&handle)?;
        let group = optional_str(intent, "groupId");
        let tab_id = required_str(intent, "tabId")?;
        store
            .close_tab_structure(&intent.client_id, group.as_deref(), &tab_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.addTab", move |intent, projector| {
        let store = store_of(&handle)?;
        let group = optional_str(intent, "groupId");
        let panel_id = required_str(intent, "panelId")?;
        let tab = parse_tab(intent)?;
        store
            .add_tab(&intent.client_id, group.as_deref(), &panel_id, tab)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.removePanel", move |intent, projector| {
        let store = store_of(&handle)?;
        let group = optional_str(intent, "groupId");
        let panel_id = required_str(intent, "panelId")?;
        store
            .remove_panel(&intent.client_id, group.as_deref(), &panel_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.reorderTabs", move |intent, projector| {
        let store = store_of(&handle)?;
        let group = optional_str(intent, "groupId");
        let panel_id = required_str(intent, "panelId")?;
        let old_index = required_usize(intent, "oldIndex")?;
        let new_index = required_usize(intent, "newIndex")?;
        store
            .reorder_tabs(
                &intent.client_id,
                group.as_deref(),
                &panel_id,
                old_index,
                new_index,
            )
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.setActivePanel", move |intent, projector| {
        let store = store_of(&handle)?;
        let group = optional_str(intent, "groupId");
        let panel_id = required_str(intent, "panelId")?;
        store
            .set_active_panel(&intent.client_id, group.as_deref(), &panel_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.setActiveTab", move |intent, projector| {
        let store = store_of(&handle)?;
        let group = optional_str(intent, "groupId");
        let tab_id = required_str(intent, "tabId")?;
        store
            .set_active_tab(&intent.client_id, group.as_deref(), &tab_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.resize", move |intent, projector| {
        let store = store_of(&handle)?;
        let group = optional_str(intent, "groupId");
        let split_id = required_str(intent, "splitId")?;
        let sizes = required_sizes(intent, "sizes")?;
        store
            .resize(&intent.client_id, group.as_deref(), &split_id, sizes)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.replace", move |intent, projector| {
        let store = store_of(&handle)?;
        let (root, active_panel_id) = parse_replace(intent)?;
        store.replace(&intent.client_id, root, active_panel_id);
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    // ── Group-level routes (twins of the frontend `*TabGroup*` reducers) ──

    let handle = app_handle.clone();
    registry.route("layout.addGroup", move |intent, projector| {
        let store = store_of(&handle)?;
        let name = optional_str(intent, "name");
        store.add_group(&intent.client_id, name);
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.closeGroup", move |intent, projector| {
        let store = store_of(&handle)?;
        let group_id = required_str(intent, "groupId")?;
        store
            .close_group(&intent.client_id, &group_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.renameGroup", move |intent, projector| {
        let store = store_of(&handle)?;
        let group_id = required_str(intent, "groupId")?;
        let name = required_str(intent, "name")?;
        store
            .rename_group(&intent.client_id, &group_id, name)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.setGroupColor", move |intent, projector| {
        let store = store_of(&handle)?;
        let group_id = required_str(intent, "groupId")?;
        let color = optional_str(intent, "color");
        store
            .set_group_color(&intent.client_id, &group_id, color)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.setActiveGroup", move |intent, projector| {
        let store = store_of(&handle)?;
        let group_id = required_str(intent, "groupId")?;
        store
            .set_active_group(&intent.client_id, &group_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.reorderGroups", move |intent, projector| {
        let store = store_of(&handle)?;
        let from_index = required_usize(intent, "fromIndex")?;
        let to_index = required_usize(intent, "toIndex")?;
        store
            .reorder_groups(&intent.client_id, from_index, to_index)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.moveTabToGroup", move |intent, projector| {
        let store = store_of(&handle)?;
        let tab_id = required_str(intent, "tabId")?;
        let from_panel_id = required_str(intent, "fromPanelId")?;
        let target_group_id = required_str(intent, "targetGroupId")?;
        store
            .move_tab_to_group(&intent.client_id, &tab_id, &from_panel_id, &target_group_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("layout.addGroupWithTab", move |intent, projector| {
        let store = store_of(&handle)?;
        let tab_id = required_str(intent, "tabId")?;
        let from_panel_id = required_str(intent, "fromPanelId")?;
        store
            .add_group_with_tab(&intent.client_id, &tab_id, &from_panel_id)
            .map_err(to_ack_err)?;
        Ok(publish_layout(projector, &store, &intent.client_id))
    });

    let handle = app_handle;
    registry.route("layout.replaceGroups", move |intent, projector| {
        let store = store_of(&handle)?;
        let (groups, active_group_id) = parse_replace_groups(intent)?;
        store.replace_groups(&intent.client_id, groups, active_group_id);
        Ok(publish_layout(projector, &store, &intent.client_id))
    });
}

/// Parse a `layout.replace` payload `{ root: PanelNode, activePanelId? }`.
fn parse_replace(intent: &Intent) -> Result<(PanelNode, Option<String>), (String, String)> {
    let root_value = intent
        .payload
        .get("root")
        .ok_or_else(|| ("bad_payload".to_string(), "missing 'root'".to_string()))?;
    let root: PanelNode = serde_json::from_value(root_value.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid 'root': {e}")))?;
    let active_panel_id = intent
        .payload
        .get("activePanelId")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok((root, active_panel_id))
}

/// Parse a `layout.addTab` payload's `tab` field into a minimal [`Tab`]
/// (`{ id, sessionId?, contentType }`).
fn parse_tab(intent: &Intent) -> Result<Tab, (String, String)> {
    let tab_value = intent
        .payload
        .get("tab")
        .ok_or_else(|| ("bad_payload".to_string(), "missing 'tab'".to_string()))?;
    serde_json::from_value(tab_value.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid 'tab': {e}")))
}

/// Parse a `layout.replaceGroups` payload `{ activeGroupId, groups: [GroupLayout] }`.
fn parse_replace_groups(intent: &Intent) -> Result<(Vec<GroupLayout>, String), (String, String)> {
    let groups_value = intent
        .payload
        .get("groups")
        .ok_or_else(|| ("bad_payload".to_string(), "missing 'groups'".to_string()))?;
    let groups: Vec<GroupLayout> = serde_json::from_value(groups_value.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid 'groups': {e}")))?;
    let active_group_id = intent
        .payload
        .get("activeGroupId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            (
                "bad_payload".to_string(),
                "missing 'activeGroupId'".to_string(),
            )
        })?;
    Ok((groups, active_group_id))
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

/// Extract an optional string field (e.g. `groupId`, or a nullable `color`).
/// Returns `None` when the key is absent or not a string.
fn optional_str(intent: &Intent, key: &str) -> Option<String> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Extract a required non-negative integer field (e.g. a tab index).
fn required_usize(intent: &Intent, key: &str) -> Result<usize, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

/// Extract a required array of finite numbers (e.g. split `sizes`).
fn required_sizes(intent: &Intent, key: &str) -> Result<Vec<f64>, (String, String)> {
    let arr = intent
        .payload
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))?;
    arr.iter()
        .map(|v| {
            v.as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(|| ("bad_payload".to_string(), format!("invalid '{key}' entry")))
        })
        .collect()
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
