//! Session-monitoring seam for [`SessionManager`] (ARCH-002 / TAURI-009).
//!
//! Carved out of `session/manager.rs` as a behavior-preserving prod slice: the
//! cohesive monitoring-lifecycle family (`monitoring`,
//! `start_session_monitoring`, `stop_session_monitoring`,
//! `set_session_monitoring_paused`, `set_session_monitoring_interval`,
//! `cancel_session_monitoring`) lives here in a second `impl SessionManager`
//! block. Signatures, visibility, and behavior are unchanged; the block reaches
//! the struct's fields exactly as before because this is a submodule of
//! `session::manager`.

use crate::session::monitoring_controller::MonitoringController;
use crate::utils::errors::TerminalError;

use super::SessionManager;

impl SessionManager {
    /// Borrow a [`MonitoringController`] facade over this manager's session and
    /// monitoring-task maps (#2110).
    ///
    /// The facade is stateless — it holds only borrows of the `sessions` and
    /// `monitoring_tasks` maps — so the public `*_session_monitoring` methods
    /// below construct one per call and forward to it. This keeps the
    /// monitoring plumbing (including the background push-task spawn / abort /
    /// cancellation lifecycle) out of the manager while leaving the public API
    /// and behavior unchanged.
    fn monitoring(&self) -> MonitoringController<'_> {
        MonitoringController::new(
            &self.sessions,
            &self.monitoring_tasks,
            &self.monitoring_overrides,
        )
    }

    /// Subscribe to a session's monitoring provider and fold stats and status
    /// into the shared `SystemMonitorStore` at the source.
    ///
    /// Spawns a background task that reads the subscription's stats and status
    /// channels and folds each sample into the store, fanning the
    /// system-monitor region diff out to subscribers. The status stream lets the
    /// UI surface an explicit `Stale` arm on a mid-stream drop instead of
    /// rendering frozen stats as live (#1229, audit gap G1). Call
    /// [`stop_session_monitoring`](Self::stop_session_monitoring) to cancel the
    /// task and unsubscribe.
    pub async fn start_session_monitoring<R: tauri::Runtime>(
        &self,
        session_id: &str,
        interval_ms: Option<u64>,
        run_location: crate::run_location::RunLocation,
        app_handle: tauri::AppHandle<R>,
    ) -> Result<(), TerminalError> {
        self.monitoring()
            .start_session_monitoring(session_id, interval_ms, run_location, app_handle)
            .await
    }

    /// Stop session-based monitoring: abort the push task and unsubscribe.
    pub async fn stop_session_monitoring(&self, session_id: &str) -> Result<(), TerminalError> {
        self.monitoring().stop_session_monitoring(session_id).await
    }

    /// Pause or resume a session's monitoring loop (#1233).
    ///
    /// A paused loop keeps its transport open but stops collecting, emitting a
    /// `Paused` status event; resuming emits `Live`.
    pub async fn set_session_monitoring_paused(
        &self,
        session_id: &str,
        paused: bool,
    ) -> Result<(), TerminalError> {
        self.monitoring()
            .set_session_monitoring_paused(session_id, paused)
            .await
    }

    /// Change a session monitoring loop's refresh interval (#1233).
    pub async fn set_session_monitoring_interval(
        &self,
        session_id: &str,
        interval_ms: u64,
    ) -> Result<(), TerminalError> {
        self.monitoring()
            .set_session_monitoring_interval(session_id, interval_ms)
            .await
    }

    /// Abort a session monitoring loop's in-flight connect / collect (#1233).
    ///
    /// Best-effort: a missing session or provider is treated as already gone.
    pub async fn cancel_session_monitoring(&self, session_id: &str) -> Result<(), TerminalError> {
        self.monitoring()
            .cancel_session_monitoring(session_id)
            .await
    }
}
