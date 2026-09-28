//! The PERF-006 cross-check shared by the incremental (`publish_delta`) regions
//! — session-lifecycle, transfers and system-monitors (#3780 / #3788).
//!
//! Debug builds take a whole-region snapshot atomically with each drain (one
//! store lock) and compare the incremental result against it. A mismatch is a
//! real dirty-tracking or ordering bug: the publish resyncs to the whole-region
//! diff (so subscribers stay correct and no frame is dropped) and reports it
//! here, after the fan-out — never a panic mid-publish.

use serde_json::Value;

use crate::projection::{compute_ops, DiffOp};

/// The PERF-006 cross-check: `None` when the incremental `ops` equal the
/// whole-region diff `old_full → truth` and the spliced `view` equals `truth`;
/// otherwise a description of the mismatch.
pub(crate) fn perf006_divergence(
    ops: &[DiffOp],
    old_full: &Value,
    view: &Value,
    truth: &Value,
) -> Option<String> {
    let expected = compute_ops(old_full, truth);
    if ops != expected.as_slice() {
        return Some(format!(
            "incremental ops {ops:?} != whole-region ops {expected:?}"
        ));
    }
    if view != truth {
        return Some(format!("spliced view {view} != store snapshot {truth}"));
    }
    None
}

/// Surface a PERF-006 cross-check failure on `region`: a real dirty-tracking or
/// ordering bug in the incremental publish, already healed by a resync. Logged
/// loudly and never a panic mid-publish (#3780: a panic there dropped the frame
/// after the view was spliced, and once aborted the whole debug app). Unit tests
/// still fail hard on it — after the fan-out, so the region stays consistent.
pub(crate) fn report_perf006_divergence(region: &str, reason: &str) {
    tracing::error!(
        region,
        "PERF-006: incremental publish diverged from the store; \
         resynced to the whole-region diff: {reason}"
    );
    #[cfg(test)]
    panic!("PERF-006: incremental {region} publish diverged: {reason}");
}
