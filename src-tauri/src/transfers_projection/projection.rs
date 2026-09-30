//! Transfer-queue projection: the shared `transfers` region and the
//! `transfer.*` intents (#2229, Phase 5 of #2139 / #2153).
//!
//! Exposes the authoritative [`TransferStore`] as one versioned, multi-subscriber
//! projection region and turns the transfer-queue transitions the frontend
//! currently drives into [`Intent`]s — mirroring the SSH-tunnels pilot
//! ([`crate::tunnel::projection`]) and the system-monitor region
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
//! `transfer.replace` is the whole-slice seed that keeps the shared region a
//! faithful copy of the transfer-queue slice — the analog of the system-monitor
//! bridge's `monitor.replace`. The granular `seed` / `progress` / `reconcile` /
//! `remove` / `clearCompleted` / `setMinimized` transitions drive the store,
//! which is authoritative (the former `appStore` transfer reducers were removed,
//! #2229 / #2283).
//!
//! # Authoritative (#2229)
//!
//! Registered, fully served, and driving the live UI: the frontend subscribes to
//! and dispatches these intents (the former `appStore` transfer reducers were
//! removed, #2283). Per the substrate contract the result of an intent is never
//! returned inline — it always arrives as a projection diff on the `transfers`
//! region.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::commands::projection::ProjectionState;
use crate::projection::{
    compute_ops, perf006_divergence, pick_keys, report_perf006_divergence, required_bool,
    required_str, splice_subtrees, subtree_map, DiffOp, HandlerRegistry, Intent, ProducedRegion,
    Projector,
};
use crate::transfers_projection::store::{
    RegionDelta, TransferEntry, TransferProgress, TransferSeed, TransferSnapshot, TransferStore,
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
///
/// # Incremental publish (PERF-006, rollout of #2878)
///
/// The region view is `{ "queue": { <id>: TransferEntry }, "minimized": bool }`.
/// The naive path re-serialized **all** rows and diffed the whole tree on every
/// fold — O(region) per fold, hence O(N²) over a per-row progress stream. Instead
/// the store hands us only the rows it touched ([`TransferStore::drain_delta`]);
/// we diff just those (plus the O(1) `minimized` scalar) against the held view
/// and splice them in place, bounding the cost to O(size of the change).
///
/// The emitted diff is **byte-identical** to the whole-region diff — see
/// [`apply_transfer_delta`] for why — so no subscriber can tell the two apart.
///
/// # Ordering under concurrent folds (#3788, the #3780 pattern)
///
/// Folds and publishes run on several threads at once: the intent dispatcher
/// (`transfer.*` routes), and every running transfer's progress sink
/// ([`fold_transfer_progress`], from the SFTP copy loops / FTP executor and the
/// relaunch path), one per concurrent transfer.
/// The delta is therefore drained **inside** the region lock, in the same
/// critical section as the splice and the fan-out. Draining it before taking the
/// region lock let a racing fold-and-publish splice a *newer* value first, after
/// which this publish spliced its older, already-drained value over it — leaving
/// every subscriber stale with nothing left dirty to heal it. Under the region
/// lock, drains are applied in the order they are taken, so the region always
/// equals the store as of the latest drain; a fold landing after our drain stays
/// dirty and is carried by the next publish (its own folder always publishes
/// after it).
pub fn publish_transfers(projector: &Projector, store: &TransferStore) -> Vec<ProducedRegion> {
    let mut divergence = None;
    let published = projector.publish_delta(TRANSFERS_REGION, |view| {
        // Debug builds also take the whole-region snapshot atomically with the
        // drain, as the ground truth for the PERF-006 cross-check.
        let (delta, truth) = if cfg!(debug_assertions) {
            let (delta, truth) = store.drain_delta_with_snapshot();
            (delta, Some(truth))
        } else {
            (store.drain_delta(), None)
        };
        #[cfg(test)]
        crate::projection::publish_hook::fire_after_drain();
        let (ops, diverged) =
            apply_transfer_delta(view, &delta, truth.as_ref(), || store.snapshot());
        divergence = diverged;
        ops
    });
    // Reported only after `publish_delta` returned: the (resynced) frame has
    // already been fanned out and the region lock released.
    if let Some(reason) = divergence {
        report_perf006_divergence(TRANSFERS_REGION, &reason);
    }
    match published {
        Some(version) => vec![ProducedRegion {
            region: TRANSFERS_REGION.to_string(),
            version,
        }],
        None => Vec::new(),
    }
}

/// Compute the RFC-6902 ops for a drained [`RegionDelta`] and splice its new
/// subtrees into the held region `view` in place — the incremental core of
/// [`publish_transfers`] (PERF-006, rollout of #2878). Returns the ops to fan
/// out and, if the cross-check failed, why.
///
/// ## Why the reduced diff is byte-identical to the whole-region diff
///
/// `json_patch::diff` has two properties this relies on: (1) object keys are
/// visited in **sorted** order (`serde_json` maps are `BTreeMap`s — no
/// `preserve_order`), and (2) each key's sub-diff depends **only** on that key's
/// old/new subtrees. So restricting the `queue` map's diff to just the touched
/// keys yields exactly the same ops — same paths, same values, same order — the
/// whole-region diff would: the untouched keys produce no ops and, visited in the
/// same sorted positions, never reorder the touched ones. The scalar `minimized`
/// is always carried on both reduced sides at its true old/new value, so its own
/// op (a `replace /minimized`, if it changed) matches the whole-region diff both
/// in presence and in sorted position (`"minimized"` sorts before `"queue"`), and
/// no spurious top-level op appears.
///
/// ## The cross-check
///
/// When `truth` is given (debug builds: the whole-region snapshot taken under
/// the same store lock as the drain, so it is exactly the state this delta
/// brings the region to), the incremental result is cross-checked against it:
/// the ops must equal the whole-region diff and the spliced view must equal
/// `truth`. Any mismatch is a dirty-tracking / ordering bug. It is reported, and
/// the publish **resyncs** — the view is replaced by `truth` and the emitted ops
/// become the whole-region diff — so subscribers stay correct and no frame is
/// dropped. `snapshot` is only called for the unseeded-view fallback when no
/// `truth` is at hand.
fn apply_transfer_delta(
    view: &mut Value,
    delta: &RegionDelta,
    truth: Option<&Value>,
    snapshot: impl FnOnce() -> Value,
) -> (Vec<DiffOp>, Option<String>) {
    // Fallback: an unseeded / unexpected view shape (e.g. the region was never
    // seeded with the empty-store baseline) → the original whole-region path,
    // byte-for-byte. Production always seeds the region in `lib.rs::setup()`.
    if !view.get("queue").is_some_and(Value::is_object) || view.get("minimized").is_none() {
        let full = truth.cloned().unwrap_or_else(snapshot);
        let ops = compute_ops(view, &full);
        *view = full;
        return (ops, None);
    }

    let old_full = truth.map(|_| view.clone());

    let old_minimized = view.get("minimized").cloned().unwrap_or(Value::Bool(false));
    let reduced_old = json!({
        "queue": pick_keys(view.get("queue"), &delta.queue),
        "minimized": old_minimized,
    });
    let reduced_new = json!({
        "queue": subtree_map(&delta.queue),
        "minimized": delta.minimized,
    });
    let ops = compute_ops(&reduced_old, &reduced_new);

    splice_subtrees(view, "queue", &delta.queue);
    if let Some(obj) = view.as_object_mut() {
        obj.insert("minimized".to_string(), Value::Bool(delta.minimized));
    }

    if let (Some(truth), Some(old_full)) = (truth, old_full) {
        if let Some(reason) = perf006_divergence(&ops, &old_full, view, truth) {
            *view = truth.clone();
            return (compute_ops(&old_full, truth), Some(reason));
        }
    }

    (ops, None)
}

/// Fold a backend-produced `transfer-progress` event into the managed
/// [`TransferStore`] **server-side** and fan the resulting `transfers` region
/// diff out to every subscriber (#2387, prerequisite for #2229).
///
/// This is the server-authority counterpart to the `transfer.progress` intent
/// [`register_transfer_intents`] registers: the same store transition the
/// frontend currently mirrors via `transfer.*` intents is applied here **at the
/// source** — the instant the transfer engine (the SFTP copy loop / the FTP
/// scheduler executor) produces a lifecycle transition or progress sample and
/// hands it to [`crate::files::transfer::app_progress_sink`]. Every backend
/// `transfer-progress` event carries the rich `state` field
/// (`queued`/`active`/`paused`/`completed`/`failed`/`cancelled`), so folding the
/// event stream reflects the full register → queue → progress → pause → resume →
/// finish → cancel lifecycle into the store without any client round-trip.
///
/// `progress` is the engine's wire event; it is converted into the store's
/// [`TransferProgress`] by the direct `From` conversion (#2973), which yields
/// exactly what the client `transfer.progress` route's `serde_json::from_value`
/// parses from the same camelCase payload — so the server fold reproduces the
/// client route's store transition exactly (parity) without a JSON round-trip
/// per progress sample. It is **additive**: the Tauri `transfer-progress` emission
/// stays in place and the render-cut mirror (`transfer.replace`, a later #2229
/// step) keeps the region a faithful copy of `appStore`, so this changes no
/// user-facing behavior.
///
/// Best-effort and non-fatal: if the store or the projection state is not managed
/// (e.g. a headless unit-test app that never ran `setup()`), or the event does
/// not parse, the fold is skipped rather than erroring. The store transition runs
/// to completion synchronously before the publish, so the store lock is never
/// held across an await.
pub fn fold_transfer_progress<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    progress: &crate::files::transfer::TransferProgress,
) {
    let Some(store) = app_handle.try_state::<Arc<TransferStore>>() else {
        return;
    };
    store.progress(&TransferProgress::from(progress), now_ms());
    if let Some(projection) = app_handle.try_state::<ProjectionState>() {
        publish_transfers(&projection.projector, store.inner().as_ref());
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
        // Durable queue (PROD-0011): a removed row must not resurrect on the next
        // launch, so prune it from the persisted queue too. Best-effort; a live
        // transfer's own terminal transition already prunes it at the source.
        if let Some(pm) = handle.try_state::<crate::files::transfer::TransferPersistenceManager>() {
            pm.remove(&id);
        }
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

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "projection_race_tests.rs"]
mod race_tests;
