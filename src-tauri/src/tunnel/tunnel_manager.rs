use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter, Manager};

use super::config::{
    TunnelConfig, TunnelState, TunnelStats, TunnelStatus, TunnelStore, TunnelType,
};
use super::connecting::{ConnectingTracker, FinishOutcome};
use super::dynamic_forward::DynamicForwarder;
use super::local_forward::LocalForwarder;
use super::remote_forward::RemoteForwarder;
use super::session_pool::SshSessionPool;
use super::storage::TunnelStorage;
use crate::connection::manager::ConnectionManager;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_with_registry;

/// An active tunnel with its forwarder.
enum ActiveForwarder {
    Local(LocalForwarder),
    Remote(RemoteForwarder),
    Dynamic(DynamicForwarder),
}

/// An active tunnel instance.
struct ActiveTunnel {
    forwarder: ActiveForwarder,
    ssh_connection_id: String,
}

/// Central manager for SSH tunnels.
///
/// Handles CRUD operations on tunnel configurations, starting/stopping tunnels,
/// and tracking live tunnel state.
pub struct TunnelManager {
    tunnel_configs: Mutex<TunnelStore>,
    storage: TunnelStorage,
    active_tunnels: Mutex<HashMap<String, ActiveTunnel>>,
    connecting: ConnectingTracker,
    session_pool: Mutex<SshSessionPool>,
    app_handle: AppHandle,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl TunnelManager {
    /// Create a new TunnelManager, loading saved tunnels from disk.
    /// Uses recovery loading to handle corrupt files gracefully.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage =
            TunnelStorage::new(app_handle).context("Failed to initialize tunnel storage")?;
        let result = storage
            .load_with_recovery()
            .context("Failed to load tunnels")?;

        Ok(Self {
            tunnel_configs: Mutex::new(result.data),
            storage,
            active_tunnels: Mutex::new(HashMap::new()),
            connecting: ConnectingTracker::new(),
            session_pool: Mutex::new(SshSessionPool::new()),
            app_handle: app_handle.clone(),
            recovery_warnings: Mutex::new(result.warnings),
        })
    }

