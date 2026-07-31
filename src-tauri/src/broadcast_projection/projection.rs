//! Broadcast-membership projection: the client-scoped `broadcast@<clientId>`
//! region and the `broadcast.*` intents (#2242, Phase 4 step 5b of #2139, part
//! of #2206 / #2152).
//!
//! Exposes the authoritative [`BroadcastStore`] to each attached client as its
//! own versioned, multi-subscriber projection region and turns the broadcast
//! membership transitions the frontend currently drives into [`Intent`]s —
//! mirroring the client-scoped `layout` pilot ([`crate::layout::projection`])
//! and the restore-cohort reference ([`crate::restore_cohort_projection`]).
//!
//! # The `broadcast@<clientId>` region
//!
//! **Client-scoped** (Open Design Decision #4 / #6: broadcast membership is a
//! per-client input-fan-out overlay over that client's own tabs, not shared
//! infrastructure — like `layout` / `restore-cohort`). Each client gets its own
//! region, seeded lazily and mutated via `intent.client_id`. The view model:
//!
//! ```json
//! {
//!   "active": false,
//!   "sourceTabId": "tabId" | null,
//!   "scope": "all" | "panel" | "custom",
//!   "targetTabIds": ["tabId"],
//!   "lastScope": "all" | "panel" | "custom"
//! }
//! ```
//!
//! # Intents
//!
//! | kind                      | payload                                             | effect                                          |
//! | ------------------------- | --------------------------------------------------- | ----------------------------------------------- |
//! | `broadcast.start`         | `{ scope, sourceTabId, targetTabIds: [id] }`        | enter broadcast; targets = `{source} ∪ targets` |
//! | `broadcast.stop`          | `{}`                                                | leave broadcast; keep `scope` / `lastScope`     |
//! | `broadcast.toggle`        | `{ scope?, sourceTabId?, targetTabIds?: [id] }`     | active → stop; idle + source → start            |
//! | `broadcast.addTarget`     | `{ tabId }`                                          | add a tab to the target set                     |
//! | `broadcast.removeTarget`  | `{ tabId }`                                          | remove a tab from the target set                |
//! | `broadcast.replace`       | `{ active, sourceTabId, scope, targetTabIds, lastScope }` | overwrite the whole slice (render mirror) |
//!
//! `broadcast.replace` is the render-cut whole-state mirror (twin of
//! `monitor.replace`): the frontend keeps the region a faithful copy of its
//! `appStore` broadcast slice through it while the reducers stay authoritative,
//! so the UI can render from the projection with byte parity. The per-transition
//! `start`/`stop`/`toggle`/`addTarget`/`removeTarget` intents are the mutation
//! cut, which makes this store authoritative.
//!
//! Three frontend concerns need no dedicated intent because they read the
//! projected set rather than mutate it: `isBroadcastTarget` is a membership read
//! of `targetTabIds`; `getBroadcastTargetTabIds` intersects the set with the
//! live *connected* terminals at the fan-out seam; and `refreshBroadcastMembership`
//! re-derives membership from the scope + tab tree (frontend) and reconciles the
//! delta via `broadcast.addTarget` / `broadcast.removeTarget`.
//!
//! # Render + mutation cut
//!
//! Now driving the live UI (PR for #2242, following the #2254 shadow): the
//! frontend subscribes to `broadcast@<clientId>`, seeds it with `broadcast.replace`
//! to keep it a faithful mirror of `appStore`, renders the broadcast UI from it
//! (render cut, on by default), and routes the membership actions through the
//! per-transition `broadcast.*` intents (mutation cut, on by default) so this
//! store is authoritative. The `appStore` broadcast reducers remain in place as
//! the parity-safe fallback (the render gate falls back when the region has not
//! caught up; each mirrored intent is best-effort). Per the substrate contract the
//! result of an intent is never returned inline — it always arrives as a
//! projection diff on the client's region.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::broadcast_projection::store::{BroadcastScope, BroadcastStore};
use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};

/// The projection region id for a client's broadcast membership
/// (`broadcast@<clientId>`).
pub fn broadcast_region(client_id: &str) -> String {
    format!("broadcast@{client_id}")
}

/// Publish a client's `broadcast` region from the store, fanning a diff out to
/// every subscriber and returning the advanced region for the intent ack (empty
/// when the view did not change).
pub fn publish_broadcast(
    projector: &Projector,
    store: &BroadcastStore,
    client_id: &str,
) -> Vec<ProducedRegion> {
    let region = broadcast_region(client_id);
    match projector.publish(&region, store.snapshot(client_id)) {
        Some(version) => vec![ProducedRegion { region, version }],
        None => Vec::new(),
    }
}

