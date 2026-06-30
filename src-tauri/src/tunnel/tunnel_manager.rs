use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter, Manager};
use termihub_core::backends::ssh::auth::connect_and_authenticate_cancellable as core_connect_cancellable;
use termihub_core::backends::ssh::handler::{ForwardedChannelRegistry, SshSession};
use termihub_core::backends::ssh::jump_host::connect_target_through_pooled_gateway;
use termihub_core::backends::ssh::session_pool::{PooledRef, RefPool, SshGateway};
use tokio_util::sync::CancellationToken;

use crate::terminal::backend::SshConfig;

use super::config::{
    TunnelConfig, TunnelState, TunnelStats, TunnelStatus, TunnelStore, TunnelType,
};
use super::connecting::{ConnectingTracker, FinishOutcome};
use super::dynamic_forward::DynamicForwarder;
use super::local_forward::LocalForwarder;
use super::remote_forward::RemoteForwarder;
use super::storage::TunnelStorage;
use crate::connection::manager::ConnectionManager;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_with_registry_cancellable;

/// Drive an async future to completion on the current multi-threaded Tokio
/// runtime from a synchronous context.
///
/// Same runtime-context requirement as the `ssh_auth` helpers (#828): call only
/// from inside `spawn_blocking` or an async task. Used to bridge the synchronous
/// tunnel build path to the async session-pool / jump-host connect APIs.
fn block_on_runtime<F: std::future::Future>(fut: F) -> F::Output {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(fut))
}

/// RAII holder for the pool references a tunnel's SSH session(s) depend on.
///
/// Dropping it returns the references to their pools, draining sessions no
/// longer used by any tunnel or terminal.
///
/// The fields are never read — they are held purely so their `Drop` releases the
/// pool reference when the tunnel is torn down (RAII).
#[derive(Default)]
#[allow(dead_code)]
struct PooledSessionGuards {
    /// Pooled endpoint session, shared by local/dynamic forwarders on the same
    /// connection. `None` when the endpoint is reached through a jump host.
    endpoint: Option<PooledRef<Arc<SshSession>>>,
    /// Pooled jump-host gateway session shared across all connections that use
    /// the same bastion. `None` for direct (non-jump) connections.
    gateway: Option<PooledRef<Arc<SshGateway>>>,
}

impl PooledSessionGuards {
    /// Hold a pooled per-connection endpoint session.
    fn endpoint(endpoint: PooledRef<Arc<SshSession>>) -> Self {
        Self {
            endpoint: Some(endpoint),
            gateway: None,
        }
    }

    /// Hold a pooled jump-host gateway session.
    fn gateway(gateway: PooledRef<Arc<SshGateway>>) -> Self {
        Self {
            endpoint: None,
            gateway: Some(gateway),
        }
    }
}

/// An active tunnel with its forwarder.
enum ActiveForwarder {
    Local(LocalForwarder),
    Remote(RemoteForwarder),
    Dynamic(DynamicForwarder),
}

/// An active tunnel instance.
struct ActiveTunnel {
    forwarder: ActiveForwarder,
    /// Pool references kept alive for the tunnel's lifetime; dropped on teardown
    /// to release the shared endpoint / gateway sessions.
    guards: PooledSessionGuards,
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
    /// Pool of SSH endpoint sessions shared by local/dynamic forwarders on the
    /// same connection. Jump-host gateway sessions are pooled separately in the
    /// process-wide [`shared_gateway_pool`](termihub_core::backends::ssh::session_pool::shared_gateway_pool).
    endpoint_pool: Arc<RefPool<Arc<SshSession>>>,
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
            endpoint_pool: RefPool::new(),
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

        // Mark as connecting so a Stop click during the handshake can cancel
        // this start before it is registered as active (#829). The returned
        // token is threaded into the SSH connect so a Stop aborts an in-flight
        // handshake promptly rather than waiting it out (#841).
        let cancel = self.connecting.begin(tunnel_id).ok_or_else(|| {
            TerminalError::TunnelError(format!("Tunnel {} is already connecting", tunnel_id))
        })?;

        // Emit connecting status
        self.emit_status(tunnel_id, TunnelStatus::Connecting, None);

