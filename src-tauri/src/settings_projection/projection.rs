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
