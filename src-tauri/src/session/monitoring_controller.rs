//! Thin session-monitoring facade over a session's monitoring capability.
//!
//! Extracted from [`SessionManager`](super::manager::SessionManager) (#2110,
//! follow-up to the file-ops seam #2076) to keep the manager focused on session
//! lifecycle. Every method here is the exact logic that lived inline on the
//! manager: resolve the session's monitoring provider, forward the call, and map
//! errors to [`TerminalError`]. The behavior, error messages, event names
//! (`session-monitoring-stats` / `session-monitoring-status`), lock discipline,
//! and — crucially — the background push-task lifecycle (spawn / abort /
//! cancellation) are exactly what lived on the manager.
//!
//! Unlike [`FileOps`](super::file_ops::FileOps), which borrows only the
//! `sessions` map, this facade borrows a *second* map — the manager's
//! `monitoring_tasks` abort-handle registry — because
//! [`start_session_monitoring`](MonitoringController::start_session_monitoring)
//! spawns a background task and stores its [`AbortHandle`] there, and
//! [`stop_session_monitoring`](MonitoringController::stop_session_monitoring)
//! aborts it. It still carries no state of its own; the manager constructs one
//! on demand via `SessionManager::monitoring` borrowing both maps.

use std::collections::HashMap;

use tauri::Emitter;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;
use tracing::{info, warn};

use termihub_core::monitoring::{MonitorStatus, MonitorStatusReceiver};

use crate::system_monitor_projection::projection::fold_monitor_transition;
use crate::utils::errors::TerminalError;

use super::manager::{SessionEntry, SessionMonitoringStatsEvent, SessionMonitoringStatusEvent};

