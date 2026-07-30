//! Desktop host for the embedded HTTP/FTP/TFTP servers.
//!
//! Each configured server is an [`EmbeddedServerService`] behind the core
//! [`Service`](termihub_core::service::Service) trait (#2154, following the
//! HTTP-monitor pilot #2157/#2172). The manager owns the persisted configs, a
//! map of live services, a [`ServiceRegistry`] for run-location discovery, and a
//! [`RunLocationResolver`] deciding where a server runs. Each service emits its
//! status transitions on a core [`EventChannel`](termihub_core::service::EventChannel);
//! the manager bridges those to the existing `embedded-server-status-changed`
//! Tauri event, so the frontend contract is unchanged.
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
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;

use super::config::{
    EmbeddedServerConfig, EmbeddedServerStore, ServerState, ServerStats, ServerStatus,
};
use super::service::{
    auto_start_error_state, service_id_for, EmbeddedServerService, STATUS_EVENT_KIND,
};
use super::storage::EmbeddedServerStorage;
use crate::connection::recovery::RecoveryWarning;
use crate::run_location::{Locality, ResolvedLocation, RunLocation, RunLocationResolver};
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

use termihub_core::service::{Service, ServiceInfo, ServiceRegistry};

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

/// Central manager for embedded HTTP/FTP/TFTP servers.
///
/// Follows the same pattern as `NetworkManager` (#2172): holds the services,
/// registers their types in a [`ServiceRegistry`], and routes each start through
/// the [`RunLocationResolver`].
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
    /// reference.
    agent_servers: Arc<Mutex<HashMap<String, AgentServerHandle>>>,
    /// Per-server run-location preference — which machine hosts each server
    /// (#2214). In-memory today; the selector UI that persists a non-default
    /// choice is a later S-phase. An absent entry means
    /// [`RunLocation::ThisComputer`] (the desktop), today's behaviour.
    run_locations: Mutex<HashMap<String, RunLocation>>,
    /// Registry of run-location-routable server types (discovery, schema,
    /// capabilities). Backs the run-location selector UI (a later S-phase).
    service_registry: ServiceRegistry,
    /// Resolver deciding where a server runs (local vs agent). Honours the
    /// per-server preference in `run_locations`; a server with no recorded
    /// preference resolves local, so users see no behaviour change.
    run_location: RunLocationResolver,
    /// Handle to the single periodic agent `service.status` poller task (#2214).
    /// `Some` while at least one agent-hosted server exists; the task self-reaps
    /// and clears this slot once none remain, and `stop_all` aborts it on
    /// shutdown.
    agent_status_poller: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
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
            agent_servers: Arc::new(Mutex::new(HashMap::new())),
            run_locations: Mutex::new(HashMap::new()),
            service_registry: build_service_registry(),
            run_location: RunLocationResolver::new(),
            agent_status_poller: Arc::new(Mutex::new(None)),
            app_handle: app_handle.clone(),
            recovery_warnings: Mutex::new(result.warnings),
        })
    }

    /// The server types registered for run-location routing (HTTP/FTP/TFTP).
    /// Backs discovery and the run-location selector UI.
    pub fn available_services(&self) -> Vec<ServiceInfo> {
        self.service_registry.available_services()
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
        let service = services
            .get_mut(server_id)
            .expect("service was just inserted");
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
        if self
            .lock_agent_servers()?
            .contains_key(server_id)
        {
            return Err(TerminalError::EmbeddedServerError(format!(
                "Server {server_id} is already running on an agent"
            )));
        }

        let params = service_start_params(server_id, config)?;

        let agent_manager = self
            .app_handle
            .try_state::<Arc<dyn AgentRpcClient>>()
            .ok_or_else(|| {
                TerminalError::EmbeddedServerError("Agent manager is not available".to_string())
            })?;

        match agent_manager.send_request(agent_id, "service.start", params) {
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
                self.ensure_agent_status_poller();
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
        let handle = {
            let mut agent_servers = match self.agent_servers.lock() {
                Ok(a) => a,
                Err(_) => return false,
            };
            agent_servers.remove(server_id)
        };
        let Some(handle) = handle else {
            return false;
        };
        if let Some(agent_manager) = self.app_handle.try_state::<Arc<dyn AgentRpcClient>>() {
            let params = json!({ "instanceId": server_id });
            if let Err(e) = agent_manager.send_request(&handle.agent_id, "service.stop", params) {
                tracing::warn!(
                    "Failed to stop agent-hosted embedded server {} on agent {}: {}",
                    server_id,
                    handle.agent_id,
                    e
                );
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
        let agent_ids: Vec<String> = self
            .agent_servers
            .lock()
            .map(|map| map.keys().cloned().collect())
            .unwrap_or_default();
        for id in agent_ids {
            self.stop_agent_service(&id);
        }
        self.stop_agent_status_poller();
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

    /// Ensure the single periodic agent `service.status` poller task is running
    /// (#2214).
    ///
    /// Idempotent, mirroring `tunnel_manager::ensure_agent_stats_poller` (#2199):
    /// every [`STATUS_POLL_INTERVAL`] it snapshots the live agent-server set,
    /// polls each one's `service.status` over the agent RPC (the blocking batch on
    /// a `spawn_blocking` thread), writes the fresh state back into the handle,
    /// and re-emits [`SERVER_STATUS_EVENT`] on a status/error transition so the
    /// frontend sees a crash-to-Error just like a desktop server. The task
    /// self-reaps (clearing this slot) once no agent server remains.
    fn ensure_agent_status_poller(&self) {
        let mut slot = match self.agent_status_poller.lock() {
            Ok(slot) => slot,
            Err(_) => return,
        };
        // Already running (and not yet finished) — nothing to do.
        if slot.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return;
        }

        let agent_servers = Arc::clone(&self.agent_servers);
        let app_handle = self.app_handle.clone();
        let poller_slot = Arc::clone(&self.agent_status_poller);

        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(STATUS_POLL_INTERVAL).await;

                // Snapshot the (server id, agent id) targets under the lock, then
                // release it before any RPC so a slow agent never blocks a
                // start/stop that also touches this map.
                let targets: Vec<(String, String)> = match agent_servers.lock() {
                    Ok(map) => map
                        .iter()
                        .map(|(id, handle)| (id.clone(), handle.agent_id.clone()))
                        .collect(),
                    Err(_) => break,
                };

                // No agent-hosted server left: stop polling and clear the slot so
                // a later start re-spawns the task.
                if targets.is_empty() {
                    break;
                }

                // Resolve the agent RPC client fresh each tick (an agent may
                // connect after the poller started). Absent → skip this tick.
                let Some(client) = app_handle
                    .try_state::<Arc<dyn AgentRpcClient>>()
                    .map(|state| (*state).clone())
                else {
                    continue;
                };

                // `service.status` is a blocking RPC; run the whole batch on a
                // blocking thread so no async worker is stalled.
                let samples =
                    tokio::task::spawn_blocking(move || poll_agent_server_states(client, &targets))
                        .await
                        .unwrap_or_default();

                // Write the fresh samples back into the live handles under the
                // lock, emitting only on a status/error transition (matching the
                // desktop service, which emits on transitions, not every tick).
                let mut transitions = Vec::new();
                if let Ok(mut map) = agent_servers.lock() {
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
                    let _ = app_handle.emit(SERVER_STATUS_EVENT, state);
                }
            }

            // Self-reap: drop our own handle so a later start re-spawns the task.
            if let Ok(mut slot) = poller_slot.lock() {
                *slot = None;
            }
        });

        *slot = Some(handle);
    }

    /// Abort the agent `service.status` poller task (if any) and clear its slot.
    fn stop_agent_status_poller(&self) {
        if let Ok(mut slot) = self.agent_status_poller.lock() {
            if let Some(handle) = slot.take() {
                handle.abort();
            }
        }
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

/// Build the [`ServiceRegistry`] with the run-location-routable server types.
///
/// Delegates to [`termihub_core::embedded_servers::build_service_registry`] so
/// the desktop host and the agent register identical server-type factories from
/// one source of truth (#2192).
fn build_service_registry() -> ServiceRegistry {
    termihub_core::embedded_servers::build_service_registry()
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
    Ok(json!({
        "instanceId": server_id,
        "serviceId": service_id_for(&config.server_type),
        "config": config_value,
    }))
}

/// Parse an agent `service.start` reply into the desktop [`ServerState`] (#2214).
///
/// Prefers the streamed `state` payload (a full `ServerState` with live stats);
/// falls back to synthesizing one from the lifecycle `status` when no event has
/// been emitted yet. Pure, so it is unit-testable without an agent mock.
fn server_state_from_start_reply(server_id: &str, reply: &serde_json::Value) -> ServerState {
    server_state_from_value(server_id, &reply["state"])
        .unwrap_or_else(|| synth_state_from_status(server_id, &reply["status"]))
}

/// Parse an agent `service.status` reply into a [`ServerState`], or `None` when
/// the instance is not running on the agent (#2214). Pure, so the parse is
/// unit-testable without an agent mock.
fn server_state_from_status_reply(server_id: &str, reply: &serde_json::Value) -> Option<ServerState> {
    if reply["running"].as_bool() != Some(true) {
        return None;
    }
    Some(
        server_state_from_value(server_id, &reply["state"])
            .unwrap_or_else(|| synth_state_from_status(server_id, &reply["status"])),
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

/// Synthesize a [`ServerState`] from the core `ServiceStatus` wire shape
/// (`{ "state": "running" | "failed", "detail": … }`) when no full state payload
/// is available.
fn synth_state_from_status(server_id: &str, status: &serde_json::Value) -> ServerState {
    let (server_status, error) = match status.get("state").and_then(|s| s.as_str()) {
        Some("running") => (ServerStatus::Running, None),
        Some("starting") => (ServerStatus::Starting, None),
        Some("stopping") => (ServerStatus::Stopping, None),
        Some("failed") => (
            ServerStatus::Error,
            status
                .get("detail")
                .and_then(|d| d.as_str())
                .map(str::to_string),
        ),
        _ => (ServerStatus::Stopped, None),
    };
    ServerState {
        server_id: server_id.to_string(),
        status: server_status,
        error,
        stats: ServerStats::default(),
        started_at: None,
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
        let params = json!({ "instanceId": server_id });
        match client.send_request(agent_id, "service.status", params) {
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
fn spawn_event_bridge(app: AppHandle, mut events: termihub_core::service::ServiceEventReceiver) {
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) if event.kind == STATUS_EVENT_KIND => {
                    let _ = app.emit(SERVER_STATUS_EVENT, event.payload);
                }
                Ok(_) => {}
                // Advisory events: a lagging bridge drops the oldest and keeps going.
                Err(RecvError::Lagged(_)) => continue,
                // All senders dropped (service removed) — nothing more to forward.
                Err(RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedded_servers::config::ServerType;

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
        }
    }

    /// The desktop manager sources its server-type registry from the shared core
    /// factory (#2192). The factory's contents are tested in
    /// `termihub_core::embedded_servers`; here we only confirm the desktop wires
    /// through to it and exposes the three run-location-routable types.
    #[test]
    fn build_service_registry_delegates_to_core_and_lists_the_three_types() {
        let ids: Vec<String> = build_service_registry()
            .available_services()
            .into_iter()
            .map(|s| s.service_id)
            .collect();
        assert!(ids.contains(&"http_server".to_string()));
        assert!(ids.contains(&"ftp_server".to_string()));
        assert!(ids.contains(&"tftp_server".to_string()));
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
        let status = json!({ "state": "failed", "detail": "port in use" });
        let state = synth_state_from_status("srv-3", &status);
        assert_eq!(state.status, ServerStatus::Error);
        assert_eq!(state.error.as_deref(), Some("port in use"));
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
}
