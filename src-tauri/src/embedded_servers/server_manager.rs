//! Desktop host for the embedded HTTP/FTP/TFTP servers.
//!
//! Each configured server is an [`EmbeddedServerService`] behind the core
//! [`Service`](termihub_core::service::Service) trait (#2154, following the
//! HTTP-monitor pilot #2157/#2172). The manager owns the persisted configs, a
//! map of live services, and a [`RunLocationResolver`] deciding where a server
//! runs. Each service emits its status transitions on a core
//! [`EventChannel`](termihub_core::service::EventChannel); the manager bridges
//! those to the existing `embedded-server-status-changed` Tauri event, so the
//! frontend contract is unchanged.
//!
//! # Agent-hosted servers (#2214)
//!
//! A server whose run-location resolves to an agent runs its listen socket **on
//! that agent**: the desktop keeps only control, driving it over the agent RPC's
//! `service.start` / `service.stop` / `service.status` methods (protocol 0.7.0,
//! #2192). This mirrors [`tunnel_manager`](crate::tunnel::tunnel_manager)'s
//! agent-hosted tunnels (#2185). The per-server run-location preference lives in
//! an in-memory map today; the selector UI that records a non-default choice is a
//! later S-phase (a sibling follow-up to #2214).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter};
use termihub_core::service::drain_broadcast;

use super::activity::ActivitySnapshot;
use super::config::{
    EmbeddedServerConfig, EmbeddedServerStore, ServerState, ServerStats, ServerStatus,
};
use super::service::{
    auto_start_error_state, service_id_for, EmbeddedServerService, STATUS_EVENT_KIND,
};
use super::storage::EmbeddedServerStorage;
use crate::agent_service::{
    agent_rpc_client, AgentHosted, AgentInstances, AgentStatusPollDelegate, AgentStatusPoller,
};
use crate::connection::recovery::RecoveryWarning;
use crate::run_location::{Locality, ResolvedLocation, RunLocation, RunLocationResolver};
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

use termihub_core::protocol::methods::{
    EmbeddedServerActivityParams, EmbeddedServerActivityResult, EmbeddedServerClearActivityParams,
    ServiceStartParams, ServiceStartResult, ServiceStatusParams, ServiceStatusResult,
    ServiceStopParams, EMBEDDED_SERVER_ACTIVITY, EMBEDDED_SERVER_CLEAR_ACTIVITY,
};
use termihub_core::service::{Service, ServiceStatus};

/// Tauri event forwarded to the frontend for each embedded server status change.
///
/// A server's [`EmbeddedServerService`] emits the status on its core
/// [`EventChannel`](termihub_core::service::EventChannel); the manager bridges it
/// to this Tauri event so the frontend receives the same `ServerState` payload as
/// before the lift. An agent-hosted server (#2214) reaches the same event via the
/// `service.status` poller below, so the frontend cannot tell where it runs.
const SERVER_STATUS_EVENT: &str = "embedded-server-status-changed";

/// How often the agent `service.status` poller samples each agent-hosted server
/// (#2214). Matches the tunnel poller cadence (#2199).
const STATUS_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// An embedded server hosted on a remote agent (#2214).
///
/// The listen socket, the served files, and the traffic counters all live on the
/// agent; the desktop holds only *control* — which agent runs it — and the last
/// [`ServerState`] the `service.status` poller sampled off the agent, so
/// [`EmbeddedServerManager::get_states`] can project the agent-hosted server just
/// like a desktop-hosted one.
struct AgentServerHandle {
    /// The agent hosting this server.
    agent_id: String,
    /// The most recent state sampled from the agent (seeded from the
    /// `service.start` reply, refreshed each `service.status` poll tick).
    last_state: ServerState,
}

impl AgentHosted for AgentServerHandle {
    fn agent_id(&self) -> &str {
        &self.agent_id
    }
}

