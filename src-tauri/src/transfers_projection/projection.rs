//! Transfer-queue projection: the shared `transfers` region and the
//! `transfer.*` intents (#2229, Phase 5 of #2139 / #2153).
//!
//! Exposes the authoritative [`TransferStore`] as one versioned, multi-subscriber
//! projection region and turns the transfer-queue transitions the frontend
//! currently drives into [`Intent`]s — mirroring the SSH-tunnels pilot
//! ([`crate::tunnel::projection`]) and the system-monitor shadow
//! ([`crate::system_monitor_projection::projection`]).
//!
//! # The `transfers` region
//!
//! **Shared** (Open Design Decision #4: infrastructure domains are shared). A
//! transfer runs backend-side; its progress/state is a property of the transfer,
//! not of a viewing client, so two clients watching the same queue see the same
//! row. The view model:
//!
//! ```json
//! { "queue": { "<transferId>": TransferEntry, ... }, "minimized": false }
//! ```
//!
//! # Intents
//!
//! | kind                       | payload                    | effect                                       |
//! | -------------------------- | -------------------------- | -------------------------------------------- |
//! | `transfer.seed`            | `{ seed }`                 | enqueue a `queued` row (idempotent)          |
//! | `transfer.progress`        | `{ progress }`             | fold a `transfer-progress` event             |
//! | `transfer.reconcile`       | `{ snapshots }`            | settle stuck rows from a `transfer_list`     |
//! | `transfer.remove`          | `{ id }`                   | drop one queue row                           |
//! | `transfer.clearCompleted`  | `{}`                       | drop every `completed` row                   |
//! | `transfer.setMinimized`    | `{ minimized }`            | collapse/expand the panel                    |
//! | `transfer.replace`         | `{ queue, minimized }`     | overwrite the whole slice (render mirror)    |
//!
//! `transfer.replace` is the whole-slice seed the (later) frontend render cut
//! (#2229) uses to keep the shared region a faithful copy of `appStore`'s
//! transfer-queue slice while `appStore` stays authoritative — the analog of the
//! system-monitor bridge's `monitor.replace`. The granular `seed` / `progress` /
//! `reconcile` / `remove` / `clearCompleted` / `setMinimized` transitions drive
//! the store for the (later) mutation cut.
//!
//! # Shadow only (#2229)
//!
//! Registered and fully served, but nothing in the live UI subscribes to or
//! dispatches these intents yet — a pure shadow foundation. Later steps cut
//! rendering, then the mutations, over to it, keeping the `appStore` reducers as
//! the parity-safe fallback. Per the substrate contract the result of an intent
//! is never returned inline — it always arrives as a projection diff on the
//! `transfers` region.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};
use crate::transfers_projection::store::{
    TransferEntry, TransferProgress, TransferSeed, TransferSnapshot, TransferStore,
};

/// The projection region id for the transfer-queue domain (shared, per Open
/// Design Decision #4).
pub const TRANSFERS_REGION: &str = "transfers";

/// Current wall-clock milliseconds — the `now` injected into the queue folds
/// (`updatedAt`, throughput deltas), matching the frontend `Date.now()`.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Publish the `transfers` region from the store, fanning a diff out to every
/// subscriber and returning the advanced region for the intent ack (empty when
/// the view did not change).
pub fn publish_transfers(projector: &Projector, store: &TransferStore) -> Vec<ProducedRegion> {
    match projector.publish(TRANSFERS_REGION, store.snapshot()) {
        Some(version) => vec![ProducedRegion {
            region: TRANSFERS_REGION.to_string(),
            version,
        }],
        None => Vec::new(),
    }
}

/// Register the `transfer.*` intents on a handler registry.
///
/// Each route resolves the managed [`TransferStore`] lazily (so it rejects
/// gracefully rather than panicking if the store is somehow absent), applies the
/// transition, and publishes the shared region. All transitions are pure/fast map
/// edits, so they run inline on the dispatcher's single writer.
pub fn register_transfer_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("transfer.seed", move |intent, projector| {
        let store = store_of(&handle)?;
        let seed = parse_field::<TransferSeed>(intent, "seed")?;
        store.seed(&seed, now_ms());
        Ok(publish_transfers(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("transfer.progress", move |intent, projector| {
        let store = store_of(&handle)?;
        let progress = parse_field::<TransferProgress>(intent, "progress")?;
        store.progress(&progress, now_ms());
        Ok(publish_transfers(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("transfer.reconcile", move |intent, projector| {
        let store = store_of(&handle)?;
        let snapshots = parse_field::<Vec<TransferSnapshot>>(intent, "snapshots")?;
        store.reconcile(&snapshots, now_ms());
        Ok(publish_transfers(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("transfer.remove", move |intent, projector| {
        let store = store_of(&handle)?;
        let id = required_str(intent, "id")?;
        store.remove(&id);
        Ok(publish_transfers(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("transfer.clearCompleted", move |_intent, projector| {
        let store = store_of(&handle)?;
        store.clear_completed();
        Ok(publish_transfers(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("transfer.setMinimized", move |intent, projector| {
        let store = store_of(&handle)?;
        store.set_minimized(required_bool(intent, "minimized")?);
        Ok(publish_transfers(projector, &store))
    });

    let handle = app_handle;
    registry.route("transfer.replace", move |intent, projector| {
        let store = store_of(&handle)?;
        let (queue, minimized) = parse_replace(intent)?;
        store.replace(queue, minimized);
        Ok(publish_transfers(projector, &store))
    });
}

/// Resolve the managed transfer store, or a rejectable error if absent.
fn store_of(app_handle: &AppHandle) -> Result<Arc<TransferStore>, (String, String)> {
    app_handle
        .try_state::<Arc<TransferStore>>()
        .map(|state| (*state).clone())
        .ok_or_else(|| {
            (
                "unavailable".to_string(),
                "transfer store is not initialized".to_string(),
            )
        })
}

/// Deserialize a required object/array field of an intent payload into `T`.
fn parse_field<T: serde::de::DeserializeOwned>(
    intent: &Intent,
    key: &str,
) -> Result<T, (String, String)> {
    let value = intent
        .payload
        .get(key)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))?;
    serde_json::from_value(value.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid '{key}': {e}")))
}

/// Parse a `transfer.replace` payload into the whole-slice snapshot the render
/// mirror carries: `{ queue: { <id>: TransferEntry }, minimized: bool }`. A
/// missing `queue` is an empty map (so a mirror that clears the queue is
/// expressible) and a missing `minimized` defaults to `false`; a
/// present-but-malformed field is a `bad_payload` rejection that advances nothing.
fn parse_replace(
    intent: &Intent,
) -> Result<(HashMap<String, TransferEntry>, bool), (String, String)> {
    let queue = match intent.payload.get("queue") {
        None | Some(Value::Null) => HashMap::new(),
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|e| ("bad_payload".to_string(), format!("invalid 'queue': {e}")))?,
    };
    let minimized = intent
        .payload
        .get("minimized")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok((queue, minimized))
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

/// Extract a required bool field from an intent payload.
fn required_bool(intent: &Intent, key: &str) -> Result<bool, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
