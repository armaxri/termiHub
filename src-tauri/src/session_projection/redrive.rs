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
        // (its `Drop` zeroizes the clone). `agent_id` is `Some` for a resilient
        // **agent** tab (once #2473 routes them + retains the request): the redrive
        // must cold-re-establish that agent's transport before re-creating the
        // session, since `create_connection` → `create_session` fails "Agent not
        // connected" when the SSH transport was reaped (#2472).
        let type_id = request.type_id.clone();
        let settings = request.settings.clone();
        let agent_id = request.agent_id.clone();
        // The live agent session id this tab is attached to (#2512). `Some` for a
        // resilient agent tab: the redrive re-attaches to *this* live session
        // (running process continues) instead of minting a new one, and emits
        // session-lost if the agent no longer lists it. `None` for a direct tab.
        let agent_session_id = request.agent_session_id.clone();
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
            // For a resilient **agent** tab, cold-re-establish the agent SSH
            // transport from the backend-retained config (#2472) before minting
            // the session. This models the client engine's "park while the agent
            // reconnects": one loop attempt = one (re-establish + create) try, so
            // the reconnect loop's own bounded backoff subsumes the client's
            // `MAX_AGENT_SPAWN_ATTEMPTS`. The re-establish is a blocking SSH
            // connect, so it runs on the blocking pool (as the connect command
            // does). No-op when the agent is already connected — the in-task
            // reconnect loop owns transient breaks, so the redrive never
            // double-drives the transport.
            if let Some(aid) = agent_id.as_deref() {
                let client = manager.agent_client();
                let aid_owned = aid.to_string();
                let established = tauri::async_runtime::spawn_blocking(move || {
                    client.reconnect_retained_agent(&aid_owned)
                })
                .await;
                let transport_up = matches!(established, Ok(Ok(())));
                if !transport_up {
                    // Could not re-establish the agent transport this attempt:
                    // fold a reconnect failure so the engine arms the next backoff
                    // window or gives up, exactly as a failed session create would.
                    let err = match established {
                        Ok(Err(e)) => e.to_string(),
                        _ => "agent transport re-establishment failed".to_string(),
                    };
                    fold_session_transition(&app, |store| {
                        store.reconnect_failed(&tab_id, Some(err));
                    });
                    sync_timer(&app, &tab_id);
                    clear_retained_on_giveup(&app, &tab_id);
                    return;
                }

                // #2512: for a resilient **agent** tab whose live agent session id
                // we retained, re-attach to *that same* live session (the running
                // process continues) rather than minting a new one — or emit an
                // explicit session-lost state when the agent no longer lists it.
                // The transport is up (checked above), so the agent can answer
                // `connection.list`. Direct tabs and agent tabs with no retained
                // session id fall through to the create path below.
                if let Some(remote_sid) = agent_session_id.as_deref() {
                    reattach_or_lose(&app, &manager, &tab_id, aid, remote_sid).await;
                    return;
                }
            }

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
                    clear_retained_on_giveup(&app, &tab_id);
                }
            }
        });
    }
}

