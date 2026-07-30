//! Test-bridge-only diagnostic region for the projection-assertion harness (#2164).
//!
//! Phase 1 (#2149) wired the projection substrate with an **empty** handler
//! registry — mechanism only, no domain migrated — so there is no live region an
//! end-to-end harness can drive. Until the first real domain migrates onto the
//! substrate (Phase 2, #2150), this module provides a small, self-contained
//! diagnostic region plus `diag.*` intent routes so the Python bridge harness
//! (`tests/system`) can exercise the full loop against the *running app*:
//! subscribe → snapshot, dispatch(intent) → diff, forced gap → resync.
//!
//! It is a **test-only hook**: the app's `setup` registers these routes and the
//! diagnostic region only when the test bridge is enabled
//! (`TERMIHUB_TEST_BRIDGE_PORT` set — see
//! [`crate::utils::test_bridge::is_test_bridge_enabled`]), beside the real
//! tunnel pilot. Production launches register nothing here, so the diagnostic
//! region never exists outside the harness. It touches no substrate production
//! module; it only *uses* the public [`HandlerRegistry`] / `Projector` API,
//! exactly as a migrated domain does.

use serde_json::{json, Value};

use crate::projection::{HandlerRegistry, ProducedRegion};

/// The region id the harness subscribes to and drives.
pub const DIAG_REGION: &str = "diag.counter";

/// The diagnostic region's initial view model, seeded at version 0.
///
/// A `count` an intent bumps (`replace /count`) and an `items` list an intent
/// appends to (`add /items/-`) — two distinct diff shapes for the harness to
/// assert.
pub fn initial_view() -> Value {
    json!({ "count": 0, "items": [] })
}

/// Register the `diag.*` intent routes onto `registry`.
///
/// Each mutating route reads the region's current authoritative view, applies a
/// tiny change, and republishes — letting the [`Projector`] compute the diff and
/// bump the version. The [`crate::projection::Dispatcher`] serialises intents on
/// a single writer, so the read-modify-publish step never interleaves.
///
/// Routes:
/// - `diag.increment` `{ by?: i64 }` → `count += by` (default `1`); one
///   `replace /count` op.
/// - `diag.append` `{ item: <any> }` → push `item` to `items`; one `add /items/-`
///   op. Rejects (`bad_payload`) when `item` is absent.
/// - `diag.reset` → republish the initial baseline (clears back to `count: 0`).
/// - `diag.noop` → republish the unchanged view; the projector coalesces it to
///   no diff and no version bump (an accepted ack with an empty `produced`).
/// - `diag.fail` `{ code?, message? }` → always reject, so the harness can assert
///   the rejected-ack path end to end.
pub fn register_diagnostic_routes(registry: &mut HandlerRegistry) {
    registry.route("diag.increment", |intent, projector| {
        let by = intent
            .payload
            .get("by")
            .and_then(Value::as_i64)
            .unwrap_or(1);
        let mut view = projector.snapshot(DIAG_REGION).view;
        let current = view.get("count").and_then(Value::as_i64).unwrap_or(0);
        view["count"] = json!(current + by);
        Ok(produced(projector.publish(DIAG_REGION, view)))
    });

    registry.route("diag.append", |intent, projector| {
        let item = intent.payload.get("item").cloned().ok_or_else(|| {
            (
                "bad_payload".to_string(),
                "diag.append requires an 'item' field".to_string(),
            )
        })?;
        let mut view = projector.snapshot(DIAG_REGION).view;
        match view.get_mut("items").and_then(Value::as_array_mut) {
            Some(items) => items.push(item),
            None => view["items"] = json!([item]),
        }
        Ok(produced(projector.publish(DIAG_REGION, view)))
    });

    registry.route("diag.reset", |_intent, projector| {
        Ok(produced(projector.publish(DIAG_REGION, initial_view())))
    });

    registry.route("diag.noop", |_intent, projector| {
        // Republish the current view unchanged: the projector diffs it against the
        // last emitted view, finds nothing, and returns `None` — an accepted ack
        // whose `produced` is empty and no frame fanned out.
        let view = projector.snapshot(DIAG_REGION).view;
        Ok(produced(projector.publish(DIAG_REGION, view)))
    });

    registry.route("diag.fail", |intent, _projector| {
        let code = intent
            .payload
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("diag_failed");
        let message = intent
            .payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("diagnostic intent rejected on request");
        Err((code.to_string(), message.to_string()))
    });
}

