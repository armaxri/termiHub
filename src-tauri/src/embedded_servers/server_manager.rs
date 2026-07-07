use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter};

use super::config::{
    AtomicServerStats, EmbeddedServerConfig, EmbeddedServerStore, ServerState, ServerStats,
    ServerStatus, ServerType,
};
use super::ftp_server::start_ftp_server;
use super::http_server::start_http_server;
use super::storage::EmbeddedServerStorage;
use super::tftp_server::start_tftp_server;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// How long the manager waits for a server thread to confirm its bind before
/// treating the start as failed. Binding a local socket is near-instant, so a
/// generous timeout only guards against a wedged thread (GAP G3, #1145).
const BIND_CONFIRM_TIMEOUT: Duration = Duration::from_secs(5);

/// One-shot handle a server thread uses to report whether its listening socket
/// bound successfully.
///
/// The manager holds the receiving end and only emits `Running` once
/// [`BindSignal::confirm`] arrives; a [`BindSignal::fail`] (or a dropped sender)
/// keeps the server out of the `active` map so it never shows a stuck "Running"
/// before flipping to `Error` (GAP G3, #1145).
pub(super) struct BindSignal {
    tx: SyncSender<Result<(), String>>,
}

impl BindSignal {
    /// Report that the listening socket bound successfully.
    pub(super) fn confirm(&self) {
        // A full/closed channel means the manager already gave up waiting; the
        // send failure is harmless because the thread will still shut down.
        let _ = self.tx.send(Ok(()));
    }

    /// Report that binding failed, carrying the reason for the UI.
    pub(super) fn fail(&self, reason: &str) {
        let _ = self.tx.send(Err(reason.to_string()));
    }
}

/// Decision the manager makes from a server thread's bind signal.
#[derive(Debug)]
enum BindOutcome {
    /// The socket bound — keep the `active` entry and emit `Running`.
    Running,
    /// The bind failed (explicit error, dropped sender, or timeout) — drop the
    /// `active` entry and emit `Error` with this reason.
    Failed(String),
}

/// Map a server thread's bind signal (received over the confirm channel) to the
/// manager's next action, so `Running` is only ever produced after a *confirmed*
/// bind (GAP G3, #1145).
///
/// Pure and `AppHandle`-free so the start-flow decision can be unit-tested.
fn decide_bind_outcome(signal: Result<Result<(), String>, RecvTimeoutError>) -> BindOutcome {
    match signal {
        Ok(Ok(())) => BindOutcome::Running,
        Ok(Err(reason)) => BindOutcome::Failed(reason),
        Err(RecvTimeoutError::Disconnected) => {
            BindOutcome::Failed("server exited before confirming it was listening".to_string())
        }
        Err(RecvTimeoutError::Timeout) => {
            BindOutcome::Failed("server did not confirm it was listening in time".to_string())
        }
    }
}

/// A running server instance.
struct ActiveServer {
    shutdown: Arc<AtomicBool>,
    #[allow(dead_code)]
    thread_handle: thread::JoinHandle<()>,
    stats: Arc<AtomicServerStats>,
    started_at: String,
    /// Shared status updated by the server thread on error.
    error: Arc<Mutex<Option<String>>>,
}

/// Central manager for embedded HTTP/FTP/TFTP servers.
///
/// Follows the same pattern as `TunnelManager`.
pub struct EmbeddedServerManager {
    configs: Mutex<EmbeddedServerStore>,
    storage: EmbeddedServerStorage,
    active: Mutex<HashMap<String, ActiveServer>>,
    app_handle: AppHandle,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl EmbeddedServerManager {
    /// Create a new manager, loading saved configurations from disk.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage = EmbeddedServerStorage::new(app_handle)
            .context("Failed to initialise embedded server storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load embedded servers")?;
        Ok(Self {
            configs: Mutex::new(result.data),
            storage,
            active: Mutex::new(HashMap::new()),
            app_handle: app_handle.clone(),
            recovery_warnings: Mutex::new(result.warnings),
        })
    }