/// Receive from an optional status receiver for use inside `tokio::select!`.
///
/// When the receiver is `None`, the future never resolves (`pending`), so the
/// select arm is inert and the other arm drives the loop. This lets the status
/// arm be disabled after its channel closes without spinning on repeated
/// `None`s.
async fn recv_optional(rx: &mut Option<MonitorStatusReceiver>) -> Option<MonitorStatus> {
    match rx.as_mut() {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

/// Borrowing facade exposing a session's monitoring operations.
///
/// Holds only borrows of the manager's `sessions` and `monitoring_tasks` maps,
/// so it carries no state of its own; the manager constructs one on demand via
/// [`SessionManager::monitoring`](super::manager::SessionManager). Each method
/// mirrors the corresponding monitoring provider operation.
pub(super) struct MonitoringController<'a> {
    sessions: &'a Mutex<HashMap<String, SessionEntry>>,
    monitoring_tasks: &'a Mutex<HashMap<String, AbortHandle>>,
}

impl<'a> MonitoringController<'a> {
    /// Wrap the manager's `sessions` and `monitoring_tasks` maps.
    pub(super) fn new(
        sessions: &'a Mutex<HashMap<String, SessionEntry>>,
        monitoring_tasks: &'a Mutex<HashMap<String, AbortHandle>>,
    ) -> Self {
        Self {
            sessions,
            monitoring_tasks,
        }
    }

    /// Subscribe to a session's monitoring provider and forward stats and
    /// status as Tauri events.
    ///
    /// Spawns a background task that reads the subscription's stats and status
    /// channels and emits `session-monitoring-stats` and
    /// `session-monitoring-status` events to the frontend. The status stream
    /// lets the UI surface an explicit `Stale` arm on a mid-stream drop instead
    /// of rendering frozen stats as live (#1229, audit gap G1). Call
    /// [`stop_session_monitoring`](Self::stop_session_monitoring) to cancel the
    /// task and unsubscribe.
    pub(super) async fn start_session_monitoring<R: tauri::Runtime>(
        &self,
        session_id: &str,
        interval_ms: Option<u64>,
        app_handle: tauri::AppHandle<R>,
    ) -> Result<(), TerminalError> {
        let subscription = {
            let sessions = self.sessions.lock().await;
            let entry = sessions
                .get(session_id)
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
            let provider = entry.connection.monitoring().ok_or_else(|| {
                TerminalError::RemoteError("No monitoring capability".to_string())
            })?;
            provider
                .subscribe()
                .await
                .map_err(|e| TerminalError::RemoteError(e.to_string()))?
        };

        // Apply the caller's chosen refresh interval to the now-running loop
        // (#1233). Done after the subscribe block so the provider reference is
        // not held across this await. Takes effect on the next tick; omitted →
        // provider default.
        if let Some(ms) = interval_ms {
            self.set_session_monitoring_interval(session_id, ms).await?;
        }

        let sid = session_id.to_string();
        let join_handle = tokio::spawn(async move {
            let mut stats_rx = subscription.stats;
            // `Option` so a closed status channel stops being polled instead of
            // spinning the select loop hot on repeated `None` (the agent path
            // sends a single `Live` then drops its status sender).
            let mut status_rx = Some(subscription.status);
            loop {
                tokio::select! {
                    stats = stats_rx.recv() => {
                        match stats {
                            Some(stats) => {
                                // Server-authority fold (#2376): update the shared
                                // `SystemMonitorStore` at the source — the instant
                                // the collector loop produces the sample — and fan
                                // the region diff out. Additive: the Tauri event
                                // below and the client `monitor.stats` mirror stay
                                // in place, so no user-facing behavior changes.
                                fold_monitor_transition(&app_handle, |store| {
                                    store.stats(&sid, stats.clone());
                                });
                                let event = SessionMonitoringStatsEvent {
                                    session_id: sid.clone(),
                                    stats,
                                };
                                if app_handle.emit("session-monitoring-stats", &event).is_err() {
                                    break;
                                }
                            }
                            // Stats channel closed: the collector loop ended.
                            None => break,
                        }
                    }
                    status = recv_optional(&mut status_rx) => {
                        match status {
                            Some(status) => {
                                // Server-authority fold (#2376): mirror the
                                // collector-produced status transition into the
                                // shared store at the source (additive; see the
                                // stats arm above).
                                fold_monitor_transition(&app_handle, |store| {
                                    store.set_status(&sid, status);
                                });
                                let event = SessionMonitoringStatusEvent {
                                    session_id: sid.clone(),
                                    status,
                                };
                                if app_handle.emit("session-monitoring-status", &event).is_err() {
                                    break;
                                }
                            }
                            // Status channel closed: stop polling it, keep
                            // forwarding stats. Only a closed stats channel ends
                            // the task.
                            None => status_rx = None,
                        }
                    }
                }
            }
            info!(session_id = %sid, "Session monitoring push task ended");
        });

        let abort_handle = join_handle.abort_handle();
        self.monitoring_tasks
            .lock()
            .await
            .insert(session_id.to_string(), abort_handle);
        Ok(())
    }

    /// Stop session-based monitoring: abort the push task and unsubscribe.
    pub(super) async fn stop_session_monitoring(
        &self,
        session_id: &str,
    ) -> Result<(), TerminalError> {
        if let Some(handle) = self.monitoring_tasks.lock().await.remove(session_id) {
            handle.abort();
        }

        let sessions = self.sessions.lock().await;
        if let Some(entry) = sessions.get(session_id) {
            if let Some(provider) = entry.connection.monitoring() {
                if let Err(e) = provider.unsubscribe().await {
                    warn!(session_id, error = %e, "Session monitoring unsubscribe error");
                }
            }
        }
        Ok(())
    }

    /// Pause or resume a session's monitoring loop (#1233).
    ///
    /// A paused loop keeps its transport open but stops collecting, emitting a
    /// `Paused` status event; resuming emits `Live`.
    pub(super) async fn set_session_monitoring_paused(
        &self,
        session_id: &str,
        paused: bool,
    ) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        let provider = entry
            .connection
            .monitoring()
            .ok_or_else(|| TerminalError::RemoteError("No monitoring capability".to_string()))?;
        provider.set_paused(paused).await;
        Ok(())
    }

    /// Change a session monitoring loop's refresh interval (#1233).
    pub(super) async fn set_session_monitoring_interval(
        &self,
        session_id: &str,
        interval_ms: u64,
    ) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
        let provider = entry
            .connection
            .monitoring()
            .ok_or_else(|| TerminalError::RemoteError("No monitoring capability".to_string()))?;
        provider
            .set_interval(std::time::Duration::from_millis(interval_ms.max(1)))
            .await;
        Ok(())
    }

    /// Abort a session monitoring loop's in-flight connect / collect (#1233).
    ///
    /// Best-effort: a missing session or provider is treated as already gone.
    pub(super) async fn cancel_session_monitoring(
        &self,
        session_id: &str,
    ) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().await;
        if let Some(entry) = sessions.get(session_id) {
            if let Some(provider) = entry.connection.monitoring() {
                provider.cancel_connect().await;
            }
        }
        Ok(())
    }
}