/// Central manager for embedded HTTP/FTP/TFTP servers.
///
/// Follows the same pattern as `NetworkManager` (#2172): holds the services and
/// routes each start through the [`RunLocationResolver`].
pub struct EmbeddedServerManager {
    configs: Mutex<EmbeddedServerStore>,
    storage: EmbeddedServerStorage,
    /// Live services keyed by config id (running **or** stopped-but-listed).
    services: Mutex<HashMap<String, EmbeddedServerService>>,
    /// Servers currently hosted on a remote agent, keyed by config id (#2214).
    /// Disjoint from `services` (which holds desktop-hosted servers): an
    /// agent-hosted server's data path runs on the agent, so the desktop tracks
    /// only the control handle here. `Arc`-shared so the periodic
    /// `service.status` poller task can refresh each handle without a `&self`
    /// reference. The shared [`AgentInstances`] tracker folds the map boilerplate
    /// (DUP-020 follow-up, #2884).
    agent_servers: AgentInstances<AgentServerHandle>,
    /// Per-server run-location preference — which machine hosts each server
    /// (#2214). In-memory today; the selector UI that persists a non-default
    /// choice is a later S-phase. An absent entry means
    /// [`RunLocation::ThisComputer`] (the desktop), today's behaviour.
    run_locations: Mutex<HashMap<String, RunLocation>>,
    /// Resolver deciding where a server runs (local vs agent). Honours the
    /// per-server preference in `run_locations`; a server with no recorded
    /// preference resolves local, so users see no behaviour change.
    run_location: RunLocationResolver,
    /// The single periodic agent `service.status` poller (#2214). Runs while at
    /// least one agent-hosted server exists, self-reaping once none remain; the
    /// shared [`AgentStatusPoller`] owns the task lifecycle (DUP-020).
    agent_status_poller: AgentStatusPoller,
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
            services: Mutex::new(HashMap::new()),
            agent_servers: AgentInstances::new(),
            run_locations: Mutex::new(HashMap::new()),
            run_location: RunLocationResolver::new(),
            agent_status_poller: AgentStatusPoller::new(),
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
        let store = self.lock_configs()?;
        Ok(store.servers.clone())
    }

    /// Set (or clear) the run-location preference for a server (#2214).
    ///
    /// [`RunLocation::ThisComputer`] clears the entry (back to the desktop
    /// default); a [`RunLocation::Agent`] records which agent should host the
    /// server on its next start. This is the desktop-side preference the S1
    /// resolver was designed around; the selector UI that calls it lands in a
    /// later S-phase (a sibling follow-up), and it is the test hook for the
    /// agent-hosted path meanwhile.
    pub fn set_run_location(
        &self,
        server_id: &str,
        location: RunLocation,
    ) -> Result<(), TerminalError> {
        let mut map = self
            .run_locations
            .lock()
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))?;
        match location {
            RunLocation::ThisComputer => {
                map.remove(server_id);
            }
            agent @ RunLocation::Agent(_) => {
                map.insert(server_id.to_string(), agent);
            }
        }
        Ok(())
    }

    /// Read a server's recorded run-location preference, defaulting to
    /// [`RunLocation::ThisComputer`] when none is set (#2214).
    fn requested_run_location(&self, server_id: &str) -> RunLocation {
        self.run_locations
            .lock()
            .ok()
            .and_then(|map| map.get(server_id).cloned())
            .unwrap_or_default()
    }

    /// Add or update a server configuration.
    pub fn save_config(&self, config: EmbeddedServerConfig) -> Result<(), TerminalError> {
        let mut store = self.lock_configs()?;
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
        if let Ok(mut services) = self.services.lock() {
            services.remove(server_id);
        }
        if let Ok(mut locations) = self.run_locations.lock() {
            locations.remove(server_id);
        }
        let mut store = self.lock_configs()?;
        store.servers.retain(|s| s.id != server_id);
        self.storage
            .save(&store)
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Save failed: {e}")))?;
        Ok(())
    }

    /// Return the current runtime state of every configured server.
    pub fn get_states(&self) -> Result<Vec<ServerState>, TerminalError> {
        let store = self.lock_configs()?;
        let services = self.lock_services()?;
        let agent_servers = self.lock_agent_servers()?;
        let states = store
            .servers
            .iter()
            .map(|cfg| {
                // An agent-hosted server (#2214) reports the last state sampled
                // off the agent; otherwise fall back to the desktop service (or a
                // synthetic Stopped state for a never-started server).
                if let Some(handle) = agent_servers.get(&cfg.id) {
                    handle.last_state.clone()
                } else {
                    services
                        .get(&cfg.id)
                        .and_then(|svc| svc.state())
                        .unwrap_or_else(|| stopped_state(&cfg.id))
                }
            })
            .collect();
        Ok(states)
    }

    /// Start a server by ID.
    ///
    /// The run-location is resolved through the [`RunLocationResolver`] from the
    /// server's recorded preference (default: local). A server resolving to an
    /// agent is hosted on that agent over the agent RPC (#2214); the desktop path
    /// below is unchanged. The server's status transitions are emitted on its core
    /// [`EventChannel`](termihub_core::service::EventChannel) (local) or bridged
    /// from the agent poller, both reaching the [`SERVER_STATUS_EVENT`] Tauri
    /// event.
    pub fn start_server(&self, server_id: &str) -> Result<(), TerminalError> {
        let config = {
            let store = self.lock_configs()?;
            store
                .servers
                .iter()
                .find(|s| s.id == server_id)
                .cloned()
                .ok_or_else(|| {
                    TerminalError::EmbeddedServerError(format!("Server not found: {server_id}"))
                })?
        };

        // Route by run-location (#2214). A server with no recorded preference
        // resolves local and takes the existing desktop path; an agent preference
        // routes hosting to that agent over the agent RPC.
        match self.run_location.resolve(
            server_id,
            Locality::LocalOrAgent,
            &self.requested_run_location(server_id),
        ) {
            Ok(ResolvedLocation::Local) => {}
            Ok(ResolvedLocation::Agent(agent_id)) => {
                return self.start_agent_service(server_id, &config, &agent_id);
            }
            Err(e) => return Err(TerminalError::EmbeddedServerError(e.to_string())),
        }

        let mut services = self.lock_services()?;
        // Reuse an existing (stopped) service so its event channel + bridge task
        // persist across restarts; create + bridge a fresh one otherwise.
        if !services.contains_key(server_id) {
            let service = EmbeddedServerService::new(config.server_type.clone());
            // Subscribe before starting so the bridge cannot miss the first
            // Starting transition.
            spawn_event_bridge(self.app_handle.clone(), service.subscribe_events());
            services.insert(server_id.to_string(), service);
        }
        let service = services.get_mut(server_id).ok_or_else(|| {
            TerminalError::EmbeddedServerError(
                "embedded server service missing immediately after insert".to_string(),
            )
        })?;
        service.start_with(config).map_err(Into::into)
    }

    /// Start a server hosted on a remote agent (#2214).
    ///
    /// The agent runs the listen socket; the desktop sends only control over the
    /// agent RPC. Sends `service.start` with the desktop config id as the
    /// instance id, the server-type `service_id`, and the full
    /// [`EmbeddedServerConfig`] — mirroring
    /// [`tunnel_manager::start_agent_tunnel`](crate::tunnel::tunnel_manager). On
    /// success the agent-reported state is stored for the projection and streamed
    /// to the frontend, and the `service.status` poller is (re)started.
    fn start_agent_service(
        &self,
        server_id: &str,
        config: &EmbeddedServerConfig,
        agent_id: &str,
    ) -> Result<(), TerminalError> {
        // Reject a double-start on an agent.
        if self.lock_agent_servers()?.contains_key(server_id) {
            return Err(TerminalError::EmbeddedServerError(format!(
                "Server {server_id} is already running on an agent"
            )));
        }

        let params = service_start_params(server_id, config)?;

        let agent_manager = agent_rpc_client(&self.app_handle).ok_or_else(|| {
            TerminalError::EmbeddedServerError("Agent manager is not available".to_string())
        })?;

        match agent_manager.send_request(
            agent_id,
            termihub_core::protocol::methods::SERVICE_START,
            params,
        ) {
            Ok(result) => {
                let state = server_state_from_start_reply(server_id, &result);
                {
                    let mut agent_servers = self.lock_agent_servers()?;
                    agent_servers.insert(
                        server_id.to_string(),
                        AgentServerHandle {
                            agent_id: agent_id.to_string(),
                            last_state: state.clone(),
                        },
                    );
                }
                let _ = self.app_handle.emit(SERVER_STATUS_EVENT, &state);
                // Sample the agent's status periodically so a later transition
                // (e.g. a crash → Error) and live stats reach the frontend.
                self.ensure_status_poller();
                tracing::info!("Embedded server {server_id} started on agent {agent_id}");
                Ok(())
            }
            Err(e) => {
                let message = format!("agent-hosted embedded server start failed: {e}");
                let state = auto_start_error_state(server_id, &message);
                let _ = self.app_handle.emit(SERVER_STATUS_EVENT, &state);
                Err(TerminalError::EmbeddedServerError(message))
            }
        }
    }

    /// Stop an agent-hosted server, if `server_id` is one. Returns `true` when a
    /// handle was found and a `service.stop` sent to the agent (best-effort — the
    /// desktop drops its handle regardless so the UI reflects the stop).
    fn stop_agent_service(&self, server_id: &str) -> bool {
        let Some(handle) = self.agent_servers.remove(server_id) else {
            return false;
        };
        if let Some(agent_manager) = agent_rpc_client(&self.app_handle) {
            match serde_json::to_value(ServiceStopParams {
                instance_id: server_id.to_string(),
            }) {
                Ok(params) => {
                    if let Err(e) = agent_manager.send_request(
                        &handle.agent_id,
                        termihub_core::protocol::methods::SERVICE_STOP,
                        params,
                    ) {
                        tracing::warn!(
                            "Failed to stop agent-hosted embedded server {} on agent {}: {}",
                            server_id,
                            handle.agent_id,
                            e
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to build service.stop params for {server_id}: {e}")
                }
            }
        }
        let _ = self
            .app_handle
            .emit(SERVER_STATUS_EVENT, &stopped_state(server_id));
        tracing::info!(
            "Embedded server {} stopped on agent {}",
            server_id,
            handle.agent_id
        );
        true
    }

    /// Stop a running server by ID (kept listed as `Stopped`).
    pub fn stop_server(&self, server_id: &str) -> Result<(), TerminalError> {
        // Agent-hosted servers live in their own track: send `service.stop` to
        // the agent and drop the control handle (#2214).
        if self.stop_agent_service(server_id) {
            return Ok(());
        }
        let mut services = self.lock_services()?;
        if let Some(service) = services.get_mut(server_id) {
            service.shutdown();
        }
        Ok(())
    }

    /// Where `server_id`'s access log lives (#3453): on the agent currently
    /// hosting it, else on this desktop (which also covers an unknown server —
    /// its desktop read is simply `None`).
    pub fn activity_route(&self, server_id: &str) -> Result<ActivityRoute, TerminalError> {
        let agent_servers = self.lock_agent_servers()?;
        Ok(route_for(
            agent_servers.get(server_id).map(|h| h.agent_id.as_str()),
        ))
    }

    /// The agent RPC client, for reading an agent-hosted server's log.
    pub fn agent_client(&self) -> Option<Arc<dyn AgentRpcClient>> {
        agent_rpc_client(&self.app_handle)
    }

    /// Read a **desktop-hosted** server's access log (entries newer than
    /// `since`) plus its detailed statistics (PROD-034, PROD-036).
    ///
    /// `None` when the server has never run on this desktop. An agent-hosted
    /// server's log is read over the agent RPC instead — see
    /// [`activity_route`](Self::activity_route) and [`fetch_agent_activity`].
    pub fn get_activity(
        &self,
        server_id: &str,
        since: Option<u64>,
    ) -> Result<Option<ActivitySnapshot>, TerminalError> {
        let services = self.lock_services()?;
        Ok(read_activity(&services, server_id, since))
    }

    /// Clear a **desktop-hosted** server's access log and its request/error/top
    /// counters. A no-op for a server with no desktop-hosted log.
    pub fn clear_activity(&self, server_id: &str) -> Result<(), TerminalError> {
        if let Some(service) = self.lock_services()?.get(server_id) {
            service.clear_activity();
        }
        Ok(())
    }

    /// Stop all running servers (called on app shutdown).
    pub fn stop_all(&self) {
        if let Ok(mut services) = self.services.lock() {
            for (id, service) in services.iter_mut() {
                service.shutdown();
                tracing::debug!(%id, "Stopped embedded server during teardown");
            }
        } else {
            tracing::error!("embedded server services lock poisoned during stop_all");
        }

        // Tear down agent-hosted servers too (#2214): `service.stop` each one and
        // drop its handle, then abort the poller.
        for id in self.agent_servers.ids() {
            self.stop_agent_service(&id);
        }
        self.agent_status_poller.stop();
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
                    // instead of silently leaving it stopped (GAP G7, #1145). A
                    // pre-flight failure returns before the service emits, so the
                    // manager emits the Error state here.
                    let msg = e.to_string();
                    tracing::warn!(id = %cfg.id, "Failed to auto-start embedded server: {msg}");
                    let state = auto_start_error_state(&cfg.id, &msg);
                    let _ = self.app_handle.emit(SERVER_STATUS_EVENT, &state);
                }
            }
        }
    }

    /// Ensure the single periodic agent `service.status` poller is running
    /// (#2214). Idempotent; the shared [`AgentStatusPoller`] owns the task
    /// lifecycle and the [`EmbeddedServerPoll`] delegate supplies the
    /// service-specific poll + write-back/emit (DUP-020).
    fn ensure_status_poller(&self) {
        self.agent_status_poller.ensure(EmbeddedServerPoll {
            agent_servers: self.agent_servers.clone(),
            app: self.app_handle.clone(),
        });
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    fn lock_configs(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, EmbeddedServerStore>, TerminalError> {
        self.configs
            .lock()
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))
    }

    fn lock_services(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, EmbeddedServerService>>, TerminalError>
    {
        self.services
            .lock()
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))
    }

    fn lock_agent_servers(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, AgentServerHandle>>, TerminalError> {
        self.agent_servers
            .lock()
            .map_err(|e| TerminalError::EmbeddedServerError(format!("Lock error: {e}")))
    }
}

