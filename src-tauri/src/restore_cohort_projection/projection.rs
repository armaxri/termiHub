//! Restore-cohort projection: the client-scoped `restore-cohort@<clientId>`
//! region and the `restore.*` intents (#2206, part of #2152 / #2139).
//!
//! Exposes the authoritative [`RestoreCohortStore`] to each attached client as
//! its own versioned, multi-subscriber projection region and turns the cohort
//! transitions the frontend currently drives into [`Intent`]s — mirroring the
//! client-scoped `layout` pilot ([`crate::layout::projection`]) and the SSH-tunnels
//! reference registration pattern for the substrate ([`crate::projection`]).
//!
//! # The `restore-cohort@<clientId>` region
//!
//! **Client-scoped** (Open Design Decision #4 / #6: a restore cohort is an
//! orchestration overlay + aggregate feedback owned by the launching client, not
//! shared infrastructure — like `layout`). Each client gets its own region,
//! seeded lazily and mutated via `intent.client_id`. The view model:
//!
//! ```json
//! {
//!   "cohort": { "pending": [tabId], "total": N, "failed": N,
//!               "failedTabIds": [tabId], "toastId": "…"? } | null,
//!   "failedTabIds": [tabId],
//!   "settlement": { "seq": N, "total": N, "restored": N, "failed": N,
//!                   "retryTabIds": [tabId], "toastId": "…"? } | null
//! }
//! ```
//!
//! # Intents
//!
//! | kind                    | payload                                             | effect                                            |
//! | ----------------------- | --------------------------------------------------- | ------------------------------------------------- |
//! | `restore.beginCohort`   | `{ pendingTabIds: [id], preFailedCount, toastId? }` | register a restore/launch cohort                  |
//! | `restore.settleTab`     | `{ tabId, outcome: "connected" \| "failed" }`       | settle one tab; raise the summary when last lands |
//!
//! The bulk "Reconnect failed tabs" retry (#1227) needs no dedicated intent: it
//! is frontend orchestration that reads the projected `failedTabIds`, intersects
//! them with its live terminal tabs, and dispatches a fresh `restore.beginCohort`
//! (which supersedes the prior retry set) before re-driving each reconnect.
//!
//! # Shadow mode
//!
//! Registered and fully served, but **not** driving the live UI: no frontend
//! subscribes to `restore-cohort@<clientId>` or dispatches `restore.*` yet, so
//! these intents mutate only the shadow store and project to regions nobody
//! renders. The `appStore` cohort reducers and the toast feedback remain
//! authoritative. Per the substrate contract the result of an intent is never
//! returned inline — it always arrives as a projection diff on the client's
//! region.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};
use crate::restore_cohort_projection::store::{RestoreCohortStore, TabOutcome};

/// The projection region id for a client's restore cohort
/// (`restore-cohort@<clientId>`).
pub fn restore_cohort_region(client_id: &str) -> String {
    format!("restore-cohort@{client_id}")
}

/// Publish a client's `restore-cohort` region from the store, fanning a diff out
/// to every subscriber and returning the advanced region for the intent ack
/// (empty when the view did not change).
pub fn publish_restore_cohort(
    projector: &Projector,
    store: &RestoreCohortStore,
    client_id: &str,
) -> Vec<ProducedRegion> {
    let region = restore_cohort_region(client_id);
    match projector.publish(&region, store.snapshot(client_id)) {
        Some(version) => vec![ProducedRegion { region, version }],
        None => Vec::new(),
    }
}

/// Register the `restore.*` intents on a handler registry.
///
/// Each route resolves the managed [`RestoreCohortStore`] lazily (so it rejects
/// gracefully rather than panicking if the store is somehow absent), mutates the
/// dispatching client's cohort via [`intent.client_id`](Intent::client_id), and
/// publishes that client's region. All transitions are pure/fast map edits, so
/// they run inline on the dispatcher's single writer.
pub fn register_restore_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("restore.beginCohort", move |intent, projector| {
        let store = store_of(&handle)?;
        let pending = required_str_array(intent, "pendingTabIds")?;
        let pre_failed = optional_usize(intent, "preFailedCount");
        let toast_id = optional_str(intent, "toastId");
        store.begin_cohort(&intent.client_id, &pending, pre_failed, toast_id);
        Ok(publish_restore_cohort(projector, &store, &intent.client_id))
    });

    let handle = app_handle;
    registry.route("restore.settleTab", move |intent, projector| {
        let store = store_of(&handle)?;
        let tab_id = required_str(intent, "tabId")?;
        let outcome = required_outcome(intent)?;
        store.settle_tab(&intent.client_id, &tab_id, outcome);
        Ok(publish_restore_cohort(projector, &store, &intent.client_id))
    });
}

/// Resolve the managed restore-cohort store, or a rejectable error if absent.
fn store_of(app_handle: &AppHandle) -> Result<Arc<RestoreCohortStore>, (String, String)> {
    app_handle
        .try_state::<Arc<RestoreCohortStore>>()
        .map(|state| (*state).clone())
        .ok_or_else(|| {
            (
                "unavailable".to_string(),
                "restore-cohort store is not initialized".to_string(),
            )
        })
}

/// Parse the `outcome` field into a [`TabOutcome`].
fn required_outcome(intent: &Intent) -> Result<TabOutcome, (String, String)> {
    match intent.payload.get("outcome").and_then(Value::as_str) {
        Some("connected") => Ok(TabOutcome::Connected),
        Some("failed") => Ok(TabOutcome::Failed),
        _ => Err((
            "bad_payload".to_string(),
            "missing or invalid 'outcome' (expected \"connected\" | \"failed\")".to_string(),
        )),
    }
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

/// Extract a required array-of-strings field (e.g. `pendingTabIds`).
fn required_str_array(intent: &Intent, key: &str) -> Result<Vec<String>, (String, String)> {
    let arr = intent
        .payload
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))?;
    arr.iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or_else(|| ("bad_payload".to_string(), format!("invalid '{key}' entry")))
        })
        .collect()
}

/// Extract an optional non-negative integer field, defaulting to `0` when absent.
fn optional_usize(intent: &Intent, key: &str) -> usize {
    intent
        .payload
        .get(key)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(0)
}

/// Extract an optional string field (e.g. a toast id); absent → `None`.
fn optional_str(intent: &Intent, key: &str) -> Option<String> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