    /// Drain and return any recovery warnings collected during initialisation.
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| w.drain(..).collect())
            .unwrap_or_default()
    }

    /// Return all saved server configurations.
    pub fn get_configs(&self) -> Result<Vec<EmbeddedServerConfig>, TerminalError> {
        let store = self
            .configs
            .lock()
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))?;
        Ok(store.servers.clone())
    }

    /// Add or update a server configuration.
    pub fn save_config(&self, config: EmbeddedServerConfig) -> Result<(), TerminalError> {
        let mut store = self
            .configs
            .lock()
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))?;
        if let Some(existing) = store.servers.iter_mut().find(|s| s.id == config.id) {
            *existing = config;
        } else {
            store.servers.push(config);
        }
        self.storage
            .save(&store)
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Save failed: {e}")))?;
        Ok(())
    }

    /// Delete a configuration. Stops the server first if it is running.
    pub fn delete_config(&self, server_id: &str) -> Result<(), TerminalError> {
        self.stop_server(server_id)?;
        let mut store = self
            .configs
            .lock()
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))?;
        store.servers.retain(|s| s.id != server_id);
        self.storage
            .save(&store)
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Save failed: {e}")))?;
        Ok(())
    }

    /// Return the current runtime state of every configured server.
    pub fn get_states(&self) -> Result<Vec<ServerState>, TerminalError> {
        let store = self
            .configs
            .lock()
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))?;
        let active = self
            .active
            .lock()
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))?;

        let states = store
            .servers
            .iter()
            .map(|cfg| {
                if let Some(srv) = active.get(&cfg.id) {
                    let error = srv.error.lock().ok().and_then(|e| e.clone());
                    let status = if error.is_some() {
                        ServerStatus::Error
                    } else {
                        ServerStatus::Running
                    };
                    ServerState {
                        server_id: cfg.id.clone(),
                        status,
                        error,
                        stats: srv.stats.snapshot(),
                        started_at: Some(srv.started_at.clone()),
                    }
                } else {
                    ServerState {
                        server_id: cfg.id.clone(),
                        status: ServerStatus::Stopped,
                        error: None,
                        stats: ServerStats::default(),
                        started_at: None,
                    }
                }
            })
            .collect();

        Ok(states)
    }

    /// Start a server by ID.
    pub fn start_server(&self, server_id: &str) -> Result<(), TerminalError> {
        let config = {
            let store = self
                .configs
                .lock()
                .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))?;
            store
                .servers
                .iter()
                .find(|s| s.id == server_id)
                .cloned()
                .ok_or_else(|| {
                    TerminalError::EmbeddedServerError(format!("Server not found: {server_id}"))
                })?
        };

        {
            let mut active = self
                .active
                .lock()
                .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))?;
            match active.get(server_id) {
                // A live server (no runtime error recorded) genuinely blocks a
                // second start.
                Some(srv) if active_entry_is_live(&srv.error) => {
                    return Err(TerminalError::EmbeddedServerError(format!(
                        "Server {server_id} is already running"
                    )));
                }
                // GAP G2/G9: a server that failed at runtime leaves a dead husk
                // in `active`. Drop it so `Error → Stopped` is real and this
                // start acts as a Retry instead of being rejected as "already
                // running". Its thread has already exited (it emitted `Error`).
                Some(_) => {
                    if let Some(dead) = active.remove(server_id) {
                        dead.shutdown.store(true, Ordering::Relaxed);
                    }
                }
                None => {}
            }
        }

        // Pre-flight bind check so we can return an error immediately for the
        // common "port already in use" case.
        self.check_port(&config)?;

        self.emit_status(server_id, ServerStatus::Starting, None);

        let shutdown = Arc::new(AtomicBool::new(false));
        let stats = AtomicServerStats::new();
        let error_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // One-slot channel the server thread uses to confirm (or reject) its
        // real bind. `Running` is only emitted after this confirmation, so a
        // late bind failure never leaves the item stuck green (GAP G3, #1145).
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);

        let cfg = config.clone();
        let shutdown_clone = Arc::clone(&shutdown);
        let stats_clone = Arc::clone(&stats);
        let error_clone = Arc::clone(&error_slot);
        let handle_clone = self.app_handle.clone();
        let id = server_id.to_string();

        let thread_handle = thread::spawn(move || {
            let ready = BindSignal { tx: ready_tx };
            let result = match cfg.server_type {
                ServerType::Http => start_http_server(&cfg, shutdown_clone, stats_clone, ready),
                ServerType::Ftp => start_ftp_server(&cfg, shutdown_clone, stats_clone, ready),
                ServerType::Tftp => start_tftp_server(&cfg, shutdown_clone, stats_clone, ready),
            };

            if let Err(e) = result {
                let msg = e.to_string();
                tracing::error!(%id, "Embedded server error: {msg}");
                if let Ok(mut slot) = error_clone.lock() {
                    *slot = Some(msg.clone());
                }
                let state = ServerState {
                    server_id: id.clone(),
                    status: ServerStatus::Error,
                    error: Some(msg),
                    stats: ServerStats::default(),
                    started_at: None,
                };
                let _ = handle_clone.emit("embedded-server-status-changed", &state);
            }
        });

        // Wait for the thread to confirm its bind before declaring Running.
        match decide_bind_outcome(ready_rx.recv_timeout(BIND_CONFIRM_TIMEOUT)) {
            BindOutcome::Running => {
                let started_at = chrono::Utc::now().to_rfc3339();
                {
                    let mut active = self.active.lock().map_err(|e| {
                        TerminalError::EmbeddedServerError(format!("Lock error: {e}"))
                    })?;
                    active.insert(
                        server_id.to_string(),
                        ActiveServer {
                            shutdown,
                            thread_handle,
                            stats,
                            started_at,
                            error: error_slot,
                        },
                    );
                }

                self.emit_status(server_id, ServerStatus::Running, None);
                tracing::info!(%server_id, "Embedded server started");
                Ok(())
            }
            BindOutcome::Failed(reason) => {
                // Bind never confirmed. Signal the thread to unwind (in case it
                // did bind but timed out) and leave nothing in `active`, so the
                // server is reported as Error rather than a stuck Running.
                shutdown.store(true, Ordering::Relaxed);
                tracing::warn!(%server_id, "Embedded server failed to start: {reason}");
                self.emit_status(server_id, ServerStatus::Error, Some(reason.clone()));
                Err(TerminalError::EmbeddedServerError(reason))
            }
        }
    }

    /// Stop a running server by ID.
    pub fn stop_server(&self, server_id: &str) -> Result<(), TerminalError> {
        let server = {
            let mut active = self
                .active
                .lock()
                .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))?;
            active.remove(server_id)
        };

        if let Some(srv) = server {
            srv.shutdown.store(true, Ordering::Relaxed);
            // Do not join — the server thread will exit on its own after the
            // next poll cycle.  This avoids blocking the main thread.
            self.emit_status(server_id, ServerStatus::Stopped, None);
            tracing::info!(%server_id, "Embedded server stopped");
        }

        Ok(())
    }

    /// Stop all running servers (called on app shutdown).
    pub fn stop_all(&self) {
        let ids: Vec<String> = self
            .active
            .lock()
            .map(|a| a.keys().cloned().collect())
            .unwrap_or_default();

        for id in ids {
            if let Err(e) = self.stop_server(&id) {
                tracing::error!(%id, "Failed to stop embedded server: {e}");
            }
        }
    }

    /// Start all servers with `auto_start: true`.
    pub fn start_auto_servers(&self) {
        let configs = match self.get_configs() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("Failed to load configs for auto-start: {e}");
                return;
            }
        };
        for cfg in configs {
            if cfg.auto_start {
                if let Err(e) = self.start_server(&cfg.id) {
                    // Surface the failure (e.g. port busy at boot) as an Error
                    // state so the sidebar shows the server red with a reason,
                    // instead of silently leaving it stopped (GAP G7, #1145).
                    let msg = e.to_string();
                    tracing::warn!(id = %cfg.id, "Failed to auto-start embedded server: {msg}");
                    let state = auto_start_error_state(&cfg.id, &msg);
                    let _ = self
                        .app_handle
                        .emit("embedded-server-status-changed", &state);
                }
            }
        }
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /// Attempt a quick bind to check whether the port is available.
    fn check_port(&self, config: &EmbeddedServerConfig) -> Result<(), TerminalError> {
        Self::check_port_config(config)
    }

    /// Attempt a quick bind to check whether a config's port is available.
    ///
    /// Static so the pre-flight check can be exercised without a live manager
    /// (and its [`AppHandle`]).
    fn check_port_config(config: &EmbeddedServerConfig) -> Result<(), TerminalError> {
        let addr = format!("{}:{}", config.bind_host, config.port);
        match config.server_type {
            ServerType::Tftp => {
                let socket = std::net::UdpSocket::bind(&addr).map_err(|e| {
                    TerminalError::EmbeddedServerError(format!(
                        "Port {} is already in use: {e}",
                        config.port
                    ))
                })?;
                drop(socket);
            }
            _ => {
                let listener = std::net::TcpListener::bind(&addr).map_err(|e| {
                    TerminalError::EmbeddedServerError(format!(
                        "Port {} is already in use: {e}",
                        config.port
                    ))
                })?;
                drop(listener);
            }
        }
        Ok(())
    }

    fn emit_status(&self, server_id: &str, status: ServerStatus, error: Option<String>) {
        let state = ServerState {
            server_id: server_id.to_string(),
            status,
            error,
            stats: ServerStats::default(),
            started_at: None,
        };
        let _ = self
            .app_handle
            .emit("embedded-server-status-changed", &state);
    }
}

