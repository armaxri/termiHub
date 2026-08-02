//! Settings projection: the shared `settings` region and the `settings.*`
//! intents (#2227, part of #2153 / #2139).
//!
//! Exposes the authoritative [`SettingsStore`] as one versioned, multi-subscriber
//! projection region and turns the settings mutations the frontend currently
//! drives into [`Intent`]s — mirroring the shared system-monitor shadow
//! ([`crate::system_monitor_projection::projection`]) and agents shadow
//! ([`crate::agents_projection::projection`]).
//!
//! # The `settings` region
//!
//! **Shared** (Open Design Decision #4 / #6: `AppSettings` is a single persisted
//! document every client sees). The view model is the settings document itself —
//! the frontend `AppSettings` shape (camelCase keys):
//!
//! ```json
//! {
//!   "version": "1",
//!   "externalConnectionFiles": [],
//!   "powerMonitoringEnabled": true,
//!   "fileBrowserEnabled": true,
//!   "theme": "dark",
//!   "fontSize": 14,
//!   …
//! }
//! ```
//!
//! # Intents
//!
//! | kind               | payload             | effect                                        |
//! | ------------------ | ------------------- | --------------------------------------------- |
//! | `settings.replace` | `{ settings: {…} }` | overwrite the whole settings document         |
//! | `settings.patch`   | `{ patch: {…} }`    | shallow-merge top-level keys into the document |
//! | `settings.reset`   | `{}`                | reset the document to the default baseline     |
//!
//! `replace` mirrors `updateSettings` / `saveSettings` (a whole-document save);
//! `patch` mirrors the targeted `{ ...current.settings, <field> }` spreads
//! (`updateShellIntegration`, the layout persists); `reset` resets to defaults.
//!
//! # Shadow mode
//!
//! Registered and fully served, but **not** driving the live UI: no frontend
//! subscribes to `settings` or dispatches `settings.*` yet, so these intents
//! mutate only the shadow store and project to a region nobody renders. The
//! `appStore` `settings` slice remains authoritative. Per the substrate contract
//! the result of an intent is never returned inline — it always arrives as a
//! projection diff on the `settings` region.

use std::sync::Arc;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use crate::commands::projection::ProjectionState;
use crate::connection::manager::ConnectionManager;
use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};
use crate::settings_projection::store::SettingsStore;

/// The projection region id for the settings domain (shared, per Open Design
/// Decision #4 / #6).
pub const SETTINGS_REGION: &str = "settings";

/// Publish the `settings` region from the store, fanning a diff out to every
/// subscriber and returning the advanced region for the intent ack (empty when
/// the view did not change).
pub fn publish_settings(projector: &Projector, store: &SettingsStore) -> Vec<ProducedRegion> {
    match projector.publish(SETTINGS_REGION, store.snapshot()) {
        Some(version) => vec![ProducedRegion {
            region: SETTINGS_REGION.to_string(),
            version,
        }],
        None => Vec::new(),
    }
}

/// Fold the persisted [`AppSettings`](crate::connection::settings::AppSettings)
/// document — the real authority behind `get_settings` / `save_settings` — into
/// the managed [`SettingsStore`] **server-side** and fan the resulting `settings`
/// region diff out to every subscriber (#2386, prerequisite for #2227).
///
/// This is the server-authority counterpart to the `settings.*` intents
/// [`register_settings_intents`] registers: the whole-document save the frontend
/// currently mirrors via a `settings.replace` intent is reflected here **at the
/// source** — the instant a `save_settings` lands in the persisted
/// [`ConnectionManager`] authority — with no client round-trip required for the
/// store to be correct.
///
/// It reflects the manager's **whole** post-save document (via
/// [`ConnectionManager::get_settings_resolved`] serialized to its camelCase view
/// shape + [`SettingsStore::replace`]) rather than a targeted patch. `AppSettings`
/// is a single opaque document persisted and replaced as a whole, so reflecting
/// the authoritative resolved document guarantees the region always equals what
/// was actually persisted (including the resolved serial-port-scan prefixes the
/// frontend receives). The projector coalesces an unchanged document to no diff,
/// so a save that changes nothing is a no-op.
///
/// It is **additive**: the `settings.*` intents stay in place, and nothing in the
/// live UI subscribes to the region yet, so this changes no user-facing behavior.
/// Making the store authoritative (dropping the redundant `appStore` reducer) is
/// the later #2227 reducer-removal.
///
/// Best-effort and non-fatal: if the store or the connection manager is not
/// managed (e.g. a headless unit-test app that never ran `setup()`), or the
/// resolved settings do not serialize to a JSON object, the fold is skipped
/// rather than erroring. The `replace` runs to completion synchronously before
/// the publish, so the store lock is never held across an await.
pub fn fold_settings_from_manager<R: tauri::Runtime>(app_handle: &AppHandle<R>) {
    let Some(store) = app_handle.try_state::<Arc<SettingsStore>>() else {
        return;
    };
    let store: Arc<SettingsStore> = (*store).clone();
    let Some(manager) = app_handle.try_state::<ConnectionManager>() else {
        return;
    };
    let Ok(Value::Object(doc)) = serde_json::to_value(manager.get_settings_resolved()) else {
        return;
    };
    store.replace(doc);
    if let Some(projection) = app_handle.try_state::<ProjectionState>() {
        publish_settings(&projection.projector, &store);
    }
}

/// Register the `settings.*` intents on a handler registry.
///
/// Each route resolves the managed [`SettingsStore`] lazily (so it rejects
/// gracefully rather than panicking if the store is somehow absent), applies the
/// transition, and publishes the shared region. All transitions are pure/fast
/// in-memory map edits, so they run inline on the dispatcher's single writer.
pub fn register_settings_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("settings.replace", move |intent, projector| {
        let store = store_of(&handle)?;
        store.replace(required_object(intent, "settings")?);
        Ok(publish_settings(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("settings.patch", move |intent, projector| {
        let store = store_of(&handle)?;
        store.patch(required_object(intent, "patch")?);
        Ok(publish_settings(projector, &store))
    });

    let handle = app_handle;
    registry.route("settings.reset", move |_intent, projector| {
        let store = store_of(&handle)?;
        store.reset();
        Ok(publish_settings(projector, &store))
    });
}

/// Resolve the managed settings store, or a rejectable error if absent.
fn store_of(app_handle: &AppHandle) -> Result<Arc<SettingsStore>, (String, String)> {
    app_handle
        .try_state::<Arc<SettingsStore>>()
        .map(|state| (*state).clone())
        .ok_or_else(|| {
            (
                "unavailable".to_string(),
                "settings store is not initialized".to_string(),
            )
        })
}

/// Extract a required JSON-object field from an intent payload (the whole
/// document for `settings.replace`, the partial for `settings.patch`). A missing
/// or non-object value is a `bad_payload` rejection that advances nothing.
fn required_object(intent: &Intent, key: &str) -> Result<Map<String, Value>, (String, String)> {
    match intent.payload.get(key) {
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(_) => Err((
            "bad_payload".to_string(),
            format!("'{key}' must be an object"),
        )),
        None => Err(("bad_payload".to_string(), format!("missing '{key}'"))),
    }
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