    /// Drain and return any recovery warnings collected during initialization.
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| w.drain(..).collect())
            .unwrap_or_default()
    }

    /// Get all saved tunnel configurations.
    pub fn get_tunnels(&self) -> Result<Vec<TunnelConfig>, TerminalError> {
        let store = self
            .tunnel_configs
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
        Ok(store.tunnels.clone())
    }

    /// Save (add or update) a tunnel configuration.
    pub fn save_tunnel(&self, config: TunnelConfig) -> Result<(), TerminalError> {
        let mut store = self
            .tunnel_configs
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;

        if let Some(existing) = store.tunnels.iter_mut().find(|t| t.id == config.id) {
            *existing = config;
        } else {
            store.tunnels.push(config);
        }

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::TunnelError(format!("Failed to save tunnels: {}", e)))?;

        Ok(())
    }

    /// Delete a tunnel configuration. Stops the tunnel first if active.
    pub fn delete_tunnel(&self, tunnel_id: &str) -> Result<(), TerminalError> {
        // Stop if active
        self.stop_tunnel(tunnel_id)?;

        let mut store = self
            .tunnel_configs
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;

        store.tunnels.retain(|t| t.id != tunnel_id);

        self.storage
            .save(&store)
            .map_err(|e| TerminalError::TunnelError(format!("Failed to save tunnels: {}", e)))?;

        Ok(())
    }

    /// Get the current status of all tunnels.
    pub fn get_statuses(&self) -> Result<Vec<TunnelState>, TerminalError> {
        let store = self
            .tunnel_configs
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
        let active = self
            .active_tunnels
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;

        let states = store
            .tunnels
            .iter()
            .map(|config| {
                if let Some(tunnel) = active.get(&config.id) {
                    let stats = match &tunnel.forwarder {
                        ActiveForwarder::Local(f) => f.get_stats(),
                        ActiveForwarder::Remote(f) => f.get_stats(),
                        ActiveForwarder::Dynamic(f) => f.get_stats(),
                    };
                    TunnelState {
                        tunnel_id: config.id.clone(),
                        status: TunnelStatus::Connected,
                        error: None,
                        stats,
                    }
                } else {
                    let status = if self.connecting.is_connecting(&config.id) {
                        TunnelStatus::Connecting
                    } else {
                        TunnelStatus::Disconnected
                    };
                    TunnelState {
                        tunnel_id: config.id.clone(),
                        status,
                        error: None,
                        stats: TunnelStats::default(),
                    }
                }
            })
            .collect();

        Ok(states)
    }

    /// Start a tunnel by ID.
    pub fn start_tunnel(&self, tunnel_id: &str) -> Result<(), TerminalError> {
        // Get tunnel config
        let config = {
            let store = self
                .tunnel_configs
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            store
                .tunnels
                .iter()
                .find(|t| t.id == tunnel_id)
                .cloned()
                .ok_or_else(|| {
                    TerminalError::TunnelError(format!("Tunnel not found: {}", tunnel_id))
                })?
        };

        // Check if already active
        {
            let active = self
                .active_tunnels
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            if active.contains_key(tunnel_id) {
                return Err(TerminalError::TunnelError(format!(
                    "Tunnel {} is already active",
                    tunnel_id
                )));
            }
        }

        // Mark as connecting so a Stop click during the (blocking) handshake can
        // cancel this start before it is registered as active (#829).
        if !self.connecting.begin(tunnel_id) {
            return Err(TerminalError::TunnelError(format!(
                "Tunnel {} is already connecting",
                tunnel_id
            )));
        }

        // Emit connecting status
        self.emit_status(tunnel_id, TunnelStatus::Connecting, None);

        // Build the forwarder (resolves the SSH config and performs the
        // handshake). On failure, surface it as `error` status instead of
        // leaving the tunnel stuck in `connecting` (#829) — unless a Stop was
        // requested mid-connect, in which case it has already gone disconnected.
        let forwarder = match self.build_forwarder(&config) {
            Ok(f) => f,
            Err(e) => {
                match self.connecting.finish(tunnel_id) {
                    FinishOutcome::Cancelled | FinishOutcome::Gone => {
                        self.emit_status(tunnel_id, TunnelStatus::Disconnected, None);
                    }
                    FinishOutcome::Commit => {
                        self.emit_status(tunnel_id, TunnelStatus::Error, Some(e.to_string()));
                    }
                }
                return Err(e);
            }
        };

        // Honour a Stop requested while connecting: tear the just-built
        // forwarder down rather than leaving an orphaned tunnel the user
        // thought they had stopped.
        if !matches!(self.connecting.finish(tunnel_id), FinishOutcome::Commit) {
            self.teardown_forwarder(forwarder, &config.ssh_connection_id);
            self.emit_status(tunnel_id, TunnelStatus::Disconnected, None);
            tracing::info!("Tunnel {} start cancelled by stop request", tunnel_id);
            return Ok(());
        }

        // Register as active
        {
            let mut active = self
                .active_tunnels
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            active.insert(
                tunnel_id.to_string(),
                ActiveTunnel {
                    forwarder,
                    ssh_connection_id: config.ssh_connection_id.clone(),
                },
            );
        }

        // Emit connected status
        self.emit_status(tunnel_id, TunnelStatus::Connected, None);

        tracing::info!("Tunnel {} started", tunnel_id);
        Ok(())
    }

    /// Build the forwarder for a tunnel config, performing the SSH handshake.
    ///
    /// For local/dynamic tunnels a pooled session reference is taken; if the
    /// forwarder then fails to start, the reference is released so the pool's
    /// ref count does not leak.
    fn build_forwarder(&self, config: &TunnelConfig) -> Result<ActiveForwarder, TerminalError> {
        let ssh_config = self.resolve_ssh_config(&config.ssh_connection_id)?;

        match &config.tunnel_type {
            TunnelType::Local(local_config) => {
                let (session, _registry) = {
                    let mut pool = self
                        .session_pool
                        .lock()
                        .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
                    pool.get_or_create(&config.ssh_connection_id, &ssh_config)?
                };
                match LocalForwarder::start(local_config, session) {
                    Ok(f) => Ok(ActiveForwarder::Local(f)),
                    Err(e) => {
                        self.release_session(&config.ssh_connection_id);
                        Err(TerminalError::TunnelError(format!(
                            "Failed to start local forwarder: {}",
                            e
                        )))
                    }
                }
            }
            TunnelType::Remote(remote_config) => {
                // Remote forwarding needs tcpip_forward (&mut SshSession), so it always gets
                // a dedicated connection rather than a pooled shared Arc<SshSession>.
                let (session, registry) = connect_with_registry(&ssh_config).map_err(|e| {
                    TerminalError::TunnelError(format!("SSH connect failed: {}", e))
                })?;
                let f = RemoteForwarder::start(remote_config, session, registry).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to start remote forwarder: {}", e))
                })?;
                Ok(ActiveForwarder::Remote(f))
            }
            TunnelType::Dynamic(dynamic_config) => {
                let (session, _registry) = {
                    let mut pool = self
                        .session_pool
                        .lock()
                        .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
                    pool.get_or_create(&config.ssh_connection_id, &ssh_config)?
                };
                match DynamicForwarder::start(dynamic_config, session) {
                    Ok(f) => Ok(ActiveForwarder::Dynamic(f)),
                    Err(e) => {
                        self.release_session(&config.ssh_connection_id);
                        Err(TerminalError::TunnelError(format!(
                            "Failed to start dynamic forwarder: {}",
                            e
                        )))
                    }
                }
            }
        }
    }

    /// Stop a forwarder and release its pooled SSH session reference.
    ///
    /// Releasing is a no-op for remote forwards (they own a dedicated session
    /// not held by the pool), so it is safe to call uniformly.
    fn teardown_forwarder(&self, mut forwarder: ActiveForwarder, ssh_connection_id: &str) {
        match &mut forwarder {
            ActiveForwarder::Local(f) => f.stop(),
            ActiveForwarder::Remote(f) => f.stop(),
            ActiveForwarder::Dynamic(f) => f.stop(),
        }
        self.release_session(ssh_connection_id);
    }

    /// Release one pooled SSH session reference, ignoring a poisoned lock.
    fn release_session(&self, ssh_connection_id: &str) {
        if let Ok(mut pool) = self.session_pool.lock() {
            pool.release(ssh_connection_id);
        }
    }

    /// Stop an active tunnel by ID.
    pub fn stop_tunnel(&self, tunnel_id: &str) -> Result<(), TerminalError> {
        let tunnel = {
            let mut active = self
                .active_tunnels
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            active.remove(tunnel_id)
        };

        if let Some(tunnel) = tunnel {
            let ActiveTunnel {
                forwarder,
                ssh_connection_id,
            } = tunnel;
            self.teardown_forwarder(forwarder, &ssh_connection_id);
            self.emit_status(tunnel_id, TunnelStatus::Disconnected, None);
            tracing::info!("Tunnel {} stopped", tunnel_id);
            return Ok(());
        }

        // Not active yet — it may still be mid-connect. Flag the in-flight start
        // to cancel and tell the UI it has stopped so the Stop click is not lost
        // (#829). The start path tears the forwarder down once the blocking
        // handshake completes.
        if self.connecting.request_cancel(tunnel_id) {
            self.emit_status(tunnel_id, TunnelStatus::Disconnected, None);
            tracing::info!("Tunnel {} stop requested while connecting", tunnel_id);
        }

        Ok(())
    }

    /// Stop all active tunnels (used during app shutdown).
    pub fn stop_all(&self) {
        let tunnels: Vec<String> = {
            let active = match self.active_tunnels.lock() {
                Ok(a) => a,
                Err(_) => return,
            };
            active.keys().cloned().collect()
        };

        for tunnel_id in tunnels {
            if let Err(e) = self.stop_tunnel(&tunnel_id) {
                tracing::error!("Failed to stop tunnel {}: {}", tunnel_id, e);
            }
        }
    }

    /// Start all tunnels marked with `auto_start: true`.
    pub fn start_auto_tunnels(&self) {
        let tunnels = match self.get_tunnels() {
            Ok(t) => t,
            Err(e) => {
                tracing::error!("Failed to load tunnels for auto-start: {}", e);
                return;
            }
        };

        for tunnel in tunnels {
            if tunnel.auto_start {
                if let Err(e) = self.start_tunnel(&tunnel.id) {
                    tracing::warn!("Failed to auto-start tunnel {}: {}", tunnel.name, e);
                }
            }
        }
    }

    /// Resolve an SSH connection ID to its SshConfig.
    fn resolve_ssh_config(
        &self,
        connection_id: &str,
    ) -> Result<crate::terminal::backend::SshConfig, TerminalError> {
        let conn_mgr = self
            .app_handle
            .try_state::<ConnectionManager>()
            .ok_or_else(|| {
                TerminalError::TunnelError("ConnectionManager not available".to_string())
            })?;

        let store = conn_mgr.get_all().map_err(|e| {
            TerminalError::TunnelError(format!("Failed to load connections: {}", e))
        })?;

        let conn = store
            .connections
            .iter()
            .find(|c| c.id == connection_id)
            .ok_or_else(|| {
                TerminalError::TunnelError(format!("SSH connection not found: {}", connection_id))
            })?;

        if conn.config.type_id != "ssh" {
            return Err(TerminalError::TunnelError(format!(
                "Connection {} is not an SSH connection",
                connection_id
            )));
        }

        serde_json::from_value(conn.config.settings.clone()).map_err(|e| {
            TerminalError::TunnelError(format!(
                "Failed to parse SSH config for connection {}: {}",
                connection_id, e
            ))
        })
    }

    /// Emit a tunnel status change event to the frontend.
    fn emit_status(&self, tunnel_id: &str, status: TunnelStatus, error: Option<String>) {
        let state = TunnelState {
            tunnel_id: tunnel_id.to_string(),
            status,
            error,
            stats: TunnelStats::default(),
        };
        let _ = self.app_handle.emit("tunnel-status-changed", &state);
    }
}