/// Decide whether an `active` map entry represents a *live* server (as opposed
/// to a dead husk left behind by a runtime failure).
///
/// The server thread records the failure reason into its shared `error` slot and
/// then exits, but the manager keeps the map entry so `get_states` can keep
/// surfacing the error. A live entry (empty error slot) must block a second
/// concurrent start; a failed entry (error slot set) must NOT, so a subsequent
/// `start_server` acts as a Retry rather than being rejected as "already
/// running" — making `Error → Stopped` a real, escapable transition
/// (GAP G2/G9, #1145).
fn active_entry_is_live(error: &Arc<Mutex<Option<String>>>) -> bool {
    // If the lock is poisoned we cannot prove the server is healthy, so treat it
    // as not-live and allow a fresh start to recover.
    error.lock().map(|slot| slot.is_none()).unwrap_or(false)
}

/// Build the `Error` [`ServerState`] surfaced when a server marked `auto_start`
/// fails to start at launch (e.g. its port is already in use).
///
/// Keeps the failure visible in the sidebar (red, with a reason) instead of
/// silently leaving the server stopped (GAP G7, #1145).
fn auto_start_error_state(server_id: &str, error: &str) -> ServerState {
    ServerState {
        server_id: server_id.to_string(),
        status: ServerStatus::Error,
        error: Some(error.to_string()),
        stats: ServerStats::default(),
        started_at: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// A successful bind signal must produce a `Running` outcome so the manager
    /// keeps the `active` entry and emits `Running` (GAP G3, #1145).
    #[test]
    fn bind_success_signal_yields_running() {
        let outcome = decide_bind_outcome(Ok(Ok(())));
        assert!(
            matches!(outcome, BindOutcome::Running),
            "Ok(Ok(())) should map to Running, got {outcome:?}"
        );
    }

    /// A late bind failure reported by the server thread must yield `Failed`
    /// carrying the reason, so the manager emits `Error` and drops the `active`
    /// entry instead of leaving the item stuck green (GAP G3, #1145).
    #[test]
    fn bind_failure_signal_yields_failed_with_reason() {
        let outcome = decide_bind_outcome(Ok(Err("Port 8080 is already in use".to_string())));
        match outcome {
            BindOutcome::Failed(reason) => assert!(
                reason.contains("already in use"),
                "failure reason must be preserved, got: {reason}"
            ),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    /// If the thread dies (panics / returns) before signalling, the sender is
    /// dropped and `recv` reports `Disconnected` — this is a start failure, so
    /// it must be `Failed`, never `Running` (GAP G3, #1145).
    #[test]
    fn bind_disconnected_signal_yields_failed() {
        let outcome = decide_bind_outcome(Err(mpsc::RecvTimeoutError::Disconnected));
        assert!(
            matches!(outcome, BindOutcome::Failed(_)),
            "a disconnected channel means the bind never confirmed, got {outcome:?}"
        );
    }

    /// A bind that never confirms within the timeout must also be `Failed`, so
    /// `Running` is only ever emitted after a *confirmed* bind (GAP G3, #1145).
    #[test]
    fn bind_timeout_signal_yields_failed() {
        let outcome = decide_bind_outcome(Err(mpsc::RecvTimeoutError::Timeout));
        assert!(
            matches!(outcome, BindOutcome::Failed(_)),
            "a timed-out bind is not a confirmed bind, got {outcome:?}"
        );
    }

    /// End-to-end over the real channel: a thread that binds then signals success
    /// must result in `Running`, while a thread that reports a bind error must
    /// not — so no live `active` entry lingers on failure (GAP G3, #1145).
    #[test]
    fn real_channel_success_and_failure_paths() {
        // Success path: sender reports Ok before the (simulated) serve loop.
        let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
        std::thread::spawn(move || {
            let _ = tx.send(Ok(()));
        });
        let outcome = decide_bind_outcome(rx.recv_timeout(BIND_CONFIRM_TIMEOUT));
        assert!(matches!(outcome, BindOutcome::Running));

        // Failure path: sender reports a bind error and the manager must not
        // treat it as running.
        let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
        std::thread::spawn(move || {
            let _ = tx.send(Err("bind failed".to_string()));
        });
        let outcome = decide_bind_outcome(rx.recv_timeout(BIND_CONFIRM_TIMEOUT));
        assert!(matches!(outcome, BindOutcome::Failed(_)));
    }

    /// A freshly-spawned server whose error slot is still empty is live and must
    /// block a second, concurrent start with "already running".
    #[test]
    fn active_entry_without_error_is_live() {
        let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        assert!(
            active_entry_is_live(&error),
            "a running server (no error recorded) must count as live"
        );
    }

    /// GAP G2/G9: once a server thread has failed at runtime its `active` entry is
    /// a dead husk — `active_entry_is_live` must report `false` so `start_server`
    /// no longer rejects a retry with "already running". This makes `Error →
    /// Stopped` real and Start/Retry work again, while `get_states` still surfaces
    /// the recorded error until the retry happens.
    #[test]
    fn errored_active_entry_is_not_live_so_start_is_allowed() {
        let error: Arc<Mutex<Option<String>>> =
            Arc::new(Mutex::new(Some("Port 8080 is already in use".to_string())));
        assert!(
            !active_entry_is_live(&error),
            "a server whose error slot is set must NOT count as live, so a retry \
             (start_server) is allowed instead of being blocked as 'already running'"
        );
    }

    /// GAP G6, #1145: the status payload broadcast on
    /// `embedded-server-status-changed` must carry the *real* live stats and
    /// `started_at` snapshotted from the active entry, not zeroed defaults —
    /// otherwise the sidebar traffic line and uptime always read zero.
    #[test]
    fn status_state_carries_real_stats_and_started_at() {
        let stats = ServerStats {
            active_connections: 2,
            total_connections: 7,
            bytes_sent: 4096,
            bytes_received: 512,
        };
        let started_at = "2024-01-01T00:00:00+00:00".to_string();

        let state = build_status_state(
            "srv-1",
            ServerStatus::Running,
            None,
            stats.clone(),
            Some(started_at.clone()),
        );

        assert_eq!(state.server_id, "srv-1");
        assert_eq!(state.status, ServerStatus::Running);
        assert_eq!(
            state.stats.total_connections, 7,
            "live total_connections must be preserved, not reset to 0"
        );
        assert_eq!(
            state.stats.active_connections, 2,
            "live active_connections must be preserved"
        );
        assert_eq!(state.stats.bytes_sent, 4096, "bytes_sent must be preserved");
        assert_eq!(
            state.stats.bytes_received, 512,
            "bytes_received must be preserved"
        );
        assert_eq!(
            state.started_at,
            Some(started_at),
            "started_at must be carried through so uptime can render (GAP G6)"
        );
    }

    /// When no active entry exists (e.g. a `Stopped` transition after the entry
    /// was removed), the status payload falls back to zeroed stats / no start
    /// time — which is correct, since a stopped server has no live traffic.
    #[test]
    fn status_state_defaults_when_no_active_entry() {
        let state = build_status_state(
            "srv-1",
            ServerStatus::Stopped,
            None,
            ServerStats::default(),
            None,
        );
        assert_eq!(state.status, ServerStatus::Stopped);
        assert_eq!(state.stats.total_connections, 0);
        assert!(state.started_at.is_none());
    }

    /// A port bound at boot must not cause a silent no-op: the auto-start
    /// failure has to surface as an `Error` state carrying the reason so the
    /// sidebar can show the server red at launch (GAP G7, #1145).
    #[test]
    fn auto_start_failure_surfaces_error_state_with_message() {
        // Bind a TCP port so the pre-flight bind check fails deterministically.
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .expect("should bind an ephemeral port for the test");
        let busy_port = listener
            .local_addr()
            .expect("bound listener should expose its address")
            .port();

        let config = EmbeddedServerConfig {
            id: "auto-http".to_string(),
            name: "Auto HTTP".to_string(),
            server_type: ServerType::Http,
            root_directory: ".".to_string(),
            bind_host: "127.0.0.1".to_string(),
            port: busy_port,
            auto_start: true,
            read_only: true,
            directory_listing: None,
            ftp_auth: None,
        };

        // Reproduce the auto-start pre-flight failure: the port is taken.
        let err = EmbeddedServerManager::check_port_config(&config)
            .expect_err("binding an already-bound port must fail");
        let msg = err.to_string();
        assert!(
            msg.contains("already in use"),
            "error should explain the port is busy, got: {msg}"
        );

        // The failure must be turned into a visible Error state, not swallowed.
        let state = auto_start_error_state(&config.id, &msg);
        assert_eq!(state.server_id, "auto-http");
        assert_eq!(state.status, ServerStatus::Error);
        assert_eq!(state.error.as_deref(), Some(msg.as_str()));
        assert!(
            state.error.is_some_and(|e| e.contains("already in use")),
            "surfaced error must carry the reason"
        );

        drop(listener);
    }
}
