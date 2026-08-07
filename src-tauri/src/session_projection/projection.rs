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
//! | `session.reconnectTrigger`  | `{ sessionId, error? }`     | record/clear the reconnect-trigger cause       |
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
use termihub_core::reconnect_backoff::ReconnectPhase;

use crate::commands::projection::ProjectionState;
use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};
use crate::session::manager::SessionManager;
use crate::session_projection::store::SessionLifecycleStore;
use crate::session_projection::timer::ReconnectTimerDriver;

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

/// Fold a session-lifecycle transition into the managed [`SessionLifecycleStore`]
/// **server-side** and fan the resulting `session-lifecycle` region diff out to
/// every subscriber (#2431, prerequisite for #2205).
///
/// This is the server-authority counterpart to [`register_session_intents`]: the
/// same store transitions the frontend currently mirrors via `session.*` intents
/// are applied here **at the source** — the instant a backend lifecycle source
/// (`create_connection`, and later the `terminal-exit` / `close_session` paths)
/// observes a transition — so the store is fed server-side, addressed by the
/// **frontend tab id** the region is keyed by (resolved through the
/// [`SessionManager`](crate::session::manager::SessionManager) identity bridge,
/// #2431). It is **additive**: the frontend `session.*` mirror stays in place, so
/// this changes no user-facing behavior — the coarse status field it writes is not
/// yet rendered from the region (that inversion is #2205). The `apply` closure
/// must therefore only drive transitions that **converge** with the client's
/// same-event dispatch (e.g. the initial connect's `connect` / `connected`), never
/// one the client would resolve differently for the same event.
///
/// Best-effort and non-fatal: if the store or the projection state is not managed
/// (e.g. a headless unit-test app that never ran `setup()`), the fold is skipped
/// rather than erroring — the client mirror still drives the region. The `apply`
/// closure runs to completion synchronously before the publish, so the store lock
/// is never held across an await.
pub fn fold_session_transition<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    apply: impl FnOnce(&SessionLifecycleStore),
) {
    let Some(store) = app_handle.try_state::<Arc<SessionLifecycleStore>>() else {
        return;
    };
    apply(store.inner().as_ref());
    if let Some(projection) = app_handle.try_state::<ProjectionState>() {
        publish_sessions(&projection.projector, store.inner().as_ref());
    }
}