/// Map an optional new version to the ack's `produced` list for [`DIAG_REGION`].
fn produced(version: Option<u64>) -> Vec<ProducedRegion> {
    match version {
        Some(version) => vec![ProducedRegion {
            region: DIAG_REGION.to_string(),
            version,
        }],
        None => vec![],
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::projection::{Dispatcher, IntentStatus, Projector};

    /// Build a projector seeded with the diagnostic region and a dispatcher whose
    /// registry carries the `diag.*` routes — the exact wiring
    /// `ProjectionState::with_diagnostics` installs in test-bridge mode.
    fn diag_dispatcher() -> (Arc<Projector>, Dispatcher) {
        let projector = Arc::new(Projector::new());
        projector.register_region(DIAG_REGION, initial_view());
        let mut registry = HandlerRegistry::new();
        register_diagnostic_routes(&mut registry);
        let dispatcher = Dispatcher::new(projector.clone(), Arc::new(registry));
        (projector, dispatcher)
    }

    fn intent(kind: &str, payload: Value) -> crate::projection::Intent {
        crate::projection::Intent {
            intent_id: format!("test-{kind}"),
            kind: kind.to_string(),
            payload,
            client_id: "harness".to_string(),
        }
    }

    #[test]
    fn increment_bumps_count_and_advances_version() {
        let (projector, dispatcher) = diag_dispatcher();
        let ack = dispatcher.dispatch(intent("diag.increment", json!({ "by": 3 })));
        assert_eq!(ack.status, IntentStatus::Accepted);
        assert_eq!(
            ack.produced,
            Some(vec![ProducedRegion {
                region: DIAG_REGION.to_string(),
                version: 1,
            }])
        );
        assert_eq!(projector.snapshot(DIAG_REGION).view["count"], json!(3));

        // Default step is 1.
        dispatcher.dispatch(intent("diag.increment", json!({})));
        assert_eq!(projector.region_version(DIAG_REGION), Some(2));
        assert_eq!(projector.snapshot(DIAG_REGION).view["count"], json!(4));
    }

    #[test]
    fn append_pushes_an_item_and_rejects_missing_payload() {
        let (projector, dispatcher) = diag_dispatcher();
        let ack = dispatcher.dispatch(intent("diag.append", json!({ "item": "a" })));
        assert_eq!(ack.status, IntentStatus::Accepted);
        assert_eq!(projector.snapshot(DIAG_REGION).view["items"], json!(["a"]));

        let rejected = dispatcher.dispatch(intent("diag.append", json!({})));
        assert_eq!(rejected.status, IntentStatus::Rejected);
        assert_eq!(rejected.error.unwrap().code, "bad_payload");
        // A rejected intent advances nothing.
        assert_eq!(projector.region_version(DIAG_REGION), Some(1));
    }

    #[test]
    fn reset_returns_to_the_baseline() {
        let (projector, dispatcher) = diag_dispatcher();
        dispatcher.dispatch(intent("diag.increment", json!({ "by": 5 })));
        dispatcher.dispatch(intent("diag.append", json!({ "item": "x" })));
        dispatcher.dispatch(intent("diag.reset", json!({})));
        assert_eq!(projector.snapshot(DIAG_REGION).view, initial_view());
    }

    #[test]
    fn noop_is_accepted_but_produces_no_diff() {
        let (projector, dispatcher) = diag_dispatcher();
        dispatcher.dispatch(intent("diag.increment", json!({ "by": 1 })));
        let before = projector.region_version(DIAG_REGION);
        let ack = dispatcher.dispatch(intent("diag.noop", json!({})));
        assert_eq!(ack.status, IntentStatus::Accepted);
        assert_eq!(ack.produced, Some(vec![]));
        assert_eq!(projector.region_version(DIAG_REGION), before);
    }

    #[test]
    fn fail_rejects_with_the_requested_code() {
        let (_projector, dispatcher) = diag_dispatcher();
        let ack = dispatcher.dispatch(intent(
            "diag.fail",
            json!({ "code": "boom", "message": "on purpose" }),
        ));
        assert_eq!(ack.status, IntentStatus::Rejected);
        let error = ack.error.unwrap();
        assert_eq!(error.code, "boom");
        assert_eq!(error.message, "on purpose");
    }
}
