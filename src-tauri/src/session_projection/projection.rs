//! Session-lifecycle projection: the shared `session-lifecycle` region and the
//! `session.*` intents (#2152, part of #2139).
//!
//! Exposes the authoritative [`SessionLifecycleStore`] as one versioned,
//! multi-subscriber projection region and turns the lifecycle transitions the
//! frontend currently drives into [`Intent`]s — mirroring the SSH-tunnels pilot
//! ([`crate::tunnel::projection`]), the reference registration pattern for the
//! substrate ([`crate::projection`]).
//!
//! # The `session-lifecycle` region
//!
//! **Shared** (Open Design Decision #4: infrastructure domains are shared). The
//! real sessions live backend-side; their connection/lifecycle status is a
//! property of the session, not of a viewing client, so two clients see the same
//! status and a transition projects to both. The view model:
//!
//! ```json
//! { "sessions": { "<sessionId>": SessionLifecycle, ... } }
//! ```
//!
//! # Intents
//!
//! | kind                        | payload                     | effect                                        |
//! | --------------------------- | --------------------------- | --------------------------------------------- |
//! | `session.connect`           | `{ sessionId }`             | begin an initial connect (→ connecting)        |
//! | `session.connected`         | `{ sessionId }`             | a connect/reconnect attempt succeeded (→ live) |
//! | `session.connectFailed`     | `{ sessionId, error? }`     | initial connect errored (→ failed)             |
//! | `session.disconnect`        | `{ sessionId }`             | user-initiated graceful disconnect             |
//! | `session.dropped`           | `{ sessionId, error? }`     | unexpected link drop (→ disconnected)          |
//! | `session.reconnect`         | `{ sessionId }`             | begin/restart the auto-reconnect loop          |
//! | `session.reconnectAttempt`  | `{ sessionId }`             | backoff timer fired; start an attempt          |
//! | `session.reconnectFailed`   | `{ sessionId, error? }`     | the attempt failed (back off or give up)       |
//! | `session.cancelReconnect`   | `{ sessionId }`             | user stopped the retry loop                    |
//! | `session.remove`            | `{ sessionId }`             | session/tab gone; drop it from the region      |
//!
//! # Shadow mode
//!
//! Registered and fully served, but **not** driving the live UI: no frontend
//! subscribes to `session-lifecycle` or dispatches `session.*` yet, so these
//! intents mutate only the shadow store and project to a region nobody renders.
//! The `appStore` lifecycle reducers and terminal overlays remain authoritative.
//! Per the substrate contract the result of an intent is never returned inline —
//! it always arrives as a projection diff on the `session-lifecycle` region.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};
use crate::session_projection::store::SessionLifecycleStore;

/// The projection region id for the session-lifecycle domain (shared, per Open
/// Design Decision #4).
pub const SESSION_LIFECYCLE_REGION: &str = "session-lifecycle";

/// Publish the `session-lifecycle` region from the store, fanning a diff out to
/// every subscriber and returning the advanced region for the intent ack (empty
/// when the view did not change).
pub fn publish_sessions(
    projector: &Projector,
    store: &SessionLifecycleStore,
) -> Vec<ProducedRegion> {
    match projector.publish(SESSION_LIFECYCLE_REGION, store.snapshot()) {
        Some(version) => vec![ProducedRegion {
            region: SESSION_LIFECYCLE_REGION.to_string(),
            version,
        }],
        None => Vec::new(),
    }
}

/// Register the `session.*` intents on a handler registry.
///
/// Each route resolves the managed [`SessionLifecycleStore`] lazily (so it
/// rejects gracefully rather than panicking if the store is somehow absent),
/// applies the transition, and publishes the shared region. All transitions are
/// pure/fast map edits, so they run inline on the dispatcher's single writer.
pub fn register_session_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("session.connect", move |intent, projector| {
        let store = store_of(&handle)?;
        store.connect(&required_str(intent, "sessionId")?);
        Ok(publish_sessions(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("session.connected", move |intent, projector| {
        let store = store_of(&handle)?;
        store.connected(&required_str(intent, "sessionId")?);
        Ok(publish_sessions(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("session.connectFailed", move |intent, projector| {
        let store = store_of(&handle)?;
        store.connect_failed(
            &required_str(intent, "sessionId")?,
            optional_str(intent, "error"),
        );
        Ok(publish_sessions(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("session.disconnect", move |intent, projector| {
        let store = store_of(&handle)?;
        store.disconnect(&required_str(intent, "sessionId")?);
        Ok(publish_sessions(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("session.dropped", move |intent, projector| {
        let store = store_of(&handle)?;
        store.dropped(
            &required_str(intent, "sessionId")?,
            optional_str(intent, "error"),
        );
        Ok(publish_sessions(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("session.reconnect", move |intent, projector| {
        let store = store_of(&handle)?;
        store.reconnect(&required_str(intent, "sessionId")?);
        Ok(publish_sessions(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("session.reconnectAttempt", move |intent, projector| {
        let store = store_of(&handle)?;
        store.reconnect_attempt(&required_str(intent, "sessionId")?);
        Ok(publish_sessions(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("session.reconnectFailed", move |intent, projector| {
        let store = store_of(&handle)?;
        store.reconnect_failed(
            &required_str(intent, "sessionId")?,
            optional_str(intent, "error"),
        );
        Ok(publish_sessions(projector, &store))
    });

    let handle = app_handle.clone();
    registry.route("session.cancelReconnect", move |intent, projector| {
        let store = store_of(&handle)?;
        store.cancel_reconnect(&required_str(intent, "sessionId")?);
        Ok(publish_sessions(projector, &store))
    });

    let handle = app_handle;
    registry.route("session.remove", move |intent, projector| {
        let store = store_of(&handle)?;
        store.remove(&required_str(intent, "sessionId")?);
        Ok(publish_sessions(projector, &store))
    });
}

/// Resolve the managed session-lifecycle store, or a rejectable error if absent.
fn store_of(app_handle: &AppHandle) -> Result<Arc<SessionLifecycleStore>, (String, String)> {
    app_handle
        .try_state::<Arc<SessionLifecycleStore>>()
        .map(|state| (*state).clone())
        .ok_or_else(|| {
            (
                "unavailable".to_string(),
                "session-lifecycle store is not initialized".to_string(),
            )
        })
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

/// Extract an optional string field (e.g. an error message); absent → `None`.
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