/// Resolve the activity snapshot for `server_id` (see
/// [`EmbeddedServerManager::get_activity`]). A pure helper so the routing can be
/// unit-tested without an `AppHandle`.
fn read_activity(
    services: &HashMap<String, EmbeddedServerService>,
    server_id: &str,
    since: Option<u64>,
) -> Option<ActivitySnapshot> {
    services
        .get(server_id)
        .map(|svc| svc.activity_snapshot(since))
}

/// Where an embedded server's access log is read from (#3453).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivityRoute {
    /// Hosted on this agent: read over `embedded_server.activity`.
    Agent(String),
    /// Desktop-hosted, or not running anywhere: read the desktop service.
    Desktop,
}

/// Pure routing decision behind [`EmbeddedServerManager::activity_route`].
fn route_for(hosting_agent: Option<&str>) -> ActivityRoute {
    match hosting_agent {
        Some(agent_id) => ActivityRoute::Agent(agent_id.to_string()),
        None => ActivityRoute::Desktop,
    }
}

/// Whether `agent_id` advertised the `embeddedServerActivity` capability.
fn agent_supports_activity(client: &dyn AgentRpcClient, agent_id: &str) -> bool {
    client
        .get_capabilities(agent_id)
        .is_some_and(|caps| caps.embedded_server_activity)
}

