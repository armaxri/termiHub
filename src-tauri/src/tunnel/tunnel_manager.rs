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

/// Record a tunnel's last error into the persisted per-tunnel error map.
///
/// Set on the failing `Error` branch of a start so the failure becomes a
/// durable, queryable resting state (GAP 3, #1238). Poison-safe: a poisoned
/// mutex silently no-ops rather than panicking, consistent with the manager's
/// other lock handling.
fn record_last_error(errors: &Mutex<HashMap<String, String>>, tunnel_id: &str, error: String) {
    if let Ok(mut map) = errors.lock() {
        map.insert(tunnel_id.to_string(), error);
    }
}

/// Clear a tunnel's persisted last error (on a successful start or an explicit
/// stop), returning it to the "never failed" resting state.
fn clear_last_error(errors: &Mutex<HashMap<String, String>>, tunnel_id: &str) {
    if let Ok(mut map) = errors.lock() {
        map.remove(tunnel_id);
    }
}

/// Look up a tunnel's persisted last error, if any. Reading never mutates the
/// map, so repeated `get_statuses` calls (a reload) keep reporting `Error`.
fn last_error_for(errors: &Mutex<HashMap<String, String>>, tunnel_id: &str) -> Option<String> {
    errors
        .lock()
        .ok()
        .and_then(|map| map.get(tunnel_id).cloned())
}

