//! Shared keyed-map helpers for the incremental (`publish_delta`) regions
//! (PERF-006). A region whose view holds a **keyed object map** can diff just
//! the touched keys: `json_patch::diff` visits object keys in sorted order and
//! each key's sub-diff depends only on that key's old/new subtrees, so reducing
//! both sides to the touched keys yields exactly the whole-map ops.
//!
//! A drained entry is `(key, Some(new subtree) | None-if-absent)`.
//!
//! Currently used by the `agents` region (#2888); `session-lifecycle` and
//! `transfers` still carry byte-identical private copies (#3987).

use serde_json::{Map, Value};

/// Collect the touched keys that are present in `src` into a fresh object — the
/// reduced *old* subtree.
pub(crate) fn pick_keys(src: Option<&Value>, entries: &[(String, Option<Value>)]) -> Value {
    let mut out = Map::new();
    if let Some(obj) = src.and_then(Value::as_object) {
        for (key, _) in entries {
            if let Some(value) = obj.get(key) {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

/// Collect the present (`Some`) entries of a drained subtree into a fresh object —
/// the reduced *new* subtree. A `None` value is an absent (removed) entry and is
/// simply omitted, so the diff emits a `remove`.
pub(crate) fn subtree_map(entries: &[(String, Option<Value>)]) -> Value {
    let mut out = Map::new();
    for (key, value) in entries {
        if let Some(value) = value {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

/// Splice the drained subtrees into `view[field]` in place: `Some` upserts the
/// entry, `None` removes it. A no-op if the field is somehow not an object.
pub(crate) fn splice_subtrees(view: &mut Value, field: &str, entries: &[(String, Option<Value>)]) {
    let Some(obj) = view.get_mut(field).and_then(Value::as_object_mut) else {
        return;
    };
    for (key, value) in entries {
        match value {
            Some(value) => {
                obj.insert(key.clone(), value.clone());
            }
            None => {
                obj.remove(key);
            }
        }
    }
}