/// Read an agent-hosted server's access log + detailed stats over the agent
/// RPC (#3453). Blocking — call from `spawn_blocking`.
///
/// `Ok(None)` when the agent predates the RPC (no `embeddedServerActivity`
/// capability, or it answers "method not found") or no longer hosts the
/// server; a transport/agent error is returned as `Err`.
pub fn fetch_agent_activity(
    client: &dyn AgentRpcClient,
    agent_id: &str,
    server_id: &str,
    since: Option<u64>,
) -> Result<Option<ActivitySnapshot>, TerminalError> {
    agent_activity_via(
        agent_supports_activity(client, agent_id),
        |method, params| client.send_request(agent_id, method, params),
        server_id,
        since,
    )
}

/// Clear an agent-hosted server's access log over the agent RPC (#3453). A
/// no-op against an agent that predates the RPC. Blocking — call from
/// `spawn_blocking`.
pub fn clear_agent_activity(
    client: &dyn AgentRpcClient,
    agent_id: &str,
    server_id: &str,
) -> Result<(), TerminalError> {
    clear_agent_activity_via(
        agent_supports_activity(client, agent_id),
        |method, params| client.send_request(agent_id, method, params),
        server_id,
    )
}

/// Testable core of [`fetch_agent_activity`]: `supported` is the capability,
/// `send` performs the RPC.
fn agent_activity_via(
    supported: bool,
    send: impl FnOnce(&str, serde_json::Value) -> Result<serde_json::Value, TerminalError>,
    server_id: &str,
    since: Option<u64>,
) -> Result<Option<ActivitySnapshot>, TerminalError> {
    if !supported {
        return Ok(None);
    }
    let params = serde_json::to_value(EmbeddedServerActivityParams {
        server_id: server_id.to_string(),
        since_seq: since,
    })
    .map_err(|e| TerminalError::EmbeddedServerError(format!("Failed to build params: {e}")))?;
    let reply = match send(EMBEDDED_SERVER_ACTIVITY, params) {
        Ok(reply) => reply,
        // Defensive: an agent that advertised the capability but lacks the
        // method still degrades to "no log", never an error toast.
        Err(TerminalError::AgentUnsupported(_)) => return Ok(None),
        Err(e) => return Err(e),
    };
    let result: EmbeddedServerActivityResult = serde_json::from_value(reply).map_err(|e| {
        TerminalError::EmbeddedServerError(format!("Invalid embedded_server.activity reply: {e}"))
    })?;
    Ok(result.activity)
}