        // Build the forwarder (resolves the SSH config and performs the
        // handshake). On failure, surface it as `error` status instead of
        // leaving the tunnel stuck in `connecting` (#829) — unless a Stop was
        // requested mid-connect, in which case it has already gone disconnected.
        let (forwarder, guards) = match self.build_forwarder(&config, cancel) {
            Ok(built) => built,
            Err(e) => {
                match self.connecting.finish(tunnel_id) {
                    FinishOutcome::Cancel => {
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
            self.teardown_forwarder(forwarder, guards);
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
            active.insert(tunnel_id.to_string(), ActiveTunnel { forwarder, guards });
        }

        // Emit connected status
        self.emit_status(tunnel_id, TunnelStatus::Connected, None);

        tracing::info!("Tunnel {} started", tunnel_id);
        Ok(())
    }

    /// Build the forwarder for a tunnel config, performing the SSH handshake.
    ///
    /// Returns the forwarder together with the pool references it depends on
    /// (endpoint and/or jump-host gateway). The references are returned rather
    /// than released here: the caller stores them on the [`ActiveTunnel`] (RAII)
    /// so they live exactly as long as the tunnel. If the forwarder fails to
    /// start, the `?` propagation drops the guards and releases the references,
    /// so the pool ref counts never leak.
    fn build_forwarder(
        &self,
        config: &TunnelConfig,
        cancel: CancellationToken,
    ) -> Result<(ActiveForwarder, PooledSessionGuards), TerminalError> {
        let ssh_config = self.resolve_ssh_config(&config.ssh_connection_id)?;
        let conn_id = &config.ssh_connection_id;
        let jumped = !ssh_config.proxy_jump.is_empty();

        match &config.tunnel_type {
            TunnelType::Local(local_config) => {
                let (session, guards) =
                    self.acquire_endpoint(conn_id, &ssh_config, cancel, jumped)?;
                let f = LocalForwarder::start(local_config, session).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to start local forwarder: {}", e))
                })?;
                Ok((ActiveForwarder::Local(f), guards))
            }
            TunnelType::Dynamic(dynamic_config) => {
                let (session, guards) =
                    self.acquire_endpoint(conn_id, &ssh_config, cancel, jumped)?;
                let f = DynamicForwarder::start(dynamic_config, session).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to start dynamic forwarder: {}", e))
                })?;
                Ok((ActiveForwarder::Dynamic(f), guards))
            }
            TunnelType::Remote(remote_config) => {
                // Remote forwarding needs tcpip_forward (&mut SshSession), so it always gets
                // a dedicated connection rather than a pooled shared Arc<SshSession>.
                let (session, registry, guards) =
                    self.acquire_dedicated(&ssh_config, cancel, jumped)?;
                let f = RemoteForwarder::start(remote_config, session, registry).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to start remote forwarder: {}", e))
                })?;
                Ok((ActiveForwarder::Remote(f), guards))
            }
        }
    }

    /// Acquire the SSH session a local/dynamic forwarder runs over.
    ///
    /// Without a jump host the session is pooled by connection id and shared with
    /// the other local/dynamic forwarders on the same connection. With a jump
    /// host the target is reached over a shared, pooled gateway session (held by
    /// the returned guards) — the gateway is shared across connections, while the
    /// per-tunnel endpoint session itself is dedicated.
    fn acquire_endpoint(
        &self,
        conn_id: &str,
        ssh_config: &SshConfig,
        cancel: CancellationToken,
        jumped: bool,
    ) -> Result<(Arc<SshSession>, PooledSessionGuards), TerminalError> {
        if jumped {
            let (session, _registry, gateway) = self.connect_through_gateway(ssh_config, cancel)?;
            Ok((Arc::new(session), PooledSessionGuards::gateway(gateway)))
        } else {
            let endpoint =
                block_on_runtime(self.endpoint_pool.get_or_create(conn_id, || async move {
                    core_connect_cancellable(ssh_config, Some(cancel))
                        .await
                        .map(|(session, _registry)| Arc::new(session))
                        .map_err(|e| TerminalError::SshError(e.to_string()))
                }))?;
            let session = (*endpoint).clone();
            Ok((session, PooledSessionGuards::endpoint(endpoint)))
        }
    }

    /// Acquire a dedicated (non-pooled) SSH session for a remote forwarder,
    /// connecting through a shared pooled gateway when a jump host is configured.
    fn acquire_dedicated(
        &self,
        ssh_config: &SshConfig,
        cancel: CancellationToken,
        jumped: bool,
    ) -> Result<(SshSession, ForwardedChannelRegistry, PooledSessionGuards), TerminalError> {
        if jumped {
            let (session, registry, gateway) = self.connect_through_gateway(ssh_config, cancel)?;
            Ok((session, registry, PooledSessionGuards::gateway(gateway)))
        } else {
            let (session, registry) = connect_with_registry_cancellable(ssh_config, cancel)
                .map_err(|e| TerminalError::TunnelError(format!("SSH connect failed: {}", e)))?;
            Ok((session, registry, PooledSessionGuards::default()))
        }
    }

    /// Connect to the target through its pooled jump-host gateway, abortable via
    /// `cancel` (#841) so a Stop during the handshake is honoured promptly.
    fn connect_through_gateway(
        &self,
        ssh_config: &SshConfig,
        cancel: CancellationToken,
    ) -> Result<
        (
            SshSession,
            ForwardedChannelRegistry,
            PooledRef<Arc<SshGateway>>,
        ),
        TerminalError,
    > {
        block_on_runtime(async move {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    Err(TerminalError::TunnelError("SSH connect cancelled".to_string()))
                }
                res = connect_target_through_pooled_gateway(ssh_config, Some(&cancel)) => {
                    res.map_err(|e| TerminalError::SshError(e.to_string()))
                }
            }
        })
    }

    /// Stop a forwarder and release the pool references it held.
    fn teardown_forwarder(&self, mut forwarder: ActiveForwarder, guards: PooledSessionGuards) {
        match &mut forwarder {
            ActiveForwarder::Local(f) => f.stop(),
            ActiveForwarder::Remote(f) => f.stop(),
            ActiveForwarder::Dynamic(f) => f.stop(),
        }
        // Dropping the guards (at end of scope) releases the pooled endpoint /
        // gateway references, draining sessions no longer used by any tunnel or
        // terminal.
        drop(guards);
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
            let ActiveTunnel { forwarder, guards } = tunnel;
            self.teardown_forwarder(forwarder, guards);
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