/// Register the `session.*` intents on a handler registry.
///
/// Each route resolves the managed [`SessionLifecycleStore`] lazily (so it
/// rejects gracefully rather than panicking if the store is somehow absent),
/// applies the transition, publishes the shared region, and then reconciles the
/// backend reconnect timer for that session ([`sync_timer`]). All transitions
/// are pure/fast map edits, so they run inline on the dispatcher's single writer.
pub fn register_session_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("session.connect", move |intent, projector| {
        let store = store_of(&handle)?;
        let id = required_str(intent, "sessionId")?;
        store.connect(&id);
        let produced = publish_sessions(projector, &store);
        sync_timer(&handle, &id);
        Ok(produced)
    });

    let handle = app_handle.clone();
    registry.route("session.connected", move |intent, projector| {
        let store = store_of(&handle)?;
        let id = required_str(intent, "sessionId")?;
        store.connected(&id);
        let produced = publish_sessions(projector, &store);
        sync_timer(&handle, &id);
        Ok(produced)
    });

    let handle = app_handle.clone();
    registry.route("session.connectFailed", move |intent, projector| {
        let store = store_of(&handle)?;
        let id = required_str(intent, "sessionId")?;
        store.connect_failed(&id, optional_str(intent, "error"));
        let produced = publish_sessions(projector, &store);
        sync_timer(&handle, &id);
        Ok(produced)
    });

    let handle = app_handle.clone();
    registry.route("session.disconnect", move |intent, projector| {
        let store = store_of(&handle)?;
        let id = required_str(intent, "sessionId")?;
        store.disconnect(&id);
        let produced = publish_sessions(projector, &store);
        sync_timer(&handle, &id);
        // A graceful user disconnect ends the session; scrub its retained request
        // so no resolved secret lingers (#2454 Model A mitigation).
        clear_retained_request(&handle, &id);
        Ok(produced)
    });

    let handle = app_handle.clone();
    registry.route("session.dropped", move |intent, projector| {
        let store = store_of(&handle)?;
        let id = required_str(intent, "sessionId")?;
        store.dropped(&id, optional_str(intent, "error"));
        let produced = publish_sessions(projector, &store);
        sync_timer(&handle, &id);
        Ok(produced)
    });

    let handle = app_handle.clone();
    registry.route("session.reconnect", move |intent, projector| {
        let store = store_of(&handle)?;
        let id = required_str(intent, "sessionId")?;
        store.reconnect(&id);
        let produced = publish_sessions(projector, &store);
        sync_timer(&handle, &id);
        Ok(produced)
    });

    let handle = app_handle.clone();
    registry.route("session.reconnectAttempt", move |intent, projector| {
        let store = store_of(&handle)?;
        let id = required_str(intent, "sessionId")?;
        store.reconnect_attempt(&id);
        let produced = publish_sessions(projector, &store);
        sync_timer(&handle, &id);
        Ok(produced)
    });

    let handle = app_handle.clone();
    registry.route("session.reconnectFailed", move |intent, projector| {
        let store = store_of(&handle)?;
        let id = required_str(intent, "sessionId")?;
        store.reconnect_failed(&id, optional_str(intent, "error"));
        let produced = publish_sessions(projector, &store);
        sync_timer(&handle, &id);
        // If this failure exhausted the loop (give-up → Failed), the tab is no
        // longer reconnecting: scrub its retained request (#2454 Model A
        // mitigation). A failure that only backs off keeps it for the next
        // attempt.
        if store.reconnect_state(&id).map(|s| s.phase) == Some(ReconnectPhase::Gaveup) {
            clear_retained_request(&handle, &id);
        }
        Ok(produced)
    });

    let handle = app_handle.clone();
    registry.route("session.cancelReconnect", move |intent, projector| {
        let store = store_of(&handle)?;
        let id = required_str(intent, "sessionId")?;
        store.cancel_reconnect(&id);
        let produced = publish_sessions(projector, &store);
        sync_timer(&handle, &id);
        // The user stopped the loop: scrub the retained request (#2454 Model A
        // mitigation) — the session is no longer active or reconnecting.
        clear_retained_request(&handle, &id);
        Ok(produced)
    });

    let handle = app_handle.clone();
    registry.route("session.reconnectTrigger", move |intent, projector| {
        let store = store_of(&handle)?;
        let id = required_str(intent, "sessionId")?;
        store.set_reconnect_trigger(&id, optional_str(intent, "error"));
        Ok(publish_sessions(projector, &store))
    });

    let handle = app_handle;
    registry.route("session.remove", move |intent, projector| {
        let store = store_of(&handle)?;
        let id = required_str(intent, "sessionId")?;
        store.remove(&id);
        let produced = publish_sessions(projector, &store);
        sync_timer(&handle, &id);
        // The tab/session is gone: scrub any retained request (#2454 Model A
        // mitigation).
        clear_retained_request(&handle, &id);
        Ok(produced)
    });
}

/// Drop + zeroize the retained connection request for a tab (#2454, retention
/// Model A), when the `SessionManager` is managed. Called from the lifecycle
/// routes that end a session's reconnect loop — give-up, user-cancel, graceful
/// disconnect, remove — so no resolved secret outlives an active/reconnecting
/// session. `tab_id` is the region key (the intent's `sessionId`, which the
/// bridge keys by tab id). Off-path no-op when the manager is not managed (e.g. a
/// headless projection unit-test app), matching [`sync_timer`].
fn clear_retained_request(app_handle: &AppHandle, tab_id: &str) {
    if let Some(manager) = app_handle.try_state::<SessionManager>() {
        manager.clear_retained_request(tab_id);
    }
}

/// Reconcile the backend reconnect timer for a session after a transition, when
/// the timer driver is present. Off-path (a silent no-op) if the driver is not
/// managed yet — e.g. the shadow-only setup where nothing arms the loop.
fn sync_timer(app_handle: &AppHandle, session_id: &str) {
    if let Some(driver) = app_handle.try_state::<Arc<ReconnectTimerDriver>>() {
        (*driver).sync(session_id);
    }
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