/// Testable core of [`clear_agent_activity`].
fn clear_agent_activity_via(
    supported: bool,
    send: impl FnOnce(&str, serde_json::Value) -> Result<serde_json::Value, TerminalError>,
    server_id: &str,
) -> Result<(), TerminalError> {
    if !supported {
        return Ok(());
    }
    let params = serde_json::to_value(EmbeddedServerClearActivityParams {
        server_id: server_id.to_string(),
    })
    .map_err(|e| TerminalError::EmbeddedServerError(format!("Failed to build params: {e}")))?;
    match send(EMBEDDED_SERVER_CLEAR_ACTIVITY, params) {
        Ok(_) | Err(TerminalError::AgentUnsupported(_)) => Ok(()),
        Err(e) => Err(e),
    }
}

/// A synthetic `Stopped` [`ServerState`] for a server that is not running.
fn stopped_state(server_id: &str) -> ServerState {
    ServerState {
        server_id: server_id.to_string(),
        status: ServerStatus::Stopped,
        error: None,
        stats: ServerStats::default(),
        started_at: None,
    }
}

/// Build the `service.start` RPC params the agent parses into `ServiceStartParams`
/// (#2214).
///
/// The instance id is the desktop config id (so later stop/status key off it),
/// the service id is the server type's registered id, and the config is the full
/// [`EmbeddedServerConfig`]. Pure so the wire shape is unit-testable.
fn service_start_params(
    server_id: &str,
    config: &EmbeddedServerConfig,
) -> Result<serde_json::Value, TerminalError> {
    let config_value = serde_json::to_value(config).map_err(|e| {
        TerminalError::EmbeddedServerError(format!("Failed to serialize server config: {e}"))
    })?;
    serde_json::to_value(ServiceStartParams {
        instance_id: server_id.to_string(),
        service_id: service_id_for(&config.server_type).to_string(),
        config: config_value,
    })
    .map_err(|e| {
        TerminalError::EmbeddedServerError(format!("Failed to build service.start params: {e}"))
    })
}

/// Parse an agent `service.start` reply into the desktop [`ServerState`] (#2214).
///
/// Prefers the streamed `state` payload (a full `ServerState` with live stats);
/// falls back to synthesizing one from the lifecycle `status` when no event has
/// been emitted yet. Pure, so it is unit-testable without an agent mock.
fn server_state_from_start_reply(server_id: &str, reply: &serde_json::Value) -> ServerState {
    // Deserialize the reply into the shared `ServiceStartResult` wire DTO
    // (DUP-001). A reply that doesn't even carry a lifecycle status degrades to
    // `Stopped`, matching the old parser's null-status fallback.
    match serde_json::from_value::<ServiceStartResult>(reply.clone()) {
        Ok(result) => result
            .state
            .as_ref()
            .and_then(|state| server_state_from_value(server_id, state))
            .unwrap_or_else(|| synth_state_from_service_status(server_id, &result.status)),
        Err(_) => synth_state_from_service_status(server_id, &ServiceStatus::Stopped),
    }
}

/// Parse an agent `service.status` reply into a [`ServerState`], or `None` when
/// the instance is not running on the agent (#2214). Pure, so the parse is
/// unit-testable without an agent mock.
fn server_state_from_status_reply(
    server_id: &str,
    reply: &serde_json::Value,
) -> Option<ServerState> {
    // Deserialize into the shared `ServiceStatusResult` wire DTO (DUP-001); an
    // unparseable reply or a not-running instance yields no sample.
    let result = serde_json::from_value::<ServiceStatusResult>(reply.clone()).ok()?;
    if !result.running {
        return None;
    }
    let fallback = ServiceStatus::Stopped;
    Some(
        result
            .state
            .as_ref()
            .and_then(|state| server_state_from_value(server_id, state))
            .unwrap_or_else(|| {
                synth_state_from_service_status(
                    server_id,
                    result.status.as_ref().unwrap_or(&fallback),
                )
            }),
    )
}

