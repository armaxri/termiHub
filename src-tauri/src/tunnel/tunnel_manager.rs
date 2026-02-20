use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter, Manager};

use super::config::{
    TunnelConfig, TunnelState, TunnelStats, TunnelStatus, TunnelStore, TunnelType,
};
use super::dynamic_forward::DynamicForwarder;
use super::local_forward::LocalForwarder;
use super::remote_forward::RemoteForwarder;
use super::session_pool::SshSessionPool;
use super::storage::TunnelStorage;
use crate::connection::manager::ConnectionManager;
use crate::terminal::backend::ConnectionConfig;
use crate::utils::errors::TerminalError;

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
    session_pool: Mutex<SshSessionPool>,
    app_handle: AppHandle,
}

impl TunnelManager {
    /// Create a new TunnelManager, loading saved tunnels from disk.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage =
            TunnelStorage::new(app_handle).context("Failed to initialize tunnel storage")?;
        let store = storage.load().context("Failed to load tunnels")?;

        Ok(Self {
            tunnel_configs: Mutex::new(store),
            storage,
            active_tunnels: Mutex::new(HashMap::new()),
            session_pool: Mutex::new(SshSessionPool::new()),
            app_handle: app_handle.clone(),
        })
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
                    TunnelState {
                        tunnel_id: config.id.clone(),
                        status: TunnelStatus::Disconnected,
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

        // Emit connecting status
        self.emit_status(tunnel_id, TunnelStatus::Connecting, None);

        // Look up the SSH connection config
        let ssh_config = self.resolve_ssh_config(&config.ssh_connection_id)?;

        // Get or create SSH session from pool
        let session = {
            let mut pool = self
                .session_pool
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            pool.get_or_create(&config.ssh_connection_id, &ssh_config)?
        };

        // Start the appropriate forwarder
        let forwarder = match &config.tunnel_type {
            TunnelType::Local(local_config) => {
                let f = LocalForwarder::start(local_config, session).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to start local forwarder: {}", e))
                })?;
                ActiveForwarder::Local(f)
            }
            TunnelType::Remote(remote_config) => {
                let f = RemoteForwarder::start(remote_config, session).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to start remote forwarder: {}", e))
                })?;
                ActiveForwarder::Remote(f)
            }
            TunnelType::Dynamic(dynamic_config) => {
                let f = DynamicForwarder::start(dynamic_config, session).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to start dynamic forwarder: {}", e))
                })?;
                ActiveForwarder::Dynamic(f)
            }
        };

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

    /// Stop an active tunnel by ID.
    pub fn stop_tunnel(&self, tunnel_id: &str) -> Result<(), TerminalError> {
        let tunnel = {
            let mut active = self
                .active_tunnels
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            active.remove(tunnel_id)
        };

        if let Some(mut tunnel) = tunnel {
            match &mut tunnel.forwarder {
                ActiveForwarder::Local(f) => f.stop(),
                ActiveForwarder::Remote(f) => f.stop(),
                ActiveForwarder::Dynamic(f) => f.stop(),
            }

            // Release session from pool
            let mut pool = self
                .session_pool
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            pool.release(&tunnel.ssh_connection_id);

            // Emit disconnected status
            self.emit_status(tunnel_id, TunnelStatus::Disconnected, None);

            tracing::info!("Tunnel {} stopped", tunnel_id);
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

        let store = conn_mgr
            .get_all()
            .map_err(|e| TerminalError::TunnelError(format!("Failed to load connections: {}", e)))?;

        let conn = store.connections
            .iter()
            .find(|c| c.id == connection_id)
            .ok_or_else(|| {
                TerminalError::TunnelError(format!(
                    "SSH connection not found: {}",
                    connection_id
                ))
            })?;

        match &conn.config {
            ConnectionConfig::Ssh(ssh_config) => Ok(ssh_config.clone()),
            _ => Err(TerminalError::TunnelError(format!(
                "Connection {} is not an SSH connection",
                connection_id
            ))),
        }
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
