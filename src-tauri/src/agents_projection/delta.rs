//! The incremental (PERF-006) publish core of the `agents` region (#2888).
//!
//! The region view is
//! `{ "agents": [AgentEntry…], "definitions": {…}, "folders": {…}, "sessions": {…} }`
//! — one position-ordered array plus three maps keyed by agent id. The publish is
//! a **hybrid**: the three keyed maps are diffed only at the agent ids a fold
//! touched ([`AgentsStore::drain_delta`]), while the ordered `agents` array, when
//! touched, is carried and diffed **whole**.
//!
//! # Why the hybrid diff is byte-identical to the whole-region diff
//!
//! `json_patch::diff` of two objects runs two passes: first over the *new*
//! object's keys in sorted order (recursing into keys present on both sides,
//! `add` for new keys), then over the *old* object's keys in sorted order
//! (`remove` for keys gone from the new side). `serde_json` maps are
//! `BTreeMap`s (no `preserve_order`), so "sorted" is deterministic, and every
//! op a key yields depends only on that key's own old/new subtrees.
//!
//! - **Top level.** Both the whole-region old and new views always carry all four
//!   keys, so the top level never emits an `add`/`remove` of its own and its ops
//!   are the concatenation, in sorted key order (`agents` < `definitions` <
//!   `folders` < `sessions`), of each key's sub-diff. The reduced sides keep all
//!   three maps and carry `agents` on **both** sides exactly when it was touched,
//!   so an untouched list — equal on both sides — contributes no ops in either
//!   form.
//! - **Keyed maps.** Restricting a map to the touched ids on both sides removes
//!   only keys whose old and new subtrees are equal (an untouched id), which emit
//!   nothing in either pass. The surviving keys are visited in the same sorted
//!   positions, so the ops — paths, values and order — are exactly the whole-map
//!   ops. An id absent on one side is absent on the same side of the reduced pair,
//!   so its `add`/`remove` is preserved.
//! - **The `agents` array.** `json_patch` diffs arrays index by index (an insert,
//!   remove or reorder shifts every later index), so no per-entry reduction of the
//!   array is sound. It is never reduced: when touched, the whole old and new lists
//!   are diffed — the same array sub-diff the whole-region path computes.
//!
//! Correctness therefore reduces to complete dirty tracking (every fold that
//! changes the list sets `dirty_agents`; every fold that changes a map entry marks
//! its agent id), which the debug cross-check below verifies on every publish.
//!
//! # The cross-check
//!
//! When `truth` is given (debug builds: the whole-region snapshot taken under the
//! same store lock as the drain), the incremental ops must equal the whole-region
//! diff and the spliced view must equal `truth`. A mismatch is a dirty-tracking
//! bug: it is reported and the publish **resyncs** to the whole-region diff, so
//! subscribers stay correct and no frame is dropped.
//!
//! [`AgentsStore::drain_delta`]: crate::agents_projection::store::AgentsStore::drain_delta

use serde_json::{Map, Value};

use crate::agents_projection::store::AgentsDelta;
use crate::projection::{
    compute_ops, perf006_divergence, pick_keys, splice_subtrees, subtree_map, DiffOp,
};

/// The three keyed maps of the region view, in the order they are handled.
const MAP_FIELDS: [&str; 3] = ["definitions", "folders", "sessions"];

/// The drained entries of one keyed map.
fn map_entries<'a>(delta: &'a AgentsDelta, field: &str) -> &'a [(String, Option<Value>)] {
    match field {
        "definitions" => &delta.definitions,
        "folders" => &delta.folders,
        _ => &delta.sessions,
    }
}

/// Whether `view` has the seeded region shape the reduced diff relies on: all
/// four top-level keys, the list an array, the three maps objects.
fn is_seeded(view: &Value) -> bool {
    view.get("agents").is_some_and(Value::is_array)
        && MAP_FIELDS
            .iter()
            .all(|field| view.get(*field).is_some_and(Value::is_object))
}

/// Compute the RFC-6902 ops for a drained [`AgentsDelta`] and splice it into the
/// held region `view` in place. Returns the ops to fan out and, if the
/// cross-check failed, why. `snapshot` is only called for the unseeded-view
/// fallback when no `truth` is at hand.
pub(crate) fn apply_agents_delta(
    view: &mut Value,
    delta: &AgentsDelta,
    truth: Option<&Value>,
    snapshot: impl FnOnce() -> Value,
) -> (Vec<DiffOp>, Option<String>) {
    // Fallback: an unseeded / unexpected view shape (the region was never seeded
    // with a store snapshot) → the original whole-region path, byte-for-byte.
    // Production always seeds the region in `boot::setup()`.
    if !is_seeded(view) {
        let full = truth.cloned().unwrap_or_else(snapshot);
        let ops = compute_ops(view, &full);
        *view = full;
        return (ops, None);
    }

    let old_full = truth.map(|_| view.clone());

    let mut reduced_old = Map::new();
    let mut reduced_new = Map::new();
    if let Some(agents) = &delta.agents {
        reduced_old.insert("agents".into(), view["agents"].clone());
        reduced_new.insert("agents".into(), agents.clone());
    }
    for field in MAP_FIELDS {
        let entries = map_entries(delta, field);
        reduced_old.insert(field.into(), pick_keys(view.get(field), entries));
        reduced_new.insert(field.into(), subtree_map(entries));
    }
    let ops = compute_ops(&Value::Object(reduced_old), &Value::Object(reduced_new));

    if let Some(agents) = &delta.agents {
        view["agents"] = agents.clone();
    }
    for field in MAP_FIELDS {
        splice_subtrees(view, field, map_entries(delta, field));
    }

    if let (Some(truth), Some(old_full)) = (truth, old_full) {
        if let Some(reason) = perf006_divergence(&ops, &old_full, view, truth) {
            *view = truth.clone();
            return (compute_ops(&old_full, truth), Some(reason));
        }
    }

    (ops, None)
}

#[cfg(test)]
#[path = "delta_tests.rs"]
mod tests;