/// Parse a streamed `state` payload (a serialized [`ServerState`]) into one keyed
/// by the desktop `server_id`. Returns `None` for a null/unparseable payload.
fn server_state_from_value(server_id: &str, state: &serde_json::Value) -> Option<ServerState> {
    if state.is_null() {
        return None;
    }
    let mut parsed: ServerState = serde_json::from_value(state.clone()).ok()?;
    // Normalise to the desktop config id (defensive — the agent already keys off
    // it, since the instance id is the config id).
    parsed.server_id = server_id.to_string();
    Some(parsed)
}

/// Synthesize a [`ServerState`] from the typed core [`ServiceStatus`] when no
/// full state payload is available.
///
/// Projects the lifecycle status onto the embedded-server `(ServerStatus, error)`
/// pair via the single shared conversion (DUP-022) — so the variant relationship
/// between the two enums is defined in one place, not hand-matched here as well.
fn synth_state_from_service_status(server_id: &str, status: &ServiceStatus) -> ServerState {
    let (server_status, error) = ServerStatus::from_service_status(status);
    ServerState {
        server_id: server_id.to_string(),
        status: server_status,
        error,
        stats: ServerStats::default(),
        started_at: None,
    }
}

/// The embedded-server side of the shared agent status poller (DUP-020).
///
/// Supplies the service-specific pieces to [`AgentStatusPoller`]: the live
/// agent-server targets, the `service.status` batch (via
/// [`poll_agent_server_states`]), and the write-back that re-emits
/// [`SERVER_STATUS_EVENT`] only on a status/error transition — matching the
/// desktop service, which emits on transitions, not every tick.
struct EmbeddedServerPoll {
    agent_servers: AgentInstances<AgentServerHandle>,
    app: AppHandle,
}

impl AgentStatusPollDelegate for EmbeddedServerPoll {
    type Sample = ServerState;

    fn interval(&self) -> Duration {
        STATUS_POLL_INTERVAL
    }

    fn client(&self) -> Option<Arc<dyn AgentRpcClient>> {
        agent_rpc_client(&self.app)
    }

    fn snapshot_targets(&self) -> (Vec<(String, String)>, bool) {
        self.agent_servers.snapshot_targets()
    }

    fn poll(client: Arc<dyn AgentRpcClient>, targets: &[(String, String)]) -> Vec<ServerState> {
        poll_agent_server_states(client, targets)
    }

    fn apply(&self, samples: Vec<ServerState>) {
        let mut transitions = Vec::new();
        if let Ok(mut map) = self.agent_servers.lock() {
            for state in samples {
                if let Some(handle) = map.get_mut(&state.server_id) {
                    let changed = handle.last_state.status != state.status
                        || handle.last_state.error != state.error;
                    handle.last_state = state.clone();
                    if changed {
                        transitions.push(state);
                    }
                }
            }
        }
        for state in &transitions {
            let _ = self.app.emit(SERVER_STATUS_EVENT, state);
        }
    }
}

/// Poll each agent-hosted server's live `service.status` over the agent RPC,
/// returning the fresh [`ServerState`] per still-running server (#2214).
///
/// Free function (no `&self`) so the poller task can call it inside
/// `spawn_blocking`. A failed RPC or a not-running instance simply contributes no
/// sample, leaving the handle's last-known state in place.
fn poll_agent_server_states(
    client: Arc<dyn AgentRpcClient>,
    targets: &[(String, String)],
) -> Vec<ServerState> {
    let mut out = Vec::with_capacity(targets.len());
    for (server_id, agent_id) in targets {
        let params = match serde_json::to_value(ServiceStatusParams {
            instance_id: server_id.clone(),
        }) {
            Ok(params) => params,
            Err(e) => {
                tracing::debug!("Failed to build service.status params for {server_id}: {e}");
                continue;
            }
        };
        match client.send_request(
            agent_id,
            termihub_core::protocol::methods::SERVICE_STATUS,
            params,
        ) {
            Ok(result) => {
                if let Some(state) = server_state_from_status_reply(server_id, &result) {
                    out.push(state);
                }
            }
            Err(e) => {
                tracing::debug!(
                    "service.status poll for {} on agent {} failed: {}",
                    server_id,
                    agent_id,
                    e
                );
            }
        }
    }
    out
}

