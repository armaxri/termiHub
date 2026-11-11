//! The one client-side projection cache shared by the projection suites
//! (#5373).
//!
//! [`ClientCache`] mirrors the TypeScript `ProjectionClient`: it holds
//! `{ version, view }`, applies ordered diffs, detects gaps and re-baselines
//! from a snapshot. Every `*_projection` suite asserts what a client would see
//! through it, so a change to the client contract is made here once.

use serde_json::Value;

use crate::projection::{apply_ops, DiffFrame, SnapshotFrame};

/// A simulated client-side cache of one projected region.
pub(crate) struct ClientCache {
    pub(crate) version: u64,
    pub(crate) view: Value,
}

/// A detected version gap: the incoming diff did not fit the cache.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Gap;

impl ClientCache {
    pub(crate) fn from_snapshot(s: &SnapshotFrame) -> Self {
        Self {
            version: s.version,
            view: s.view.clone(),
        }
    }

    /// Apply a diff that must fit the cache (`base_version == version`);
    /// panics on a gap, for suites that never expect one.
    pub(crate) fn apply(&mut self, diff: &DiffFrame) {
        assert_eq!(diff.base_version, self.version, "diff must fit the cache");
        apply_ops(&mut self.view, &diff.ops).expect("diff applies cleanly");
        self.version = diff.version;
    }

    /// Apply a diff iff it fits (`base_version == version`); otherwise report a
    /// gap without mutating the cache.
    pub(crate) fn try_apply(&mut self, diff: &DiffFrame) -> Result<(), Gap> {
        if diff.base_version != self.version {
            return Err(Gap);
        }
        self.apply(diff);
        Ok(())
    }

    /// Re-baseline from a fresh snapshot, as the client does after a gap.
    pub(crate) fn rebaseline(&mut self, s: &SnapshotFrame) {
        self.version = s.version;
        self.view = s.view.clone();
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::projection::compute_ops;

    fn snapshot(version: u64, view: Value) -> SnapshotFrame {
        serde_json::from_value(json!({
            "kind": "snapshot",
            "region": "r",
            "version": version,
            "view": view,
        }))
        .expect("snapshot frame parses")
    }

    fn diff(base_version: u64, version: u64, old: &Value, new: &Value) -> DiffFrame {
        serde_json::from_value(json!({
            "kind": "diff",
            "region": "r",
            "baseVersion": base_version,
            "version": version,
            "ops": compute_ops(old, new),
        }))
        .expect("diff frame parses")
    }

    #[test]
    fn an_ordered_diff_applies_and_advances_the_version() {
        let (old, new) = (json!({ "a": 1 }), json!({ "a": 2 }));
        let mut cache = ClientCache::from_snapshot(&snapshot(1, old.clone()));
        cache.try_apply(&diff(1, 2, &old, &new)).unwrap();
        assert_eq!((cache.version, &cache.view), (2, &new));
    }

    #[test]
    fn a_gap_is_reported_without_mutating_and_a_rebaseline_recovers() {
        let (old, new) = (json!({ "a": 1 }), json!({ "a": 3 }));
        let mut cache = ClientCache::from_snapshot(&snapshot(1, old.clone()));
        assert_eq!(cache.try_apply(&diff(2, 3, &old, &new)), Err(Gap));
        assert_eq!((cache.version, &cache.view), (1, &old));
        cache.rebaseline(&snapshot(3, new.clone()));
        assert_eq!((cache.version, &cache.view), (3, &new));
    }

    #[test]
    #[should_panic(expected = "diff must fit the cache")]
    fn apply_panics_on_a_gap() {
        let (old, new) = (json!({}), json!({ "a": 1 }));
        ClientCache::from_snapshot(&snapshot(1, old.clone())).apply(&diff(5, 6, &old, &new));
    }
}