/// Register the `broadcast.*` intents on a handler registry.
///
/// Each route resolves the managed [`BroadcastStore`] lazily (so it rejects
/// gracefully rather than panicking if the store is somehow absent), mutates the
/// dispatching client's membership via [`intent.client_id`](Intent::client_id),
/// and publishes that client's region. All transitions are pure/fast map edits,
/// so they run inline on the dispatcher's single writer.
pub fn register_broadcast_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("broadcast.start", move |intent, projector| {
        let store = store_of(&handle)?;
        let scope = required_scope(intent, "scope")?;
        let source = required_str(intent, "sourceTabId")?;
        let targets = required_str_array(intent, "targetTabIds")?;
        store.start(&intent.client_id, scope, &source, &targets);
        Ok(publish_broadcast(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("broadcast.replace", move |intent, projector| {
        // The render-cut whole-state mirror of the frontend `appStore` slice: set
        // every field verbatim (no source-prepend/de-dup — the mirrored set is
        // already canonical).
        let store = store_of(&handle)?;
        let active = required_bool(intent, "active")?;
        let source = optional_str(intent, "sourceTabId");
        let scope = required_scope(intent, "scope")?;
        let targets = required_str_array(intent, "targetTabIds")?;
        let last_scope = required_scope(intent, "lastScope")?;
        store.replace(&intent.client_id, active, source, scope, targets, last_scope);
        Ok(publish_broadcast(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("broadcast.stop", move |intent, projector| {
        let store = store_of(&handle)?;
        store.stop(&intent.client_id);
        Ok(publish_broadcast(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("broadcast.toggle", move |intent, projector| {
        let store = store_of(&handle)?;
        // The start branch's payload is optional: it is read only when idle, and
        // the frontend resolves scope/source/targets from the live tab tree.
        let scope = optional_scope(intent, "scope")?.unwrap_or_default();
        let source = optional_str(intent, "sourceTabId");
        let targets = optional_str_array(intent, "targetTabIds")?;
        store.toggle(&intent.client_id, scope, source.as_deref(), &targets);
        Ok(publish_broadcast(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("broadcast.addTarget", move |intent, projector| {
        let store = store_of(&handle)?;
        let tab_id = required_str(intent, "tabId")?;
        store.add_target(&intent.client_id, &tab_id);
        Ok(publish_broadcast(projector, &store, &intent.client_id))
    });

    let handle = app_handle;
    registry.route("broadcast.removeTarget", move |intent, projector| {
        let store = store_of(&handle)?;
        let tab_id = required_str(intent, "tabId")?;
        store.remove_target(&intent.client_id, &tab_id);
        Ok(publish_broadcast(projector, &store, &intent.client_id))
    });
}

/// Resolve the managed broadcast store, or a rejectable error if absent.
fn store_of(app_handle: &AppHandle) -> Result<Arc<BroadcastStore>, (String, String)> {
    app_handle
        .try_state::<Arc<BroadcastStore>>()
        .map(|state| (*state).clone())
        .ok_or_else(|| {
            (
                "unavailable".to_string(),
                "broadcast store is not initialized".to_string(),
            )
        })
}

/// Parse a `BroadcastScope` from a JSON string, or a rejectable error.
fn parse_scope(value: &str) -> Result<BroadcastScope, (String, String)> {
    match value {
        "all" => Ok(BroadcastScope::All),
        "panel" => Ok(BroadcastScope::Panel),
        "custom" => Ok(BroadcastScope::Custom),
        _ => Err((
            "bad_payload".to_string(),
            "invalid 'scope' (expected \"all\" | \"panel\" | \"custom\")".to_string(),
        )),
    }
}

/// Parse a required scope field (`key`) into a [`BroadcastScope`].
fn required_scope(intent: &Intent, key: &str) -> Result<BroadcastScope, (String, String)> {
    let value = intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))?;
    parse_scope(value)
}

/// Parse an optional scope field (`key`); absent → `None`, present-but-invalid → error.
fn optional_scope(intent: &Intent, key: &str) -> Result<Option<BroadcastScope>, (String, String)> {
    match intent.payload.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let s = value.as_str().ok_or_else(|| {
                (
                    "bad_payload".to_string(),
                    format!("invalid '{key}' (not a string)"),
                )
            })?;
            parse_scope(s).map(Some)
        }
    }
}

/// Extract a required boolean field from an intent payload.
fn required_bool(intent: &Intent, key: &str) -> Result<bool, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
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

/// Extract an optional string field (absent → `None`).
fn optional_str(intent: &Intent, key: &str) -> Option<String> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Extract a required array-of-strings field (e.g. `targetTabIds`).
fn required_str_array(intent: &Intent, key: &str) -> Result<Vec<String>, (String, String)> {
    let arr = intent
        .payload
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))?;
    collect_str_array(arr, key)
}

/// Extract an optional array-of-strings field; absent → `[]`, present entries
/// must all be strings.
fn optional_str_array(intent: &Intent, key: &str) -> Result<Vec<String>, (String, String)> {
    match intent.payload.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => {
            let arr = value.as_array().ok_or_else(|| {
                (
                    "bad_payload".to_string(),
                    format!("invalid '{key}' (not an array)"),
                )
            })?;
            collect_str_array(arr, key)
        }
    }
}

/// Collect a JSON array into `Vec<String>`, rejecting any non-string entry.
fn collect_str_array(arr: &[Value], key: &str) -> Result<Vec<String>, (String, String)> {
    arr.iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| ("bad_payload".to_string(), format!("invalid '{key}' entry")))
        })
        .collect()
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