/// Bridge a server's core [`EventChannel`](termihub_core::service::EventChannel)
/// to the desktop's Tauri emitter.
///
/// Forwards each `status` [`ServiceEvent`](termihub_core::service::ServiceEvent)
/// as a [`SERVER_STATUS_EVENT`] Tauri event so the frontend receives the same
/// `ServerState` payload as before the lift. The task ends when the service is
/// dropped (channel closed).
fn spawn_event_bridge(app: AppHandle, events: termihub_core::service::ServiceEventReceiver) {
    tauri::async_runtime::spawn(async move {
        drain_broadcast(events, move |event| {
            if event.kind == STATUS_EVENT_KIND {
                let _ = app.emit(SERVER_STATUS_EVENT, event.payload);
            }
        })
        .await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedded_servers::config::ServerType;
    use serde_json::json;

    fn sample_config() -> EmbeddedServerConfig {
        EmbeddedServerConfig {
            id: "srv-1".to_string(),
            name: "Test HTTP".to_string(),
            server_type: ServerType::Http,
            root_directory: "/tmp".to_string(),
            bind_host: "127.0.0.1".to_string(),
            port: 8080,
            auto_start: false,
            read_only: true,
            directory_listing: Some(true),
            ftp_auth: None,
            http_auth: None,
            max_transfer_bytes: None,
        }
    }

    /// The `service.start` params carry the instance id (the config id), the
    /// server-type service id, and the full config — the exact shape the agent
    /// parses into `ServiceStartParams` (#2214). Locks the desktop side of that
    /// wire contract; the agent side is locked in `agent/src/protocol/methods.rs`.
    #[test]
    fn service_start_params_carry_instance_service_and_config() {
        let config = sample_config();
        let params = service_start_params("srv-1", &config).expect("params build");
        assert_eq!(params["instanceId"], "srv-1");
        assert_eq!(params["serviceId"], "http_server");
        // The config is nested verbatim (camelCase, as the agent expects).
        assert_eq!(params["config"]["id"], "srv-1");
        assert_eq!(params["config"]["serverType"], "http");
        assert_eq!(params["config"]["port"], 8080);
    }

    /// A `service.start` reply with a streamed `state` payload is adopted as-is
    /// (with live stats), re-keyed to the desktop server id (#2214).
    #[test]
    fn start_reply_prefers_the_streamed_state_payload() {
        let reply = json!({
            "status": { "state": "running" },
            "state": {
                "serverId": "srv-1",
                "status": "running",
                "stats": { "activeConnections": 2, "totalConnections": 7,
                           "bytesSent": 1024, "bytesReceived": 512 },
                "startedAt": "2026-07-30T00:00:00Z"
            }
        });
        let state = server_state_from_start_reply("srv-1", &reply);
        assert_eq!(state.server_id, "srv-1");
        assert_eq!(state.status, ServerStatus::Running);
        assert_eq!(state.stats.total_connections, 7);
        assert_eq!(state.started_at.as_deref(), Some("2026-07-30T00:00:00Z"));
    }

    /// With no streamed `state` yet, the reply's lifecycle `status` is
    /// synthesized into a `ServerState` (#2214).
    #[test]
    fn start_reply_falls_back_to_status_when_no_state() {
        let reply = json!({ "status": { "state": "running" } });
        let state = server_state_from_start_reply("srv-2", &reply);
        assert_eq!(state.server_id, "srv-2");
        assert_eq!(state.status, ServerStatus::Running);
        assert!(state.error.is_none());
    }

    /// A `failed` lifecycle status maps to `Error` and carries its detail (#2214).
    #[test]
    fn failed_status_maps_to_error_with_detail() {
        let state = synth_state_from_service_status(
            "srv-3",
            &ServiceStatus::Failed("port in use".to_string()),
        );
        assert_eq!(state.status, ServerStatus::Error);
        assert_eq!(state.error.as_deref(), Some("port in use"));
    }

    /// Every non-failed lifecycle state synthesizes its matching `ServerStatus`
    /// with no error (DUP-022 — the reverse bridge routes through the shared
    /// conversion).
    #[test]
    fn synth_state_maps_each_lifecycle_state() {
        for (status, expected) in [
            (ServiceStatus::Stopped, ServerStatus::Stopped),
            (ServiceStatus::Starting, ServerStatus::Starting),
            (ServiceStatus::Running, ServerStatus::Running),
            (ServiceStatus::Stopping, ServerStatus::Stopping),
        ] {
            let state = synth_state_from_service_status("srv", &status);
            assert_eq!(state.status, expected, "status={status:?}");
            assert!(state.error.is_none(), "status={status:?}");
        }
    }

    /// A start reply whose lifecycle status is unparseable (or absent) degrades
    /// to `Stopped` — the typed-DTO equivalent of the old null-status fallback.
    #[test]
    fn start_reply_with_unparseable_status_degrades_to_stopped() {
        let reply = json!({ "status": { "state": "bogus" } });
        let state = server_state_from_start_reply("srv-9", &reply);
        assert_eq!(state.status, ServerStatus::Stopped);
        assert!(state.error.is_none());
    }

    /// DUP-001: the `service.*` request params serialize byte-for-byte to the
    /// pre-migration hand-built `json!` — a change is a WIRE BREAK, the agent
    /// deserializes them into `ServiceStart/Stop/StatusParams`.
    #[test]
    fn service_params_serialize_matches_hand_built_json() {
        let start = service_start_params("srv-1", &sample_config()).expect("params build");
        assert_eq!(
            start,
            json!({
                "instanceId": "srv-1",
                "serviceId": "http_server",
                "config": serde_json::to_value(sample_config()).unwrap(),
            }),
        );
        assert_eq!(
            serde_json::to_value(ServiceStopParams {
                instance_id: "srv-1".to_string()
            })
            .unwrap(),
            json!({ "instanceId": "srv-1" }),
        );
        assert_eq!(
            serde_json::to_value(ServiceStatusParams {
                instance_id: "srv-1".to_string()
            })
            .unwrap(),
            json!({ "instanceId": "srv-1" }),
        );
    }

    /// A `service.status` reply for a not-running instance yields no sample, so
    /// the poller leaves the last-known state untouched (#2214).
    #[test]
    fn status_reply_not_running_yields_none() {
        let reply = json!({ "running": false });
        assert!(server_state_from_status_reply("srv-1", &reply).is_none());
    }

    /// A running `service.status` reply is parsed into the live state (#2214).
    #[test]
    fn status_reply_running_yields_state() {
        let reply = json!({
            "running": true,
            "status": { "state": "running" },
            "state": {
                "serverId": "srv-1",
                "status": "running",
                "stats": { "activeConnections": 0, "totalConnections": 3,
                           "bytesSent": 0, "bytesReceived": 0 },
                "startedAt": "2026-07-30T00:00:00Z"
            }
        });
        let state = server_state_from_status_reply("srv-1", &reply).expect("running → some");
        assert_eq!(state.status, ServerStatus::Running);
        assert_eq!(state.stats.total_connections, 3);
    }

    // ── access log routing (PROD-034) ─────────────────────────────────────────

    #[test]
    fn read_activity_returns_desktop_service_log() {
        let mut services = HashMap::new();
        services.insert(
            "srv-1".to_string(),
            EmbeddedServerService::new(ServerType::Http),
        );
        let snap = read_activity(&services, "srv-1", None).expect("desktop log");
        assert!(snap.entries.is_empty());
        assert_eq!(
            snap.capacity,
            termihub_core::embedded_servers::activity::ACCESS_LOG_CAPACITY
        );
    }

    #[test]
    fn read_activity_is_none_for_unknown_servers() {
        let mut services = HashMap::new();
        services.insert(
            "srv-1".to_string(),
            EmbeddedServerService::new(ServerType::Http),
        );
        assert!(read_activity(&services, "missing", None).is_none());
    }

    // ── agent-hosted activity routing (#3453) ────────────────────────

    #[test]
    fn activity_routes_to_the_hosting_agent_else_the_desktop() {
        assert_eq!(
            route_for(Some("agent-1")),
            ActivityRoute::Agent("agent-1".to_string())
        );
        // Desktop-hosted and unknown servers both read the desktop service.
        assert_eq!(route_for(None), ActivityRoute::Desktop);
    }

    fn sample_snapshot() -> serde_json::Value {
        serde_json::json!({
            "activity": {
                "entries": [{
                    "seq": 3, "timestamp": "2026-09-26T10:00:00.000Z",
                    "client": "10.0.0.5", "method": "GET", "path": "/a.txt",
                    "status": "200", "success": true, "bytes": 12
                }],
                "latestSeq": 3, "epoch": 1, "dropped": 0, "capacity": 1000,
                "stats": {
                    "activeConnections": 0, "totalConnections": 1,
                    "bytesSent": 12, "bytesReceived": 0,
                    "totalRequests": 1, "errors": 0,
                    "topPaths": [], "topClients": [], "currentTransfers": []
                }
            }
        })
    }

    #[test]
    fn agent_activity_sends_the_rpc_and_parses_the_snapshot() {
        let mut seen = None;
        let snap = agent_activity_via(
            true,
            |method, params| {
                seen = Some((method.to_string(), params));
                Ok(sample_snapshot())
            },
            "srv-1",
            Some(2),
        )
        .expect("ok")
        .expect("snapshot");
        let (method, params) = seen.expect("rpc sent");
        assert_eq!(method, "embedded_server.activity");
        assert_eq!(
            params,
            serde_json::json!({ "serverId": "srv-1", "sinceSeq": 2 })
        );
        assert_eq!(snap.latest_seq, 3);
        assert_eq!(snap.entries.len(), 1);
        assert_eq!(snap.stats.total_requests, 1);
    }

    #[test]
    fn old_agent_without_the_capability_reads_as_none_without_an_rpc() {
        let res = agent_activity_via(
            false,
            |_, _| panic!("must not call an agent lacking the capability"),
            "srv-1",
            None,
        );
        assert!(matches!(res, Ok(None)));
        clear_agent_activity_via(
            false,
            |_, _| panic!("must not call an agent lacking the capability"),
            "srv-1",
        )
        .expect("no-op");
    }

    #[test]
    fn method_not_found_degrades_to_none_other_errors_surface() {
        let res = agent_activity_via(
            true,
            |_, _| Err(TerminalError::AgentUnsupported("nope".into())),
            "srv-1",
            None,
        );
        assert!(matches!(res, Ok(None)));
        let res = agent_activity_via(
            true,
            |_, _| Err(TerminalError::RemoteError("agent gone".into())),
            "srv-1",
            None,
        );
        assert!(matches!(res, Err(TerminalError::RemoteError(_))));
        // An agent that no longer hosts the server answers `activity: null`.
        let res = agent_activity_via(
            true,
            |_, _| Ok(serde_json::json!({ "activity": null })),
            "srv-1",
            None,
        );
        assert!(matches!(res, Ok(None)));
    }

    #[test]
    fn clear_agent_activity_sends_the_rpc() {
        let mut seen = None;
        clear_agent_activity_via(
            true,
            |method, params| {
                seen = Some((method.to_string(), params));
                Ok(serde_json::json!({ "cleared": true }))
            },
            "srv-9",
        )
        .expect("ok");
        let (method, params) = seen.expect("rpc sent");
        assert_eq!(method, "embedded_server.clear_activity");
        assert_eq!(params, serde_json::json!({ "serverId": "srv-9" }));
        assert!(clear_agent_activity_via(
            true,
            |_, _| Err(TerminalError::RemoteError("x".into())),
            "srv-9"
        )
        .is_err());
    }
}
