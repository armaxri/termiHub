//! Backend-driven reconnect redrive — the transport half of Phase 4's
//! session-lifecycle inversion (#2454, remainder of #2446; unblocks #2205 PR-B).
//!
//! [`crate::session_projection::timer`] (#2203) moved the reconnect backoff
//! loop's *timing* server-side: its [`ReconnectTimerDriver`] fires the
//! `Waiting → Attempt` edge itself. Until now the attempt's *transport* still
//! lived in the client — the frontend, reconciling the `Connecting` diff, called
//! `create_connection` again. This module moves that transport server-side too,
//! for **resilient direct** connections: on the fired attempt the backend
//! re-establishes the connection itself from the retained request (retention
//! Model A, #2458), mints a new backend session, folds the outcome at the source
//! into the shared `session-lifecycle` store, and publishes the new `sessionId`
//! so the frontend re-attaches terminal I/O to it (#2457) without a client
//! `create_connection`.
//!
//! # The flag gate — byte-identical when off
//!
//! The whole redrive is gated by the retained request's `backend_reattach`
//! field, threaded from the client's default-off `sessionBackendReattach` flag
//! through `create_connection`. [`AppReconnectRedrive::redrive`] no-ops for any
//! tab that did not opt in, so the fired attempt's `Connecting` diff simply fans
//! out and the **client** drives the redrive exactly as on `develop`. Turning the
//! flag on is a real authority cut, not an additive double-write: the reconnect
//! engine is non-idempotent, so under the flag the client suppresses its own
//! redrive + outcome mirrors and the backend is the sole driver of the attempt
//! and its `connected` / `reconnectFailed` outcome.
//!
//! # Secret lifetime
//!
//! The retained `settings` may carry resolved secrets. A successful redrive
//! re-retains a fresh request (for the next drop); a give-up (exhausted attempts)
//! drops + **zeroizes** it here so no resolved secret outlives the loop — the
//! backend-redrive counterpart to the intent-route scrubs #2458 wired.

use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};
use termihub_core::reconnect_backoff::ReconnectPhase;

use crate::session::manager::SessionManager;
use crate::session_projection::projection::fold_session_transition;
use crate::session_projection::store::SessionLifecycleStore;
use crate::session_projection::timer::{ReconnectRedrive, ReconnectTimerDriver};