/// Resolve the resting (non-active) status of a tunnel from its transient
/// connecting state and any persisted last error.
///
/// Precedence: an in-flight connect wins over a stale error; otherwise a
/// recorded failure surfaces as `Error` carrying its message, and only the
/// absence of both is a plain `Disconnected`. This is what distinguishes
/// "never started" (no error entry) from "died with an error" (entry present).
fn resting_status(
    is_connecting: bool,
    last_error: Option<String>,
) -> (TunnelStatus, Option<String>) {
    if is_connecting {
        (TunnelStatus::Connecting, None)
    } else if let Some(error) = last_error {
        (TunnelStatus::Error, Some(error))
    } else {
        (TunnelStatus::Disconnected, None)
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
    /// Last error per tunnel id, making a failed start a durable, queryable
    /// resting state that survives a `loadTunnels` reload (GAP 3, #1238). An
    /// entry is set when a start fails and committed (not cancelled), and
    /// cleared on a successful start or an explicit stop.
    last_errors: Mutex<HashMap<String, String>>,
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
            last_errors: Mutex::new(HashMap::new()),
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
                    // A tunnel that is neither active nor connecting rests as
                    // either `Disconnected` (never failed) or `Error` (its last
                    // start failed) — the latter carries the recorded message so
                    // it survives a reload instead of being laundered back to
                    // `Disconnected` (GAP 3, #1238).
                    let (status, error) = resting_status(
                        self.connecting.is_connecting(&config.id),
                        last_error_for(&self.last_errors, &config.id),
                    );
                    TunnelState {
                        tunnel_id: config.id.clone(),
                        status,
                        error,
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
                        // Persist the failure so `Error` is a durable, queryable
                        // resting state, not just a fire-and-forget event that a
                        // reload launders away (GAP 3, #1238).
                        record_last_error(&self.last_errors, tunnel_id, e.to_string());
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

        // A successful start clears any recorded failure so the tunnel no longer
        // rests in `Error` once it is running again (GAP 3, #1238).
        clear_last_error(&self.last_errors, tunnel_id);

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
        // An explicit stop dismisses any recorded failure, returning the tunnel
        // from the `Error` resting state to `Disconnected` (GAP 3, #1238).
        clear_last_error(&self.last_errors, tunnel_id);

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

        // Expand any saved-connection jump-host references to inline hops before
        // core parses the chain (it only connects with inline hops) — #940.
        let mut settings = conn.config.settings.clone();
        conn_mgr
            .resolve_jump_host_refs(&mut settings, Some(connection_id))
            .map_err(|e| TerminalError::TunnelError(e.to_string()))?;

        serde_json::from_value(settings).map_err(|e| {
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

#[cfg(test)]
mod tests {
    //! Regression tests for the Stop-during-connect teardown path (GAP 8 of the
    //! SSH tunnel state-machine audit, umbrella #1141).
    //!
    //! Driving the full [`TunnelManager::start_tunnel`] path in a unit test is not
    //! feasible: it needs a live Tauri `AppHandle` (for `ConnectionManager`
    //! resolution + event emission) and a real SSH handshake (`build_forwarder`
    //! ultimately dials a russh session — `SshSession` is
    //! `russh::client::Handle<..>` and cannot be fabricated without a server), and
    //! `src-tauri` has no Tauri-mock harness. So these tests reproduce the exact
    //! Stop-during-connect **teardown sequence** the manager performs, using the
    //! same production building blocks it holds — the [`ConnectingTracker`]
    //! cancellation decision and the [`RefPool`] pooled-session guards whose RAII
    //! `Drop` drains the pool in [`TunnelManager::teardown_forwarder`].
    //!
    //! GAP 8 asks specifically: after a Stop issued while a tunnel is still
    //! `connecting`, `active_tunnels` and any pooled endpoint/gateway ref counts
    //! must return to zero. The audit concluded the behavior is already correct;
    //! these tests lock it in so a future refactor of the connect/teardown wiring
    //! cannot silently reintroduce a leak.

    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::super::connecting::{ConnectingTracker, FinishOutcome};
    use super::{clear_last_error, last_error_for, record_last_error, resting_status};
    use crate::tunnel::config::TunnelStatus;
    use termihub_core::backends::ssh::session_pool::{PooledRef, RefPool};

    /// Stand-in for a pooled `Arc<SshSession>` that records when the underlying
    /// value is dropped, so we can assert the session is actually torn down (not
    /// merely un-referenced by the map) after teardown.
    struct TrackedSession {
        live: Arc<AtomicUsize>,
    }

    impl TrackedSession {
        fn new(live: &Arc<AtomicUsize>) -> Arc<Self> {
            live.fetch_add(1, Ordering::SeqCst);
            Arc::new(Self { live: live.clone() })
        }
    }

    impl Drop for TrackedSession {
        fn drop(&mut self) {
            self.live.fetch_sub(1, Ordering::SeqCst);
        }
    }

    /// Minimal stand-in for the pool guards the manager attaches to an
    /// `ActiveTunnel`, mirroring `PooledSessionGuards`: dropping it releases the
    /// pooled endpoint reference (RAII), exactly like `teardown_forwarder`.
    struct EndpointGuard {
        _endpoint: PooledRef<Arc<TrackedSession>>,
    }

    const CONN_ID: &str = "conn-1";
    const TUNNEL_ID: &str = "tunnel-1";

    /// Acquire a pooled endpoint reference the way `acquire_endpoint` does for the
    /// non-jumped local/dynamic path (single-flight `get_or_create` keyed by
    /// connection id), wrapping it in a guard whose drop releases it.
    async fn acquire_guard(
        pool: &Arc<RefPool<Arc<TrackedSession>>>,
        live: &Arc<AtomicUsize>,
    ) -> EndpointGuard {
        let endpoint = pool
            .get_or_create(CONN_ID, || async {
                Ok::<_, std::convert::Infallible>(TrackedSession::new(live))
            })
            .await
            .expect("infallible connect");
        EndpointGuard {
            _endpoint: endpoint,
        }
    }

    /// GAP 8: a Stop cancel that arrives *before* the forwarder finishes building
    /// must make `finish()` report `Cancel`, so the start never inserts into
    /// `active_tunnels` — the active set stays empty and the pool never grows.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_before_build_completes_leaves_active_and_pool_empty() {
        let tracker = ConnectingTracker::new();
        let pool = RefPool::<Arc<TrackedSession>>::new();
        let live = Arc::new(AtomicUsize::new(0));
        // Stand-in for TunnelManager::active_tunnels — only membership matters here.
        // On the cancel branch nothing is ever inserted, so no `mut` is needed.
        let active_tunnels: HashMap<String, EndpointGuard> = HashMap::new();

        // start_tunnel: mark connecting, then a Stop arrives mid-handshake.
        let _cancel = tracker.begin(TUNNEL_ID).expect("first begin");
        assert!(tracker.is_connecting(TUNNEL_ID));

        // stop_tunnel while still connecting: not in the active map, so it cancels
        // the in-flight connect via the tracker instead.
        assert!(
            !active_tunnels.contains_key(TUNNEL_ID),
            "not active yet during connect"
        );
        assert!(
            tracker.request_cancel(TUNNEL_ID),
            "stop must flag the in-flight start"
        );

        // The connect aborts before build_forwarder produces anything; the start
        // path observes Cancel and does NOT insert into active_tunnels.
        assert_eq!(tracker.finish(TUNNEL_ID), FinishOutcome::Cancel);
        // (no active insert on the Cancel branch)

        assert!(
            active_tunnels.is_empty(),
            "active_tunnels must stay empty after Stop-during-connect"
        );
        assert!(
            pool.is_empty(),
            "pool must never grow when the connect was cancelled before building"
        );
        assert_eq!(pool.ref_count(CONN_ID), 0);
        assert_eq!(live.load(Ordering::SeqCst), 0, "no session was created");
        assert!(
            !tracker.is_connecting(TUNNEL_ID),
            "finish clears the tracker"
        );
    }

    /// GAP 8 residual-risk case: `build_forwarder` *wins the race* and produces a
    /// forwarder (with a pooled endpoint session already created) before the Stop
    /// cancel is observed. `start_tunnel` then sees `finish() != Commit`, calls
    /// `teardown_forwarder` (dropping the guards) and returns without inserting
    /// into `active_tunnels`. Assert both counts return to zero.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_after_build_wins_race_tears_pool_back_to_zero() {
        let tracker = ConnectingTracker::new();
        let pool = RefPool::<Arc<TrackedSession>>::new();
        let live = Arc::new(AtomicUsize::new(0));
        // On the cancel branch the forwarder is torn down, never inserted here.
        let active_tunnels: HashMap<String, EndpointGuard> = HashMap::new();

        // start_tunnel: begin connecting.
        let cancel = tracker.begin(TUNNEL_ID).expect("first begin");

        // build_forwarder wins the race: it acquires a pooled endpoint session and
        // produces the guard *before* the cancel is observed.
        let guard = acquire_guard(&pool, &live).await;
        assert_eq!(pool.ref_count(CONN_ID), 1, "endpoint acquired during build");
        assert_eq!(live.load(Ordering::SeqCst), 1, "session created");

        // Meanwhile a Stop arrived while connecting (cancel requested).
        assert!(tracker.request_cancel(TUNNEL_ID));
        cancel.cancel(); // idempotent; mirrors request_cancel firing the token

        // start_tunnel checks finish(): cancelled -> Cancel, so it tears the
        // just-built forwarder down instead of inserting it as active.
        assert_ne!(tracker.finish(TUNNEL_ID), FinishOutcome::Commit);
        // teardown_forwarder: dropping guards releases pooled refs. The
        // active_tunnels insert is skipped on this branch.
        drop(guard);

        assert!(
            active_tunnels.is_empty(),
            "active_tunnels must be empty after Stop-during-connect teardown"
        );
        assert!(
            pool.is_empty(),
            "pooled endpoint ref count must return to zero after teardown"
        );
        assert_eq!(pool.ref_count(CONN_ID), 0);
        assert_eq!(
            live.load(Ordering::SeqCst),
            0,
            "the pooled SSH session must actually be dropped, not just unreferenced"
        );
    }

    /// Sanity contrast: without a Stop the same sequence commits and the tunnel
    /// *does* land in the active map holding its pooled ref — so the zero-after
    /// assertions above are meaningful (they aren't trivially always-empty).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn without_stop_the_endpoint_stays_held_while_active() {
        let tracker = ConnectingTracker::new();
        let pool = RefPool::<Arc<TrackedSession>>::new();
        let live = Arc::new(AtomicUsize::new(0));
        let mut active_tunnels: HashMap<String, EndpointGuard> = HashMap::new();

        tracker.begin(TUNNEL_ID).expect("first begin");
        let guard = acquire_guard(&pool, &live).await;

        // No Stop: finish() commits, so the forwarder is registered as active.
        assert_eq!(tracker.finish(TUNNEL_ID), FinishOutcome::Commit);
        active_tunnels.insert(TUNNEL_ID.to_string(), guard);

        assert_eq!(
            pool.ref_count(CONN_ID),
            1,
            "active tunnel holds its endpoint"
        );
        assert_eq!(live.load(Ordering::SeqCst), 1);

        // A later stop_tunnel removes it from active and drops the guard.
        let removed = active_tunnels.remove(TUNNEL_ID).expect("was active");
        drop(removed); // teardown_forwarder
        assert!(
            pool.is_empty(),
            "pool drains once the active tunnel is stopped"
        );
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }

    // --- GAP 3: persisted, queryable `Error` resting state (#1238) ---------
    //
    // Driving the full `get_statuses` path in a unit test needs a live Tauri
    // `AppHandle` (for storage + event emission), which `src-tauri` has no mock
    // harness for. So — exactly like the teardown tests above — these exercise
    // the production building blocks the manager uses directly: the
    // `last_errors` map helpers (`record_last_error` / `clear_last_error` /
    // `last_error_for`) and the `resting_status` decision that `get_statuses`
    // applies to every non-active tunnel.

    /// GAP 3: after a failure is recorded, the resting status a reload computes
    /// is `Error` carrying the recorded message — not `Disconnected`.
    #[test]
    fn resting_status_reports_error_after_recorded_failure() {
        let errors = Mutex::new(HashMap::new());
        let tracker = ConnectingTracker::new();

        record_last_error(&errors, TUNNEL_ID, "connect refused".to_string());

        let (status, error) = resting_status(
            tracker.is_connecting(TUNNEL_ID),
            last_error_for(&errors, TUNNEL_ID),
        );
        assert_eq!(status, TunnelStatus::Error);
        assert_eq!(error.as_deref(), Some("connect refused"));
    }

    /// GAP 3: "never started" (no map entry) stays `Disconnected` — distinct
    /// from "died with an error" (entry present).
    #[test]
    fn never_started_tunnel_reports_disconnected_not_error() {
        let errors = Mutex::new(HashMap::new());
        let (status, error) = resting_status(false, last_error_for(&errors, "never-started"));
        assert_eq!(status, TunnelStatus::Disconnected);
        assert!(error.is_none());
    }

    /// GAP 3: an in-flight connect wins over a stale recorded error.
    #[test]
    fn connecting_takes_precedence_over_recorded_error() {
        let errors = Mutex::new(HashMap::new());
        record_last_error(&errors, TUNNEL_ID, "old failure".to_string());

        let (status, error) = resting_status(true, last_error_for(&errors, TUNNEL_ID));
        assert_eq!(status, TunnelStatus::Connecting);
        assert!(error.is_none());
    }

    /// GAP 3: a successful start clears the recorded error, so a later resting
    /// read reports `Disconnected` (not the stale `Error`).
    #[test]
    fn successful_start_clears_recorded_error() {
        let errors = Mutex::new(HashMap::new());
        record_last_error(&errors, TUNNEL_ID, "boom".to_string());
        assert!(last_error_for(&errors, TUNNEL_ID).is_some());

        // start_tunnel clears the id on a successful insert.
        clear_last_error(&errors, TUNNEL_ID);

        let (status, error) = resting_status(false, last_error_for(&errors, TUNNEL_ID));
        assert_eq!(status, TunnelStatus::Disconnected);
        assert!(error.is_none());
    }

    /// GAP 3: an explicit stop clears the recorded error.
    #[test]
    fn explicit_stop_clears_recorded_error() {
        let errors = Mutex::new(HashMap::new());
        record_last_error(&errors, TUNNEL_ID, "boom".to_string());

        // stop_tunnel clears the id.
        clear_last_error(&errors, TUNNEL_ID);
        assert!(last_error_for(&errors, TUNNEL_ID).is_none());

        let (status, _) = resting_status(false, last_error_for(&errors, TUNNEL_ID));
        assert_eq!(status, TunnelStatus::Disconnected);
    }

    /// GAP 3 core regression: repeated status reads (a simulated `loadTunnels`
    /// reload) must NOT launder `Error` back to `Disconnected` — the second read
    /// still reports `Error` with its message because reading never mutates the
    /// persisted map.
    #[test]
    fn error_survives_repeated_status_reads() {
        let errors = Mutex::new(HashMap::new());
        record_last_error(&errors, TUNNEL_ID, "session died".to_string());

        let first = resting_status(false, last_error_for(&errors, TUNNEL_ID));
        assert_eq!(first.0, TunnelStatus::Error);

        let second = resting_status(false, last_error_for(&errors, TUNNEL_ID));
        assert_eq!(second.0, TunnelStatus::Error);
        assert_eq!(second.1.as_deref(), Some("session died"));
    }
}
