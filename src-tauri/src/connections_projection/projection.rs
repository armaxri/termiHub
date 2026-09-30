//! Connections-tree projection: the shared `connections` region (#2225, part of
//! #2139 and #2153).
//!
//! Exposes the authoritative [`ConnectionsStore`] as one versioned,
//! multi-subscriber projection region, fed from the persisted
//! [`ConnectionManager`] by [`fold_connections_from_manager`].
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
//! # Single writer — no intents (#2831)
//!
//! The region has exactly one writer: [`fold_connections_from_manager`], run by
//! the persist commands' `commit` choke point after every write, success or
//! failure. There are deliberately **no** `connection.*` intents. The former
//! per-transition intents were a second, uncoupled region write: when the
//! persist behind one failed, the region sat ahead of disk (FES-005). The
//! client now shows optimistic transitions in a local overlay only, dropped
//! once the persist settles and the region has caught up with disk.
//!
//! Ordering is array position, matching the on-disk `children` order.

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::commands::projection::ProjectionState;
use crate::connection::manager::ConnectionManager;
use crate::connections_projection::store::ConnectionsStore;
use crate::projection::{ProducedRegion, Projector};

/// The projection region id for the connections-tree domain (shared, per Open
/// Design Decision #4).
pub const CONNECTIONS_REGION: &str = "connections";

/// Publish the `connections` region from the store, fanning a diff out to every
/// subscriber and returning the advanced region (empty when the view did not
/// change).
///
/// # Deliberately whole-snapshot, not incremental (PERF-006, #2888)
///
/// Unlike `transfers`, `session-lifecycle`, `system-monitors` and `agents`, this
/// region stays on the whole-snapshot-then-diff path, by decision:
///
/// - **There is no change set to reduce to.** The region's only writer is
///   [`fold_connections_from_manager`] (#2831 / #3960): the persist command's
///   `commit` choke point refolds the manager's **whole** unified view from disk
///   under the commit lock and [`ConnectionsStore::replace`]s the store with it.
///   The fold never learns *which* rows a save changed (the manager may re-id,
///   dedupe siblings, re-home children), so finding the change means comparing
///   every row — exactly the whole-region diff this path already computes.
/// - **Ordered arrays.** `folders` and `connections` are position-ordered
///   arrays, and `json_patch` diffs arrays index by index, so an insert / remove
///   / move shifts every later index; no per-row reduction is byte-identical.
///   The keyed `savedAs` echo map (#3961) is bounded ([`SAVED_AS_CAPACITY`])
///   and tiny.
/// - **The diff is not the cost.** Each fold already re-reads and parses the
///   connection files from disk (`load_unified_view`), which dominates the
///   in-memory serialize + diff. And the fold runs once per user-driven persist,
///   not on a per-entry stream, so there is no O(N²) burst to bound.
///
/// Incrementalizing would add dirty-tracking risk to the authoritative
/// substrate for no measurable win.
///
/// [`SAVED_AS_CAPACITY`]: crate::connections_projection::store::SAVED_AS_CAPACITY
pub fn publish_connections(projector: &Projector, store: &ConnectionsStore) -> Vec<ProducedRegion> {
    match projector.publish_with(CONNECTIONS_REGION, || store.snapshot()) {
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
/// This is the region's **only** writer (#2831). It runs inside the persist
/// commands' `commit` choke point, so the region reflects the disk **at the
/// source** — the instant a saved-connection / folder mutation
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
/// credentials — so replaying fine-grained ops (`add` / `update` / …) against
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
    let live = crate::tunnel::connection_refs::LiveConnections::from_view(&view);
    store.replace(view.folders, view.connections);
    if let Some(projection) = app_handle.try_state::<ProjectionState>() {
        publish_connections(&projection.projector, &store);
    }
    // Cascade to the tunnels that reference a connection this view no longer
    // holds — a single or bulk delete, or a changed or disabled external
    // connection file (#2850): stop them, and mark them unresolved in the
    // shared `tunnels` region.
    crate::tunnel::connection_refs::reconcile_tunnels_with_connections(app_handle, live);
}

/// Record in the managed [`ConnectionsStore`] that a connection sent as
/// `arrived_as` was saved as `persisted` (#3961), so the next fold publishes
/// the pair in the region's `savedAs` map alongside the saved row. A no-op when
/// the store is not managed.
pub fn record_saved_as<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    arrived_as: &str,
    persisted: &str,
) {
    if let Some(store) = app_handle.try_state::<Arc<ConnectionsStore>>() {
        store.record_saved_as(arrived_as, persisted);
    }
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
