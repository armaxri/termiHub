use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

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
            let active = self
                .active
                .lock()
                .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))?;
            if active.contains_key(server_id) {
                return Err(TerminalError::EmbeddedServerError(format!(
                    "Server {server_id} is already running"
                )));
            }
        }

        // Pre-flight bind check so we can return an error immediately.
        self.check_port(&config)?;

        self.emit_status(server_id, ServerStatus::Starting, None);

        let shutdown = Arc::new(AtomicBool::new(false));
        let stats = AtomicServerStats::new();
        let error_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let cfg = config.clone();
        let shutdown_clone = Arc::clone(&shutdown);
        let stats_clone = Arc::clone(&stats);
        let error_clone = Arc::clone(&error_slot);
        let handle_clone = self.app_handle.clone();
        let id = server_id.to_string();

        let thread_handle = thread::spawn(move || {
            let result = match cfg.server_type {
                ServerType::Http => start_http_server(&cfg, shutdown_clone, stats_clone),
                ServerType::Ftp => start_ftp_server(&cfg, shutdown_clone, stats_clone),
                ServerType::Tftp => start_tftp_server(&cfg, shutdown_clone, stats_clone),
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

        let started_at = chrono::Utc::now().to_rfc3339();

        {
            let mut active = self
                .active
                .lock()
                .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))?;
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
                    tracing::warn!(id = %cfg.id, "Failed to auto-start embedded server: {e}");
                }
            }
        }
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /// Attempt a quick bind to check whether the port is available.
    fn check_port(&self, config: &EmbeddedServerConfig) -> Result<(), TerminalError> {
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