/// Production [`ReconnectRedrive`] over a Tauri [`AppHandle`]. Resolves the
/// managed [`SessionManager`], [`SessionLifecycleStore`] and
/// [`ReconnectTimerDriver`] lazily at redrive time (never at construction, so the
/// timer driver it feeds back into can hold it without a cycle), mirroring the
/// resolve-managed-state pattern of [`fold_session_transition`].
pub struct AppReconnectRedrive<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> AppReconnectRedrive<R> {
    /// Build a redrive hook over an app handle.
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> ReconnectRedrive for AppReconnectRedrive<R> {
    fn redrive(&self, tab_id: &str) {
        // Off-path unless everything the redrive needs is managed (a headless
        // projection unit-test app never runs `setup()`), matching
        // `fold_session_transition` / `sync_timer`.
        let Some(manager) = self.app.try_state::<SessionManager>() else {
            return;
        };
        let Some(store) = self.app.try_state::<Arc<SessionLifecycleStore>>() else {
            return;
        };

        // The opt-in gate: only a tab whose retained request carries
        // `backend_reattach` (the client's `sessionBackendReattach` flag) is
        // backend-driven. Absent request or an opted-out tab → the client drives.
        let request = match manager.retained_request(tab_id) {
            Some(req) if req.backend_reattach => req,
            _ => return,
        };

        // Only redrive an attempt the store is actually running: `fire` advances
        // `Waiting → Connecting` before calling here, but a cancel/give-up that
        // landed in between leaves the phase elsewhere — do not connect then.
        if store.reconnect_state(tab_id).map(|s| s.phase) != Some(ReconnectPhase::Connecting) {
            return;
        }
        let attempt = store
            .reconnect_state(tab_id)
            .map(|s| s.attempt)
            .unwrap_or(0);

        // Clone out the fields to forward before the secret-bearing request drops
        // (its `Drop` zeroizes the clone). `agent_id` is always `None` for the
        // direct connections this covers; the field is forwarded for #2455.
        let type_id = request.type_id.clone();
        let settings = request.settings.clone();
        let agent_id = request.agent_id.clone();
        drop(request);

        // A unique per-attempt connect id in the `${tabId}:${retry}` form so the
        // new session records the tab-id identity bridge (#2431) and a Stop can
        // cancel the in-flight handshake. `retry >= 1` (never `0`) so
        // `create_connection`'s initial-attempt connect-failed fold does not fire
        // — the redrive folds the reconnect outcome itself, below.
        let connect_id = format!("{tab_id}:{}", attempt.max(1));

        let app = self.app.clone();
        let manager = (*manager).clone();
        let tab_id = tab_id.to_string();
        tauri::async_runtime::spawn(async move {
            let result = manager
                .create_connection(
                    &type_id,
                    settings,
                    agent_id.as_deref(),
                    Some(&connect_id),
                    false, // not a spawn-origin session
                    true,  // resilient (this loop only runs for resilient tabs)
                    true,  // backend_reattach: keep the gate on across the refresh
                    app.clone(),
                )
                .await;

            match result {
                Ok(new_session_id) => {
                    // Guard the cancel race: a user cancel / give-up that landed
                    // while the connect was in flight moved the loop off
                    // `Connecting`. Do not settle it live — tear the orphan
                    // session down instead so nothing outlives the cancelled loop.
                    let still_connecting = app
                        .try_state::<Arc<SessionLifecycleStore>>()
                        .and_then(|store| store.reconnect_state(&tab_id))
                        .map(|s| s.phase)
                        == Some(ReconnectPhase::Connecting);
                    if !still_connecting {
                        let _ = manager.close_session(&new_session_id).await;
                        return;
                    }
                    // Fold the success at the source: settle the tab live and hand
                    // the frontend the new backend session id to re-attach to
                    // (#2457) — the region is keyed by the stable tab id.
                    let sid = new_session_id.clone();
                    fold_session_transition(&app, |store| {
                        store.connected(&tab_id);
                        store.set_backend_session_id(&tab_id, Some(sid.clone()));
                    });
                    sync_timer(&app, &tab_id);
                }
                Err(e) => {
                    // Fold the failure at the source: the engine either arms the
                    // next backoff window (stay reconnecting) or gives up
                    // (terminal `Failed`). Re-sync re-arms / cancels the timer.
                    fold_session_transition(&app, |store| {
                        store.reconnect_failed(&tab_id, Some(e.to_string()));
                    });
                    sync_timer(&app, &tab_id);
                    // On give-up the loop is over: drop + zeroize the retained
                    // request so no resolved secret outlives it (#2454 mitigation).
                    let gave_up = app
                        .try_state::<Arc<SessionLifecycleStore>>()
                        .and_then(|store| store.reconnect_state(&tab_id))
                        .map(|s| s.phase)
                        == Some(ReconnectPhase::Gaveup);
                    if gave_up {
                        if let Some(manager) = app.try_state::<SessionManager>() {
                            manager.clear_retained_request(&tab_id);
                        }
                    }
                }
            }
        });
    }
}

/// Re-arm / cancel the backend reconnect timer for `tab_id` after the redrive
/// folded its outcome, when the driver is managed. A backoff (stay `Waiting`)
/// re-arms the next one-shot; a success / give-up cancels. Off-path no-op when
/// the driver is absent (matches [`crate::session_projection::projection`]'s
/// `sync_timer`, which the intent routes use).
fn sync_timer<R: Runtime>(app: &AppHandle<R>, tab_id: &str) {
    if let Some(driver) = app.try_state::<Arc<ReconnectTimerDriver>>() {
        driver.inner().sync(tab_id);
    }
}
