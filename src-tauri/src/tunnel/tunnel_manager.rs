use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use termihub_core::backends::ssh::auth::connect_and_authenticate_cancellable_with_liveness as core_connect_cancellable_with_liveness;
use termihub_core::backends::ssh::handler::{ForwardedChannelRegistry, LivenessWatch, SshSession};
use termihub_core::backends::ssh::jump_host::connect_target_through_pooled_gateway_with_liveness;
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
use crate::run_location::{Locality, ResolvedLocation, RunLocationResolver};
use crate::terminal::agent_manager::AgentRpcClient;
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

/// A pooled endpoint SSH session together with its native liveness watch (#1297).
///
/// Pooled by connection id so every local/dynamic tunnel sharing the endpoint
/// session also shares one [`LivenessWatch`] (cloned per supervisor); dropping the
/// last pool reference drains the session. Bundling the watch with the session in
/// the pooled value is what lets a shared session's death fan out to every
/// supervisor riding it.
struct LiveEndpoint {
    session: Arc<SshSession>,
    liveness: LivenessWatch,
}

/// What a jump-host tunnel connect yields: the target session, its forwarded-
/// channel registry, the pooled gateway hold to keep alive for the session's
/// lifetime, and the native session-[`LivenessWatch`] (#1297).
type GatewayConnect = (
    SshSession,
    ForwardedChannelRegistry,
    PooledRef<Arc<SshGateway>>,
    LivenessWatch,
);

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
    endpoint: Option<PooledRef<Arc<LiveEndpoint>>>,
    /// Pooled jump-host gateway session shared across all connections that use
    /// the same bastion. `None` for direct (non-jump) connections.
    gateway: Option<PooledRef<Arc<SshGateway>>>,
}