/// Re-attach a reconnecting resilient agent tab to its retained **live** agent
/// session, or emit an explicit session-lost state when the agent no longer
/// lists it (#2512). The caller has already re-established the agent transport,
/// so `connection.list` can answer.
///
/// Never mints a new agent session (maintainer decision): a recovered live
/// session is re-attached so the **running process continues**; an unrecoverable
/// one surfaces [`SessionLifecycleStore::session_lost`] so the frontend renders a
/// "session lost" notice + manual "start new shell", never a silent replacement.
async fn reattach_or_lose<R: Runtime>(
    app: &AppHandle<R>,
    manager: &SessionManager,
    tab_id: &str,
    agent_id: &str,
    remote_session_id: &str,
) {
    // Ask the agent which sessions are live/recovered. Runs on the blocking pool
    // (the client parks on `blocking_recv`), like the transport re-establish.
    let client = manager.agent_client();
    let aid = agent_id.to_string();
    let listed = tauri::async_runtime::spawn_blocking(move || client.list_sessions(&aid)).await;

    let recoverable = matches!(&listed, Ok(Ok(sessions))
        if sessions
            .iter()
            .any(|s| s.session_id == remote_session_id && is_recoverable_status(&s.status)));

    if !recoverable {
        // The live session is gone. Guard the cancel race, then fold the terminal
        // session-lost state and scrub the retained secrets — never a silent new
        // shell.
        if still_connecting(app, tab_id) {
            fold_session_transition(app, |store| {
                store.session_lost(
                    tab_id,
                    Some("the live agent session could not be recovered".to_string()),
                );
            });
            sync_timer(app, tab_id);
            manager.clear_retained_request_with_agent_scrub(tab_id);
        }
        return;
    }

    match manager
        .reattach_agent_session(tab_id, agent_id, remote_session_id, app.clone())
        .await
    {
        Ok(new_session_id) => {
            // Guard the cancel race exactly as the create path does: a user cancel
            // / give-up that landed while attaching moved the loop off
            // `Connecting` — tear the freshly re-attached desktop session down
            // rather than settling it live.
            if !still_connecting(app, tab_id) {
                let _ = manager.close_session(&new_session_id).await;
                return;
            }
            // Settle the tab live and hand the frontend the new backend session id
            // to re-attach terminal I/O to (#2457); the live process continues.
            let sid = new_session_id.clone();
            fold_session_transition(app, |store| {
                store.connected(tab_id);
                store.set_backend_session_id(tab_id, Some(sid.clone()));
            });
            sync_timer(app, tab_id);
        }
        Err(e) => {
            // A transient attach failure re-arms the next backoff window (or gives
            // up), exactly like a failed create — a transport hiccup, distinct
            // from a gone session (which folds session-lost above).
            fold_session_transition(app, |store| {
                store.reconnect_failed(tab_id, Some(e.to_string()));
            });
            sync_timer(app, tab_id);
            clear_retained_on_giveup(app, tab_id);
        }
    }
}

/// Whether the tab's reconnect loop is still in its `Connecting` sub-phase — the
/// guard the redrive uses to avoid settling (or stomping) an outcome after a user
/// cancel / give-up raced the in-flight attempt.
fn still_connecting<R: Runtime>(app: &AppHandle<R>, tab_id: &str) -> bool {
    app.try_state::<Arc<SessionLifecycleStore>>()
        .and_then(|store| store.reconnect_state(tab_id))
        .map(|s| s.phase)
        == Some(ReconnectPhase::Connecting)
}

/// Whether an agent-reported session status means the live session is still there
/// to re-attach to (#2512). The agent reports `running` for both live and
/// **recovered** sessions (a recovered daemon is set back to `Running`); a
/// naturally-exited session reports `exited` and must not be re-attached.
fn is_recoverable_status(status: &str) -> bool {
    status == "running"
}

/// On a reconnect give-up (terminal `Failed`), scrub the secrets the loop
/// retained so none outlives it: the per-tab connection request (#2454) and —
/// for a resilient **agent** tab — the per-agent transport config (#2472). A
/// no-op unless the store reports the tab actually gave up (a mere backoff stays
/// `Waiting` and keeps the retained secrets for the next attempt).
///
/// The agent-config scrub is **refcounted** (#2473): one SSH transport is shared
/// by every session on an agent, so this tab giving up must not scrub the config
/// while a sibling tab on the same agent is still reconnecting over it.
/// [`SessionManager::clear_retained_request_with_agent_scrub`] clears this tab's
/// request first, then scrubs the per-agent config only when no sibling request
/// still routes through the agent.
fn clear_retained_on_giveup<R: Runtime>(app: &AppHandle<R>, tab_id: &str) {
    let gave_up = app
        .try_state::<Arc<SessionLifecycleStore>>()
        .and_then(|store| store.reconnect_state(tab_id))
        .map(|s| s.phase)
        == Some(ReconnectPhase::Gaveup);
    if !gave_up {
        return;
    }
    if let Some(manager) = app.try_state::<SessionManager>() {
        manager.clear_retained_request_with_agent_scrub(tab_id);
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