impl PooledSessionGuards {
    /// Hold a pooled per-connection endpoint session.
    fn endpoint(endpoint: PooledRef<Arc<LiveEndpoint>>) -> Self {
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

/// Resolve a tunnel's run-location host to its execution target (S3, #2155).
///
/// A tunnel is never desktop-only, so the resolver honours whatever host the
/// config carries. [`RunLocation::ThisComputer`] resolves to
/// [`ResolvedLocation::Local`] (the desktop forwarder path — today's
/// behaviour); [`RunLocation::Agent`] resolves to [`ResolvedLocation::Agent`],
/// routing hosting to that agent over the agent RPC (#2185). The error string
/// is what the caller records + emits as the tunnel's resting `Error`. Pure (no
/// locking, no IO, no `AppHandle`) so the routing decision is unit-testable
/// directly.
fn resolve_tunnel_host(
    tunnel_id: &str,
    host: &crate::run_location::RunLocation,
) -> Result<ResolvedLocation, String> {
    RunLocationResolver::new()
        .resolve(tunnel_id, Locality::LocalOrAgent, host)
        .map_err(|e| e.to_string())
}

/// How often the live stats emitter samples each active tunnel and pushes a
/// `tunnel-stats-updated` event (GAP 6, #1248).
const STATS_EMIT_INTERVAL: Duration = Duration::from_secs(1);

/// The Tauri event name carrying live per-tunnel throughput / connection counts.
const TUNNEL_STATS_EVENT: &str = "tunnel-stats-updated";

/// Payload for a live `tunnel-stats-updated` event.
///
/// The frontend listener (`onTunnelStatsUpdated`, `src/services/events.ts`)
/// reads `event.payload.tunnel_id` and `event.payload.stats`, so the id field is
/// intentionally serialized as snake_case `tunnel_id` (not the camelCase
/// `tunnelId` used by `TunnelState`). `TunnelStats` itself already serializes to
/// the camelCase shape the frontend `TunnelStats` type expects.
#[derive(Debug, Clone, Serialize)]
struct TunnelStatsUpdate {
    tunnel_id: String,
    stats: TunnelStats,
}

/// An active tunnel with its forwarder.
enum ActiveForwarder {
    Local(LocalForwarder),
    Remote(RemoteForwarder),
    Dynamic(DynamicForwarder),
}

/// Build the per-tunnel stats payloads for one emit tick from the active set.
///
/// Pure helper (no locking, no IO) so it is unit-testable: given the current
/// active tunnels it returns one [`TunnelStatsUpdate`] per tunnel with a live
/// counter snapshot. An empty map yields an empty vec — the signal the emitter
/// task uses to stop once no tunnel is active.
fn snapshot_active_stats(active: &HashMap<String, ActiveTunnel>) -> Vec<TunnelStatsUpdate> {
    active
        .iter()
        .map(|(tunnel_id, tunnel)| TunnelStatsUpdate {
            tunnel_id: tunnel_id.clone(),
            stats: tunnel.forwarder.stats(),
        })
        .collect()
}

impl ActiveForwarder {
    /// Take the forwarder's death receiver (once) for the tunnel supervisor.
    fn take_death_signal(&mut self) -> Option<tokio::sync::oneshot::Receiver<()>> {
        match self {
            ActiveForwarder::Local(f) => f.take_death_signal(),
            ActiveForwarder::Remote(f) => f.take_death_signal(),
            ActiveForwarder::Dynamic(f) => f.take_death_signal(),
        }
    }

    /// Read a live snapshot of this forwarder's traffic / connection counters.
    fn stats(&self) -> TunnelStats {
        match self {
            ActiveForwarder::Local(f) => f.get_stats(),
            ActiveForwarder::Remote(f) => f.get_stats(),
            ActiveForwarder::Dynamic(f) => f.get_stats(),
        }
    }
}

/// An active tunnel instance.
struct ActiveTunnel {
    forwarder: ActiveForwarder,
    /// Pool references kept alive for the tunnel's lifetime; dropped on teardown
    /// to release the shared endpoint / gateway sessions.
    guards: PooledSessionGuards,
    /// Per-tunnel supervisor task that watches for forwarder / session death and
    /// drives the tunnel to `Error` (#1243). `None` only in the brief window
    /// before it is spawned. Dropped (detached) when the supervisor self-reaps on
    /// death; aborted by `stop_tunnel`/`stop_all`.
    supervisor: Option<tokio::task::JoinHandle<()>>,
    /// Cancelled by `stop_tunnel`/`stop_all` before teardown so the supervisor
    /// exits cleanly — a user stop must never be mistaken for a real death and
    /// launder the tunnel into `Error`.
    supervisor_cancel: CancellationToken,
}

/// A tunnel hosted on a remote agent (S3, #2185).
///
/// The desktop holds only *control* state — which agent forwards it — so
/// `stop_tunnel` can send `tunnel.stop` to the right agent. The data path
/// (listen socket, SSH session, forwarder) lives entirely on the agent, so
/// there is no `ActiveForwarder` here. The agent-reported endpoint details
/// (`boundAddress` / `reachableFrom`) are logged on start; surfacing them into
/// the projection view model is a follow-up to #2185.
struct AgentTunnelHandle {
    /// The agent forwarding this tunnel.
    agent_id: String,
}

/// Central manager for SSH tunnels.
///
/// Handles CRUD operations on tunnel configurations, starting/stopping tunnels,
/// and tracking live tunnel state.
pub struct TunnelManager {
    tunnel_configs: Mutex<TunnelStore>,
    storage: TunnelStorage,
    /// `Arc`-shared so each per-tunnel supervisor task can hold a handle and
    /// self-reap its own entry on death (#1243) without a `&self` reference.
    active_tunnels: Arc<Mutex<HashMap<String, ActiveTunnel>>>,
    /// Last error per tunnel id, making a failed start a durable, queryable
    /// resting state that survives a `loadTunnels` reload (GAP 3, #1238). An
    /// entry is set when a start fails and committed (not cancelled), and
    /// cleared on a successful start or an explicit stop. `Arc`-shared so the
    /// supervisor can record a death cause (#1243).
    last_errors: Arc<Mutex<HashMap<String, String>>>,
    /// Cancel tokens for in-flight reconnect-backoff loops, keyed by tunnel id
    /// (#1246, GAP 5). A tunnel with `reconnect_on_disconnect` on is NOT in
    /// `active_tunnels` while retrying, so `stop_tunnel`/`stop_all` cancel the
    /// backoff loop through this registry instead. `Arc`-shared so the supervisor
    /// task can register/deregister its own loop without `&self`.
    reconnecting: Arc<Mutex<HashMap<String, CancellationToken>>>,
    connecting: ConnectingTracker,
    /// Tunnels currently hosted on a remote agent, keyed by tunnel id (S3,
    /// #2185). Disjoint from `active_tunnels` (which holds desktop-hosted
    /// forwarders): an agent-hosted tunnel's data path runs on the agent, so the
    /// desktop tracks only the control handle here.
    agent_tunnels: Mutex<HashMap<String, AgentTunnelHandle>>,
    /// Pool of SSH endpoint sessions shared by local/dynamic forwarders on the
    /// same connection. Jump-host gateway sessions are pooled separately in the
    /// process-wide [`shared_gateway_pool`](termihub_core::backends::ssh::session_pool::shared_gateway_pool).
    endpoint_pool: Arc<RefPool<Arc<LiveEndpoint>>>,
    app_handle: AppHandle,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
    /// Handle to the single periodic live-stats emitter task (GAP 6, #1248).
    /// `Some` while at least one tunnel is active; the task self-reaps and clears
    /// this slot once no tunnel remains, and `stop_all` aborts it on shutdown.
    stats_emitter: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
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
            active_tunnels: Arc::new(Mutex::new(HashMap::new())),
            last_errors: Arc::new(Mutex::new(HashMap::new())),
            reconnecting: Arc::new(Mutex::new(HashMap::new())),
            connecting: ConnectingTracker::new(),
            agent_tunnels: Mutex::new(HashMap::new()),
            endpoint_pool: RefPool::new(),
            app_handle: app_handle.clone(),
            recovery_warnings: Mutex::new(result.warnings),
            stats_emitter: Arc::new(Mutex::new(None)),
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
        let reconnecting = self
            .reconnecting
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
        let agent_tunnels = self
            .agent_tunnels
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;

        let states = store
            .tunnels
            .iter()
            .map(|config| {
                if let Some(tunnel) = active.get(&config.id) {
                    TunnelState {
                        tunnel_id: config.id.clone(),
                        status: TunnelStatus::Connected,
                        error: None,
                        stats: tunnel.forwarder.stats(),
                    }
                } else if agent_tunnels.contains_key(&config.id) {
                    // Hosted on an agent (#2185): the data path runs on the
                    // agent, so the desktop reports `Connected` without live
                    // stats (streaming per-tick stats over the agent RPC is a
                    // follow-up).
                    TunnelState {
                        tunnel_id: config.id.clone(),
                        status: TunnelStatus::Connected,
                        error: None,
                        stats: TunnelStats::default(),
                    }
                } else if reconnecting.contains_key(&config.id) {
                    // In a reconnect-backoff loop (#1246) — report `Reconnecting`
                    // so a reload does not briefly launder it back to Error.
                    TunnelState {
                        tunnel_id: config.id.clone(),
                        status: TunnelStatus::Reconnecting,
                        error: None,
                        stats: TunnelStats::default(),
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

        // Route by run-location (S3, #2155/#2185). Desktop-hosted tunnels (the
        // default) take the existing local forwarder path below; agent-hosted
        // tunnels are forwarded on the agent over the agent RPC.
        match resolve_tunnel_host(tunnel_id, &config.host) {
            Ok(ResolvedLocation::Local) => {}
            Ok(ResolvedLocation::Agent(agent_id)) => {
                return self.start_agent_tunnel(tunnel_id, &config, &agent_id);
            }
            Err(message) => {
                record_last_error(&self.last_errors, tunnel_id, message.clone());
                self.emit_status(tunnel_id, TunnelStatus::Error, Some(message.clone()));
                return Err(TerminalError::TunnelError(message));
            }
        }

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
        let (forwarder, guards, liveness) = match self.build_forwarder(&config, cancel) {
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

        // Register as active and spawn the per-tunnel supervisor (#1243), passing
        // the reconnect toggle so a later death enters the backoff loop (#1246).
        self.register_and_supervise(
            tunnel_id,
            forwarder,
            guards,
            liveness,
            config.reconnect_on_disconnect,
        )?;

        // A successful start clears any recorded failure so the tunnel no longer
        // rests in `Error` once it is running again (GAP 3, #1238).
        clear_last_error(&self.last_errors, tunnel_id);

        // Emit connected status
        self.emit_status(tunnel_id, TunnelStatus::Connected, None);

        // Ensure the periodic live-stats emitter is running now that a tunnel is
        // active, so the sidebar's ↑/↓ bytes + conn count update live rather than
        // freezing at the zeros the initial status event carried (GAP 6, #1248).
        self.ensure_stats_emitter();

        tracing::info!("Tunnel {} started", tunnel_id);
        Ok(())
    }

    /// Start a tunnel hosted on a remote agent (S3, #2185).
    ///
    /// The agent runs the SSH client; the desktop sends only control over the
    /// agent RPC. Forwards **local** (`ssh -L`) and **remote** (`ssh -R`)
    /// tunnels on the agent — for `-L` the listen socket binds on the agent, for
    /// `-R` the SSH server binds it and the target is resolved from the agent
    /// (see the endpoint-semantics concept). Dynamic (`-D`) agent hosting is a
    /// follow-up, so it surfaces a clear, durable `Error` rather than silently
    /// forwarding on the desktop. On success the agent-reported `bound_address` /
    /// `reachable_from` are stored for the projection and the tunnel rests
    /// `Connected`.
    fn start_agent_tunnel(
        &self,
        tunnel_id: &str,
        config: &TunnelConfig,
        agent_id: &str,
    ) -> Result<(), TerminalError> {
        // Build the agent's internally-tagged `TunnelForwardSpec` (a `mode`
        // discriminator plus the flattened forward config). Local and remote run
        // on an agent; dynamic does not yet.
        let forward = match &config.tunnel_type {
            TunnelType::Local(local) => {
                let mut forward = serde_json::to_value(local).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to serialize forward config: {}", e))
                })?;
                forward["mode"] = serde_json::json!("local");
                forward
            }
            TunnelType::Remote(remote) => {
                let mut forward = serde_json::to_value(remote).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to serialize forward config: {}", e))
                })?;
                forward["mode"] = serde_json::json!("remote");
                forward
            }
            TunnelType::Dynamic(_) => {
                let message = format!(
                    "agent-hosted dynamic (-D) forwarding is not yet supported (tunnel \
                     '{tunnel_id}'); only local (-L) and remote (-R) forwarding run on an agent \
                     today"
                );
                record_last_error(&self.last_errors, tunnel_id, message.clone());
                self.emit_status(tunnel_id, TunnelStatus::Error, Some(message.clone()));
                return Err(TerminalError::TunnelError(message));
            }
        };

        // Reject a double-start (already active on the desktop or an agent).
        {
            let active = self
                .active_tunnels
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            let agent = self
                .agent_tunnels
                .lock()
                .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
            if active.contains_key(tunnel_id) || agent.contains_key(tunnel_id) {
                return Err(TerminalError::TunnelError(format!(
                    "Tunnel {} is already active",
                    tunnel_id
                )));
            }
        }

        self.emit_status(tunnel_id, TunnelStatus::Connecting, None);

        // Resolve the SSH connection so the agent can open the session to the
        // "via" server itself; any inline jump-host chain is already expanded.
        let ssh_config = match self.resolve_ssh_config(&config.ssh_connection_id) {
            Ok(cfg) => cfg,
            Err(e) => {
                record_last_error(&self.last_errors, tunnel_id, e.to_string());
                self.emit_status(tunnel_id, TunnelStatus::Error, Some(e.to_string()));
                return Err(e);
            }
        };

        let agent_manager = self
            .app_handle
            .try_state::<Arc<dyn AgentRpcClient>>()
            .ok_or_else(|| {
                TerminalError::TunnelError("Agent manager is not available".to_string())
            })?;

        // Send the tunnel.start request. `forward` is the agent's
        // internally-tagged `TunnelForwardSpec` shape (built above): the
        // forward-config fields plus a `mode` discriminator.
        let params = serde_json::json!({
            "tunnelId": tunnel_id,
            "sshConfig": ssh_config,
            "forward": forward,
        });

        match agent_manager.send_request(agent_id, "tunnel.start", params) {
            Ok(result) => {
                let bound_address = result["boundAddress"].as_str().unwrap_or("");
                let reachable_from = result["reachableFrom"].as_str().unwrap_or("");
                {
                    let mut agent = self
                        .agent_tunnels
                        .lock()
                        .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
                    agent.insert(
                        tunnel_id.to_string(),
                        AgentTunnelHandle {
                            agent_id: agent_id.to_string(),
                        },
                    );
                }
                clear_last_error(&self.last_errors, tunnel_id);
                self.emit_status(tunnel_id, TunnelStatus::Connected, None);
                tracing::info!(
                    "Tunnel {} started on agent {} (bound {} on the agent, reachable from {})",
                    tunnel_id,
                    agent_id,
                    bound_address,
                    reachable_from
                );
                Ok(())
            }
            Err(e) => {
                let message = format!("agent-hosted tunnel start failed: {}", e);
                record_last_error(&self.last_errors, tunnel_id, message.clone());
                self.emit_status(tunnel_id, TunnelStatus::Error, Some(message.clone()));
                Err(TerminalError::TunnelError(message))
            }
        }
    }

    /// Stop an agent-hosted tunnel, if `tunnel_id` is one. Returns `true` when a
    /// handle was found and a `tunnel.stop` sent to the agent (best-effort — the
    /// desktop drops its handle regardless so the UI reflects the stop).
    fn stop_agent_tunnel(&self, tunnel_id: &str) -> bool {
        let handle = {
            let mut agent = match self.agent_tunnels.lock() {
                Ok(a) => a,
                Err(_) => return false,
            };
            agent.remove(tunnel_id)
        };
        let Some(handle) = handle else {
            return false;
        };
        if let Some(agent_manager) = self.app_handle.try_state::<Arc<dyn AgentRpcClient>>() {
            let params = serde_json::json!({ "tunnelId": tunnel_id });
            if let Err(e) = agent_manager.send_request(&handle.agent_id, "tunnel.stop", params) {
                tracing::warn!(
                    "Failed to stop agent-hosted tunnel {} on agent {}: {}",
                    tunnel_id,
                    handle.agent_id,
                    e
                );
            }
        }
        self.emit_status(tunnel_id, TunnelStatus::Disconnected, None);
        tracing::info!("Tunnel {} stopped on agent {}", tunnel_id, handle.agent_id);
        true
    }

    /// Ensure the single periodic live-stats emitter task is running.
    ///
    /// Idempotent: if a task is already tracked in `stats_emitter` it is left
    /// alone. Otherwise a new task is spawned that, every [`STATS_EMIT_INTERVAL`],
    /// snapshots every active tunnel's live [`ForwarderStats`] and emits one
    /// `tunnel-stats-updated` event per tunnel. The task self-terminates (and
    /// clears the tracking slot) as soon as no tunnel is active, so a dead/errored
    /// tunnel reaped by its supervisor (#1243) naturally stops emitting.
    fn ensure_stats_emitter(&self) {
        let mut slot = match self.stats_emitter.lock() {
            Ok(slot) => slot,
            Err(_) => return,
        };
        // Already running (and not yet finished) — nothing to do.
        if slot.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return;
        }

        let active_tunnels = Arc::clone(&self.active_tunnels);
        let app_handle = self.app_handle.clone();
        let emitter_slot = Arc::clone(&self.stats_emitter);

        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(STATS_EMIT_INTERVAL).await;

                // Snapshot under the lock, then release it before emitting so a
                // slow event dispatch never blocks start/stop of other tunnels.
                let updates = match active_tunnels.lock() {
                    Ok(active) => snapshot_active_stats(&active),
                    Err(_) => break,
                };

                // No tunnel left active: stop emitting and clear the slot so a
                // later start re-spawns the task.
                if updates.is_empty() {
                    break;
                }

                for update in &updates {
                    let _ = app_handle.emit(TUNNEL_STATS_EVENT, update);
                }
                // Project live stats onto the `tunnels` region (#2150) so a
                // projection subscriber sees the same per-tick ↑/↓ + conn counts
                // as the legacy event above. The active-tunnels lock is already
                // released here, so the re-lock inside is safe.
                crate::tunnel::projection::publish_tunnels(&app_handle);
            }

            // Self-reap: drop our own handle from the tracking slot so
            // `ensure_stats_emitter` spawns a fresh task on the next start.
            if let Ok(mut slot) = emitter_slot.lock() {
                *slot = None;
            }
        });

        *slot = Some(handle);
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
    ) -> Result<(ActiveForwarder, PooledSessionGuards, Option<LivenessWatch>), TerminalError> {
        let ssh_config = self.resolve_ssh_config(&config.ssh_connection_id)?;
        let conn_id = &config.ssh_connection_id;
        let jumped = !ssh_config.proxy_jump.is_empty();

        // The returned [`LivenessWatch`] is the native, event-driven session-death
        // signal the supervisor selects over so a dead SSH session surfaces as
        // `Error` even while the local listener keeps accepting (#1243/#1297, GAP 1).
        // Remote forwards own a dedicated session driven purely by the forwarder
        // death signal, so they get no watch here (`None`).
        match &config.tunnel_type {
            TunnelType::Local(local_config) => {
                let (session, guards, liveness) =
                    self.acquire_endpoint(conn_id, &ssh_config, cancel, jumped)?;
                let f = LocalForwarder::start(local_config, session).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to start local forwarder: {}", e))
                })?;
                Ok((ActiveForwarder::Local(f), guards, Some(liveness)))
            }
            TunnelType::Dynamic(dynamic_config) => {
                let (session, guards, liveness) =
                    self.acquire_endpoint(conn_id, &ssh_config, cancel, jumped)?;
                let f = DynamicForwarder::start(dynamic_config, session).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to start dynamic forwarder: {}", e))
                })?;
                Ok((ActiveForwarder::Dynamic(f), guards, Some(liveness)))
            }
            TunnelType::Remote(remote_config) => {
                // Remote forwarding needs tcpip_forward (&mut SshSession), so it always gets
                // a dedicated connection rather than a pooled shared Arc<SshSession>.
                let (session, registry, guards) =
                    self.acquire_dedicated(&ssh_config, cancel, jumped)?;
                let f = RemoteForwarder::start(remote_config, session, registry).map_err(|e| {
                    TerminalError::TunnelError(format!("Failed to start remote forwarder: {}", e))
                })?;
                Ok((ActiveForwarder::Remote(f), guards, None))
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
    ) -> Result<(Arc<SshSession>, PooledSessionGuards, LivenessWatch), TerminalError> {
        if jumped {
            let (session, _registry, gateway, liveness) =
                self.connect_through_gateway(ssh_config, cancel)?;
            Ok((
                Arc::new(session),
                PooledSessionGuards::gateway(gateway),
                liveness,
            ))
        } else {
            let endpoint = block_on_runtime(self.endpoint_pool.get_or_create_live(
                conn_id,
                // Never adopt a pooled endpoint whose session has already died —
                // its cloned watch is already `true`, which would drive the new
                // tunnel straight to Error. Evict it and dial a fresh one (#1315).
                |ep| !ep.liveness.is_dead(),
                || async move {
                    core_connect_cancellable_with_liveness(ssh_config, Some(cancel))
                        .await
                        .map(|(session, _registry, liveness)| {
                            Arc::new(LiveEndpoint {
                                session: Arc::new(session),
                                liveness,
                            })
                        })
                        .map_err(|e| TerminalError::SshError(e.to_string()))
                },
            ))?;
            // Each supervisor gets its own watch receiver clone, so one shared
            // pooled session's death fans out to every tunnel riding it (#1297).
            let session = endpoint.session.clone();
            let liveness = endpoint.liveness.clone();
            Ok((session, PooledSessionGuards::endpoint(endpoint), liveness))
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
            // Remote forwards rely on the forwarder death signal, not the session
            // liveness watch, so the watch is dropped here.
            let (session, registry, gateway, _liveness) =
                self.connect_through_gateway(ssh_config, cancel)?;
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
    ) -> Result<GatewayConnect, TerminalError> {
        block_on_runtime(async move {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    Err(TerminalError::TunnelError("SSH connect cancelled".to_string()))
                }
                res = connect_target_through_pooled_gateway_with_liveness(ssh_config, Some(&cancel)) => {
                    res.map_err(|e| TerminalError::SshError(e.to_string()))
                }
            }
        })
    }

    /// Stop a forwarder and release the pool references it held.
    fn teardown_forwarder(&self, forwarder: ActiveForwarder, guards: PooledSessionGuards) {
        teardown_parts(forwarder, guards);
    }

    /// Spawn the per-tunnel supervisor task (#1243). Holds `Arc` clones of the
    /// shared state so it can self-reap its tunnel on death without `&self`.
    /// Register a freshly-built forwarder as active and spawn its supervisor.
    /// Shared by `start_tunnel` and the reconnect loop (#1246); `reconnect_on_disconnect`
    /// is threaded to the supervisor so a later death enters backoff vs. `Error`.
    fn register_and_supervise(
        &self,
        tunnel_id: &str,
        mut forwarder: ActiveForwarder,
        guards: PooledSessionGuards,
        liveness: Option<LivenessWatch>,
        reconnect_on_disconnect: bool,
    ) -> Result<(), TerminalError> {
        let death = forwarder.take_death_signal();
        let supervisor_cancel = CancellationToken::new();
        let mut active = self
            .active_tunnels
            .lock()
            .map_err(|e| TerminalError::TunnelError(format!("Lock error: {}", e)))?;
        let supervisor = self.spawn_supervisor(
            tunnel_id.to_string(),
            death,
            liveness,
            supervisor_cancel.clone(),
            reconnect_on_disconnect,
        );
        active.insert(
            tunnel_id.to_string(),
            ActiveTunnel {
                forwarder,
                guards,
                supervisor: Some(supervisor),
                supervisor_cancel,
            },
        );
        Ok(())
    }

    /// One reconnect attempt driven by the backoff loop (#1246): re-resolve the
    /// config, rebuild the forwarder, and re-register + re-supervise it. Returns
    /// `true` on success (the tunnel is `Connected` again), `false` if the build
    /// failed (the loop then backs off and retries). Runs on `&self` — the
    /// supervisor task reaches it via `resolve_managed_arc::<TunnelManager>`,
    /// which resolves the app-managed `Arc<TunnelManager>` (#2168).
    fn attempt_reconnect(&self, tunnel_id: &str) -> bool {
        let config = {
            match self.tunnel_configs.lock() {
                Ok(store) => store.tunnels.iter().find(|t| t.id == tunnel_id).cloned(),
                Err(_) => None,
            }
        };
        let Some(config) = config else {
            return false;
        };
        // A fresh, un-cancelled token: the backoff loop owns Stop via the
        // `reconnecting` registry, not this connect token.
        let cancel = CancellationToken::new();
        let built = match self.build_forwarder(&config, cancel) {
            Ok(built) => built,
            Err(e) => {
                tracing::warn!("Reconnect attempt for tunnel {tunnel_id} failed to build: {e}");
                return false;
            }
        };
        let (forwarder, guards, liveness) = built;
        if self
            .register_and_supervise(
                tunnel_id,
                forwarder,
                guards,
                liveness,
                config.reconnect_on_disconnect,
            )
            .is_err()
        {
            return false;
        }
        clear_last_error(&self.last_errors, tunnel_id);
        self.emit_status(tunnel_id, TunnelStatus::Connected, None);
        tracing::info!("Tunnel {tunnel_id} reconnected");
        true
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_supervisor(
        &self,
        tunnel_id: String,
        death: Option<tokio::sync::oneshot::Receiver<()>>,
        liveness: Option<LivenessWatch>,
        cancel: CancellationToken,
        reconnect_on_disconnect: bool,
    ) -> tokio::task::JoinHandle<()> {
        let active_tunnels = Arc::clone(&self.active_tunnels);
        let last_errors = Arc::clone(&self.last_errors);
        let reconnecting = Arc::clone(&self.reconnecting);
        let app_handle = self.app_handle.clone();
        tokio::spawn(async move {
            supervise(
                active_tunnels,
                last_errors,
                reconnecting,
                app_handle,
                tunnel_id,
                death,
                liveness,
                cancel,
                reconnect_on_disconnect,
            )
            .await;
        })
    }

    /// Stop an active tunnel by ID.
    pub fn stop_tunnel(&self, tunnel_id: &str) -> Result<(), TerminalError> {
        // An explicit stop dismisses any recorded failure, returning the tunnel
        // from the `Error` resting state to `Disconnected` (GAP 3, #1238).
        clear_last_error(&self.last_errors, tunnel_id);

        // Agent-hosted tunnels live in their own track: send `tunnel.stop` to the
        // agent and drop the control handle (S3, #2185).
        if self.stop_agent_tunnel(tunnel_id) {
            return Ok(());
        }

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
                guards,
                supervisor,
                supervisor_cancel,
            } = tunnel;
            // Cancel + abort the supervisor first so the teardown-induced forwarder
            // death is not mistaken for a real death that would re-emit `Error`
            // over this `Disconnected` (#1243).
            supervisor_cancel.cancel();
            if let Some(handle) = supervisor {
                handle.abort();
            }
            self.teardown_forwarder(forwarder, guards);
            self.emit_status(tunnel_id, TunnelStatus::Disconnected, None);
            tracing::info!("Tunnel {} stopped", tunnel_id);
            return Ok(());
        }

        // Not active — it may be in a reconnect-backoff loop (#1246). Cancel it;
        // the loop's supervisor observes the token and emits `Disconnected` on the
        // Cancelled outcome. Stop always wins the Stop-vs-backoff race.
        if self.cancel_reconnect(tunnel_id) {
            tracing::info!("Tunnel {} reconnect cancelled by stop", tunnel_id);
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

    /// Cancel an in-flight reconnect-backoff loop for `tunnel_id` (#1246).
    /// Returns true if one was cancelled; the loop's supervisor emits
    /// `Disconnected` and deregisters itself.
    fn cancel_reconnect(&self, tunnel_id: &str) -> bool {
        let token = match self.reconnecting.lock() {
            Ok(map) => map.get(tunnel_id).cloned(),
            Err(_) => None,
        };
        match token {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    /// Stop all active tunnels (used during app shutdown).
    pub fn stop_all(&self) {
        // Cancel every in-flight reconnect-backoff loop so no zombie backoff task
        // survives shutdown (#1246).
        if let Ok(map) = self.reconnecting.lock() {
            for token in map.values() {
                token.cancel();
            }
        }

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

        // Tear down agent-hosted tunnels too (#2185) — `stop_agent_tunnel` sends
        // `tunnel.stop` to each agent and drops the handle.
        let agent_tunnels: Vec<String> = match self.agent_tunnels.lock() {
            Ok(a) => a.keys().cloned().collect(),
            Err(_) => Vec::new(),
        };
        for tunnel_id in agent_tunnels {
            self.stop_agent_tunnel(&tunnel_id);
        }

        // Abort the live-stats emitter promptly on shutdown rather than waiting
        // for its next tick to observe the now-empty active set (GAP 6, #1248).
        self.stop_stats_emitter();
    }

    /// Abort the live-stats emitter task (if any) and clear its tracking slot.
    fn stop_stats_emitter(&self) {
        if let Ok(mut slot) = self.stats_emitter.lock() {
            if let Some(handle) = slot.take() {
                handle.abort();
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
        emit_tunnel_status(&self.app_handle, tunnel_id, status, error);
    }
}

/// Why a supervised tunnel died, for the recorded `Error` message.
enum DeathCause {
    Forwarder,
    Session,
}

/// Stop a forwarder and drop its pool guards (RAII drains the pool). Free
/// function so the supervisor task can tear a dead tunnel down without `&self`.
fn teardown_parts(mut forwarder: ActiveForwarder, guards: PooledSessionGuards) {
    match &mut forwarder {
        ActiveForwarder::Local(f) => f.stop(),
        ActiveForwarder::Remote(f) => f.stop(),
        ActiveForwarder::Dynamic(f) => f.stop(),
    }
    drop(guards);
}

/// Emit a tunnel status change event to the frontend (free function so the
/// supervisor task can emit without `&self`).
fn emit_tunnel_status(
    app_handle: &AppHandle,
    tunnel_id: &str,
    status: TunnelStatus,
    error: Option<String>,
) {
    let state = TunnelState {
        tunnel_id: tunnel_id.to_string(),
        status,
        error,
        stats: TunnelStats::default(),
    };
    let _ = app_handle.emit("tunnel-status-changed", &state);
    // Project the change onto the stateless-UI `tunnels` region (#2150). Kept
    // beside the legacy event above (strangler): this is the single status-emit
    // choke point, and every caller emits outside the manager's locks, so the
    // re-lock inside `publish_tunnels` cannot deadlock.
    crate::tunnel::projection::publish_tunnels(app_handle);
}

/// Per-tunnel supervisor loop (#1243, GAP 1 + GAP 2).
///
/// Waits for the first of: an explicit stop (cancel token — NOT a death), the
/// forwarder death signal, or the native session-liveness watch firing (#1297).
/// On a real death it reaps the tunnel from `active_tunnels` (dropping its pool
/// guards so the shared session drains exactly once), records the cause as the
/// durable last-error (#1238), and emits the `Error` resting state.
#[allow(clippy::too_many_arguments)]
async fn supervise(
    active_tunnels: Arc<Mutex<HashMap<String, ActiveTunnel>>>,
    last_errors: Arc<Mutex<HashMap<String, String>>>,
    reconnecting: Arc<Mutex<HashMap<String, CancellationToken>>>,
    app_handle: AppHandle,
    tunnel_id: String,
    death: Option<tokio::sync::oneshot::Receiver<()>>,
    liveness: Option<LivenessWatch>,
    cancel: CancellationToken,
    reconnect_on_disconnect: bool,
) {
    let cause = tokio::select! {
        biased;
        // An explicit stop wins the race so a user stop is never laundered into
        // Error; the other branches are dropped.
        _ = cancel.cancelled() => return,
        _ = wait_forwarder_death(death) => DeathCause::Forwarder,
        _ = wait_session_death(liveness) => DeathCause::Session,
    };

    let removed = match active_tunnels.lock() {
        Ok(mut map) => map.remove(&tunnel_id),
        Err(_) => None,
    };
    // If a concurrent stop already removed the entry, it owns the resting state.
    let Some(ActiveTunnel {
        forwarder, guards, ..
    }) = removed
    else {
        return;
    };
    teardown_parts(forwarder, guards);

    let reason = match cause {
        DeathCause::Forwarder => "connection lost: forwarder stopped",
        DeathCause::Session => "connection lost: SSH session closed",
    };

    // With reconnect off, death is a terminal Error resting state (#1243).
    if !reconnect_on_disconnect {
        record_last_error(&last_errors, &tunnel_id, reason.to_string());
        emit_tunnel_status(
            &app_handle,
            &tunnel_id,
            TunnelStatus::Error,
            Some(reason.to_string()),
        );
        tracing::warn!("Tunnel {tunnel_id} died — transitioned to Error");
        return;
    }

    // With reconnect on, enter the capped-backoff reconnect loop (#1246, GAP 5).
    // Register a loop cancel token so Stop reaches the backoff even though the
    // tunnel is no longer in `active_tunnels`.
    tracing::info!("Tunnel {tunnel_id} died ({reason}) — reconnecting under backoff");
    let loop_cancel = CancellationToken::new();
    if let Ok(mut map) = reconnecting.lock() {
        map.insert(tunnel_id.clone(), loop_cancel.clone());
    }

    let outcome = run_reconnect_loop(
        &loop_cancel,
        RECONNECT_MAX_ATTEMPTS,
        RECONNECT_BASE_DELAY,
        RECONNECT_MAX_DELAY,
        |attempt, delay| {
            emit_tunnel_status(
                &app_handle,
                &tunnel_id,
                TunnelStatus::Reconnecting,
                Some(format!(
                    "reconnecting — attempt {attempt}/{RECONNECT_MAX_ATTEMPTS} (retry in {}s)",
                    delay.as_secs()
                )),
            );
        },
        |_attempt| match resolve_managed_arc::<TunnelManager, _>(&app_handle) {
            Some(mgr) => mgr.attempt_reconnect(&tunnel_id),
            None => false,
        },
    )
    .await;

    if let Ok(mut map) = reconnecting.lock() {
        map.remove(&tunnel_id);
    }

    match outcome {
        // `attempt_reconnect` already re-registered + re-supervised + emitted Connected.
        ReconnectOutcome::Reconnected => {}
        ReconnectOutcome::Cancelled => {
            emit_tunnel_status(&app_handle, &tunnel_id, TunnelStatus::Disconnected, None);
            tracing::info!("Tunnel {tunnel_id} reconnect cancelled by stop");
        }
        ReconnectOutcome::Exhausted => {
            let msg = format!("reconnect failed after {RECONNECT_MAX_ATTEMPTS} attempts");
            record_last_error(&last_errors, &tunnel_id, msg.clone());
            emit_tunnel_status(&app_handle, &tunnel_id, TunnelStatus::Error, Some(msg));
            tracing::warn!("Tunnel {tunnel_id} reconnect exhausted — transitioned to Error");
        }
    }
}

/// Max reconnect attempts before giving up to `Error` (#1246).
const RECONNECT_MAX_ATTEMPTS: u32 = 5;
/// First backoff delay; subsequent attempts double it up to the cap.
const RECONNECT_BASE_DELAY: Duration = Duration::from_secs(1);
/// Upper bound on a single backoff wait.
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(30);

/// Outcome of a reconnect-backoff loop (#1246).
#[derive(Debug, PartialEq, Eq)]
enum ReconnectOutcome {
    /// A retry succeeded — the tunnel is `Connected` again.
    Reconnected,
    /// A user Stop cancelled the loop — the tunnel returns to `Disconnected`.
    Cancelled,
    /// All attempts failed — the tunnel falls through to `Error`.
    Exhausted,
}

/// Resolve an app-managed `Arc<T>` from any Tauri [`Manager`].
///
/// Managed state is keyed by exact `TypeId`. `lib.rs` registers the tunnel
/// manager as `app.manage(Arc::new(manager))`, so it lives under
/// `TypeId::of::<Arc<TunnelManager>>()`. A bare `try_state::<TunnelManager>()`
/// therefore never matches it and silently yields `None` — which had turned
/// every reconnect attempt into a no-op `false`, so `reconnectOnDisconnect`
/// (#1246) never actually reconnected (#2168). Always resolve the manager
/// through this helper so the lookup type matches the registration.
fn resolve_managed_arc<T, R>(manager: &impl Manager<R>) -> Option<Arc<T>>
where
    T: Send + Sync + 'static,
    R: Runtime,
{
    manager.try_state::<Arc<T>>().map(|state| (*state).clone())
}

/// Capped exponential backoff: `base * 2^(attempt-1)`, clamped to `cap`.
/// Saturating so a large attempt count cannot overflow (#1246).
fn backoff_delay(attempt: u32, base: Duration, cap: Duration) -> Duration {
    let factor = 2u32.saturating_pow(attempt.saturating_sub(1));
    base.saturating_mul(factor).min(cap)
}

/// Run the reconnect-backoff loop (#1246, GAP 5). Before each attempt it calls
/// `on_attempt(attempt, delay)` (to emit `Reconnecting`), waits `delay` (racing
/// the cancel token so a Stop wins immediately and clears the pending timer),
/// then runs `attempt(n)` — returning `Reconnected` on the first success,
/// `Cancelled` if the token fires, or `Exhausted` after `max_attempts`.
/// `attempt` is synchronous (the manager's connect blocks internally).
async fn run_reconnect_loop(
    cancel: &CancellationToken,
    max_attempts: u32,
    base: Duration,
    cap: Duration,
    mut on_attempt: impl FnMut(u32, Duration),
    mut attempt: impl FnMut(u32) -> bool,
) -> ReconnectOutcome {
    for n in 1..=max_attempts {
        let delay = backoff_delay(n, base, cap);
        on_attempt(n, delay);
        tokio::select! {
            biased;
            // Stop always wins the Stop-vs-backoff race and clears the pending timer.
            _ = cancel.cancelled() => return ReconnectOutcome::Cancelled,
            _ = tokio::time::sleep(delay) => {}
        }
        // A stop that fired exactly as the timer elapsed still wins.
        if cancel.is_cancelled() {
            return ReconnectOutcome::Cancelled;
        }
        if attempt(n) {
            return ReconnectOutcome::Reconnected;
        }
    }
    ReconnectOutcome::Exhausted
}

/// Resolve when the forwarder's accept/forward loop ends. The oneshot resolves
/// on `Ok` (never sent explicitly) or `Err` (its sender dropped when the task
/// ended — a `break` or an `abort()`), so either way signals the loop is gone.
async fn wait_forwarder_death(death: Option<tokio::sync::oneshot::Receiver<()>>) {
    match death {
        Some(rx) => {
            let _ = rx.await;
        }
        // No signal wired (should not happen) — never resolve so the session
        // liveness watch alone governs liveness.
        None => std::future::pending::<()>().await,
    }
}

/// Resolve once the SSH session is dead, via the native russh liveness watch
/// (#1297) — event-driven, no polling. russh fires the watch from its
/// `disconnected` callback on a transport failure, a peer disconnect, or
/// keepalive exhaustion (30 s × 3).
///
/// `None` (a remote forward, which has no shared endpoint session) never
/// resolves — the forwarder death signal governs liveness for that tunnel.
async fn wait_session_death(liveness: Option<LivenessWatch>) {
    match liveness {
        Some(mut watch) => watch.dead().await,
        None => std::future::pending::<()>().await,
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
    use std::time::Duration;

    use super::super::connecting::{ConnectingTracker, FinishOutcome};
    use super::super::local_forward::ForwarderStats;
    use super::{
        backoff_delay, clear_last_error, last_error_for, record_last_error, resolve_managed_arc,
        resolve_tunnel_host, resting_status, run_reconnect_loop, snapshot_active_stats,
        wait_forwarder_death, wait_session_death, ActiveTunnel, ReconnectOutcome,
        TunnelStatsUpdate,
    };
    use crate::run_location::{ResolvedLocation, RunLocation};
    use crate::tunnel::config::TunnelStatus;
    use tauri::Manager;
    use termihub_core::backends::ssh::session_pool::{PooledRef, RefPool};
    use tokio_util::sync::CancellationToken;

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

    /// S3 (#2155): a desktop-hosted tunnel routes to the local forwarder path.
    #[test]
    fn this_computer_host_routes_local() {
        assert_eq!(
            resolve_tunnel_host(TUNNEL_ID, &RunLocation::ThisComputer),
            Ok(ResolvedLocation::Local)
        );
    }

    /// S3 (#2185): an agent-hosted tunnel resolves to its agent, so `start_tunnel`
    /// routes hosting to that agent over the agent RPC rather than the desktop.
    #[test]
    fn agent_host_routes_to_the_agent() {
        assert_eq!(
            resolve_tunnel_host(TUNNEL_ID, &RunLocation::Agent("build-box".to_string())),
            Ok(ResolvedLocation::Agent("build-box".to_string()))
        );
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

    // ── Supervisor: liveness signals + death-driven Error (S2, GAP 1 + GAP 2, #1243) ──
    //
    // As with the GAP-8 tests above, the full `supervise` task cannot run in a
    // unit test (it needs a Tauri `AppHandle` to emit and a real `SshSession`),
    // so these lock in its constituent behaviours with the same production
    // building blocks: the real `wait_forwarder_death` / `wait_session_death`
    // futures and the RefPool guard-drain that the death path performs (the
    // native `LivenessWatch` firing itself is unit-tested in `core`). The
    // end-to-end Connected → Error on a killed sshd is the Docker system test.

    /// The forwarder death oneshot resolves when its sender is dropped — i.e. when
    /// the accept/forward task ends (a `break` or a `stop()`-abort), so the
    /// supervisor observes forwarder death however the loop exits (GAP 2).
    #[tokio::test]
    async fn forwarder_death_resolves_when_task_ends() {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let waiter = tokio::spawn(wait_forwarder_death(Some(rx)));
        drop(tx); // the accept task "ended"
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("death wait must resolve when the forwarder task ends")
            .expect("join");
    }

    /// With no death signal wired, the wait never resolves — the session
    /// liveness watch alone governs liveness (defensive default).
    #[tokio::test]
    async fn no_forwarder_signal_never_resolves() {
        let r = tokio::time::timeout(Duration::from_millis(100), wait_forwarder_death(None)).await;
        assert!(r.is_err(), "no death signal ⇒ the wait must never resolve");
    }

    /// A remote-forward tunnel has no liveness watch; `wait_session_death(None)`
    /// must never resolve so the forwarder death signal governs (no spurious
    /// Error). The watch-fires case is covered by the `LivenessWatch` unit tests
    /// in `core` (a real `SshSession` can't be fabricated here).
    #[tokio::test]
    async fn session_death_without_watch_never_resolves() {
        let r = tokio::time::timeout(Duration::from_millis(100), wait_session_death(None)).await;
        assert!(
            r.is_err(),
            "no liveness watch ⇒ the session-death wait must never resolve"
        );
    }

    /// A user Stop cancels the supervisor token *and* (via teardown/abort) ends
    /// the forwarder task, so both signals fire. The supervisor's biased select
    /// must let the cancel win so the stop is never laundered into `Error`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_cancel_wins_the_race_over_forwarder_death() {
        let cancel = CancellationToken::new();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        cancel.cancel();
        drop(tx); // teardown-induced forwarder death also fires

        let outcome = tokio::select! {
            biased;
            _ = cancel.cancelled() => "stopped",
            _ = wait_forwarder_death(Some(rx)) => "died",
        };
        assert_eq!(
            outcome, "stopped",
            "a user stop must win over the teardown-induced forwarder death"
        );
    }

    /// The supervisor death path reaps the tunnel from the active set, dropping
    /// its pool guards (RAII drains the shared session) and recording the cause as
    /// the durable `Error` resting state (#1238). Reproduced with the same
    /// RefPool building blocks the manager holds.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn death_reap_drains_pool_and_records_error() {
        let pool = RefPool::<Arc<TrackedSession>>::new();
        let live = Arc::new(AtomicUsize::new(0));
        let errors = Mutex::new(HashMap::new());

        let mut active: HashMap<String, EndpointGuard> = HashMap::new();
        active.insert(TUNNEL_ID.to_string(), acquire_guard(&pool, &live).await);
        assert_eq!(pool.ref_count(CONN_ID), 1);
        assert_eq!(live.load(Ordering::SeqCst), 1);

        // Supervisor on death: remove the entry (drops guards → RAII pool drain)
        // and record the cause as the resting Error.
        let removed = active.remove(TUNNEL_ID).expect("was active");
        drop(removed);
        record_last_error(
            &errors,
            TUNNEL_ID,
            "connection lost: SSH session closed".to_string(),
        );

        assert!(active.is_empty(), "dead tunnel reaped from the active set");
        assert_eq!(pool.ref_count(CONN_ID), 0, "pool ref count drained to zero");
        assert_eq!(
            live.load(Ordering::SeqCst),
            0,
            "shared session dropped exactly once"
        );
        let (status, msg) = resting_status(false, last_error_for(&errors, TUNNEL_ID));
        assert_eq!(status, TunnelStatus::Error);
        assert_eq!(msg.as_deref(), Some("connection lost: SSH session closed"));
    }

    /// A shared pooled session backing two tunnels: when it dies, each tunnel's
    /// supervisor reaps its own guard and records `Error`, and the underlying
    /// session drains exactly once (ref-count → 0), not once per tunnel.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shared_session_death_errors_both_tunnels_and_drains_once() {
        let pool = RefPool::<Arc<TrackedSession>>::new();
        let live = Arc::new(AtomicUsize::new(0));
        let errors = Mutex::new(HashMap::new());

        let g1 = acquire_guard(&pool, &live).await;
        let g2 = acquire_guard(&pool, &live).await;
        assert_eq!(pool.ref_count(CONN_ID), 2);
        assert_eq!(live.load(Ordering::SeqCst), 1, "one shared session");

        // First tunnel's supervisor reaps; the session lives while a ref remains.
        drop(g1);
        record_last_error(
            &errors,
            "tunnel-a",
            "connection lost: SSH session closed".to_string(),
        );
        assert_eq!(
            live.load(Ordering::SeqCst),
            1,
            "session stays alive while one ref remains"
        );

        // Second tunnel's supervisor reaps; now the shared session drains once.
        drop(g2);
        record_last_error(
            &errors,
            "tunnel-b",
            "connection lost: SSH session closed".to_string(),
        );
        assert_eq!(pool.ref_count(CONN_ID), 0);
        assert_eq!(
            live.load(Ordering::SeqCst),
            0,
            "shared session drained exactly once"
        );
        assert_eq!(
            resting_status(false, last_error_for(&errors, "tunnel-a")).0,
            TunnelStatus::Error
        );
        assert_eq!(
            resting_status(false, last_error_for(&errors, "tunnel-b")).0,
            TunnelStatus::Error
        );
    }

    // ── Reconnect backoff loop (S3, GAP 5, #1246) ──
    //
    // As with the #1243 supervisor, the full reconnect (a real `attempt_reconnect`
    // via the managed TunnelManager) needs an AppHandle + SSH and can't run in a
    // unit test. These lock in the risky part — the backoff schedule and the loop's
    // success/exhaustion/cancel control flow — with injected closures + paused time.

    #[test]
    fn backoff_delay_is_capped_exponential() {
        let base = Duration::from_secs(1);
        let cap = Duration::from_secs(30);
        assert_eq!(backoff_delay(1, base, cap), Duration::from_secs(1));
        assert_eq!(backoff_delay(2, base, cap), Duration::from_secs(2));
        assert_eq!(backoff_delay(3, base, cap), Duration::from_secs(4));
        assert_eq!(backoff_delay(4, base, cap), Duration::from_secs(8));
        assert_eq!(backoff_delay(5, base, cap), Duration::from_secs(16));
        // 32s would exceed the cap → clamped; huge attempts saturate, still clamped.
        assert_eq!(backoff_delay(6, base, cap), cap);
        assert_eq!(backoff_delay(100, base, cap), cap);
    }

    #[tokio::test]
    async fn reconnect_loop_succeeds_on_a_later_attempt() {
        let cancel = CancellationToken::new();
        let mut emitted: Vec<u32> = Vec::new();
        let mut tries = 0u32;
        let outcome = run_reconnect_loop(
            &cancel,
            5,
            Duration::from_millis(1),
            Duration::from_millis(20),
            |n, _delay| emitted.push(n),
            |n| {
                tries += 1;
                n == 3 // succeeds on the 3rd attempt
            },
        )
        .await;
        assert_eq!(outcome, ReconnectOutcome::Reconnected);
        assert_eq!(
            emitted,
            vec![1, 2, 3],
            "emits Reconnecting once per attempt"
        );
        assert_eq!(tries, 3);
    }

    #[tokio::test]
    async fn reconnect_loop_exhausts_to_error() {
        let cancel = CancellationToken::new();
        let mut emitted: Vec<u32> = Vec::new();
        let outcome = run_reconnect_loop(
            &cancel,
            5,
            Duration::from_millis(1),
            Duration::from_millis(20),
            |n, _delay| emitted.push(n),
            |_| false, // every attempt fails
        )
        .await;
        assert_eq!(outcome, ReconnectOutcome::Exhausted);
        assert_eq!(emitted, vec![1, 2, 3, 4, 5], "exhausts after max attempts");
    }

    #[tokio::test]
    async fn reconnect_loop_stop_wins_over_backoff() {
        let cancel = CancellationToken::new();
        cancel.cancel(); // a user Stop arrived before/during backoff
        let mut tries = 0u32;
        let outcome = run_reconnect_loop(
            &cancel,
            5,
            Duration::from_millis(1),
            Duration::from_millis(20),
            |_, _| {},
            |_| {
                tries += 1;
                true
            },
        )
        .await;
        assert_eq!(outcome, ReconnectOutcome::Cancelled);
        assert_eq!(tries, 0, "Stop wins the race — no reconnect attempt runs");
    }

    /// #2168 regression: `lib.rs` registers the tunnel manager as
    /// `app.manage(Arc::new(manager))`, and the reconnect-backoff loop resolves
    /// it via [`resolve_managed_arc`]. Tauri keys managed state by exact
    /// `TypeId`, so an `Arc<T>` registration is reachable **only** through an
    /// `Arc<T>` lookup — the original bare `try_state::<TunnelManager>()`
    /// silently returned `None`, turning every reconnect attempt into a no-op
    /// `false`. A live mock `Manager` (the only way to exercise real Tauri state
    /// resolution off the `Wry` app) locks the contract: the production resolver
    /// sees the `Arc` registration and yields a real, callable handle, while the
    /// bare-type lookup that caused the bug does not.
    #[test]
    fn resolve_managed_arc_matches_the_arc_registration() {
        /// Stand-in for the managed manager. `attempt` mirrors a real
        /// `attempt_reconnect` on the resolved handle — proving resolution
        /// drives an actual call, not the no-op `false` of the missed lookup.
        struct FakeManager {
            reconnects: AtomicUsize,
        }
        impl FakeManager {
            fn attempt(&self) -> bool {
                self.reconnects.fetch_add(1, Ordering::SeqCst);
                true
            }
        }

        let app = tauri::test::mock_app();
        let managed = Arc::new(FakeManager {
            reconnects: AtomicUsize::new(0),
        });
        // Register exactly as `lib.rs` does for the tunnel manager.
        app.manage(managed.clone());

        // The production resolver matches the `Arc<T>` registration…
        let resolved = resolve_managed_arc::<FakeManager, _>(app.handle())
            .expect("Arc<T> registration must resolve through the Arc<T> lookup");
        assert!(
            Arc::ptr_eq(&managed, &resolved),
            "resolver returns the very manager that was registered",
        );

        // …and drives a real call on it (the #2168 no-op path returned `false`
        // without ever reaching the manager).
        assert!(resolved.attempt());
        assert_eq!(managed.reconnects.load(Ordering::SeqCst), 1);

        // The original bare-type lookup can never match an `Arc<T>`
        // registration — this is the exact miss that broke reconnect.
        assert!(
            app.try_state::<FakeManager>().is_none(),
            "#2168: a bare `try_state::<TunnelManager>()` misses the Arc registration",
        );
    }

    // --- GAP 6: live tunnel-stats emitter (#1248) --------------------------
    //
    // Driving the full periodic emitter loop needs a live Tauri `AppHandle`
    // (for `emit`) plus real forwarders (an `ActiveTunnel` holds an SSH-backed
    // `ActiveForwarder` that cannot be fabricated without a server), which
    // `src-tauri` has no mock harness for. So — like the GAP-3 / GAP-8 tests
    // above — these exercise the production building blocks the emitter uses
    // directly: the shared `ForwarderStats` atomics the forwarders update under
    // traffic, the `TunnelStatsUpdate` event payload shape the frontend reads,
    // and the `snapshot_active_stats` "nothing active -> nothing to emit"
    // predicate that stops the task.

    /// GAP 6: after simulated traffic the forwarder's live counters read back
    /// non-zero — so the emitter ships real ↑/↓ bytes and connection counts,
    /// not the frozen `TunnelStats::default()` zeros of the status event.
    #[test]
    fn forwarder_stats_reflect_simulated_traffic() {
        let stats = ForwarderStats::new();
        // Two connections opened, one already closed.
        stats.increment_active();
        stats.increment_active();
        stats.decrement_active();
        stats.add_bytes_sent(1500);
        stats.add_bytes_received(4096);

        let snapshot = stats.to_tunnel_stats();
        assert_eq!(snapshot.bytes_sent, 1500);
        assert_eq!(snapshot.bytes_received, 4096);
        assert_eq!(snapshot.active_connections, 1, "one of two still open");
        assert_eq!(snapshot.total_connections, 2, "total never decrements");
    }

    /// GAP 6: the emitted payload serializes to the exact shape the frontend
    /// `onTunnelStatsUpdated` listener reads — snake_case `tunnel_id` plus a
    /// camelCase `stats` object (`bytesSent`/`bytesReceived`/…). A regression
    /// here would silently freeze the sidebar at 0.
    #[test]
    fn stats_update_payload_matches_frontend_shape() {
        let stats = ForwarderStats::new();
        stats.increment_active();
        stats.add_bytes_sent(2048);
        stats.add_bytes_received(1024);

        let update = TunnelStatsUpdate {
            tunnel_id: "tunnel-1".to_string(),
            stats: stats.to_tunnel_stats(),
        };
        let json = serde_json::to_value(&update).expect("serialize payload");

        assert_eq!(
            json.get("tunnel_id").and_then(|v| v.as_str()),
            Some("tunnel-1")
        );
        let stats_json = json.get("stats").expect("stats object");
        assert_eq!(
            stats_json.get("bytesSent").and_then(|v| v.as_u64()),
            Some(2048)
        );
        assert_eq!(
            stats_json.get("bytesReceived").and_then(|v| v.as_u64()),
            Some(1024)
        );
        assert_eq!(
            stats_json.get("activeConnections").and_then(|v| v.as_u64()),
            Some(1)
        );
        assert_eq!(
            stats_json.get("totalConnections").and_then(|v| v.as_u64()),
            Some(1)
        );
    }

    /// GAP 6: with no tunnel active the emit tick produces no payloads — the
    /// empty-vec signal the emitter task uses to stop itself once the last
    /// tunnel goes away (a dead/errored tunnel reaped by its supervisor #1243).
    #[test]
    fn snapshot_of_empty_active_set_is_empty_and_stops_emitter() {
        let active: HashMap<String, ActiveTunnel> = HashMap::new();
        let updates = snapshot_active_stats(&active);
        assert!(
            updates.is_empty(),
            "no active tunnel must yield no stats events so the emitter stops"
        );
    }
}
