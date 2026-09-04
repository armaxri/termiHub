//! Desktop-side network diagnostics manager.
//!
//! Wraps the `termihub-core` network tools and exposes them via Tauri commands.
//! Manages running task lifetimes (port scans, ping sessions, traceroutes) and
//! the persistent HTTP monitors.

pub mod agent_tools;
pub mod http_monitor;
pub mod http_monitor_storage;
pub mod wol_storage;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error};
use uuid::Uuid;

use http_monitor::{
    register_http_monitor, HttpCheckResult, HttpMonitorConfig, HttpMonitorService, HttpMonitorState,
};
use termihub_core::network::WolDevice;
use termihub_core::service::{Service, ServiceInfo, ServiceRegistry};

use crate::run_location::{Locality, ResolvedLocation, RunLocation, RunLocationResolver};
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

/// How often the agent `service.status` poller samples each agent-hosted HTTP
/// monitor (#2592). Matches the embedded-server poller cadence (#2214).
const AGENT_STATUS_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Tauri event forwarded to the frontend for each HTTP monitor check.
///
/// The [`HttpMonitorService`] itself emits on the core
/// [`EventChannel`](termihub_core::service::EventChannel); the desktop host
/// bridges that channel to this Tauri event so the frontend contract is
/// unchanged (see [`NetworkManager::spawn_http_monitor`]).
const HTTP_MONITOR_CHECK_EVENT: &str = "network-http-monitor-check";

/// An HTTP monitor hosted on a remote agent (#2592).
///
/// The poll loop and the outbound HTTP checks all run on the agent; the desktop
/// holds only *control* — which agent runs it, the config, and the latest check
/// the `service.status` poller sampled — so [`NetworkManager::list_http_monitors`]
/// can project an agent-hosted monitor exactly like a desktop-hosted one, and the
/// frontend cannot tell where it runs.
struct AgentMonitorHandle {
    /// The agent hosting this monitor.
    agent_id: String,
    /// The monitor's config (its `id` is the agent-side instance id).
    config: HttpMonitorConfig,
    /// The most recent check sampled from the agent, if any.
    last_result: Option<HttpCheckResult>,
    /// Whether the monitor's poll loop is currently hosted on the agent.
    running: bool,
    /// Whether the monitor is paused (torn down on the agent, kept listed).
    paused: bool,
}

impl AgentMonitorHandle {
    /// Project this handle as an [`HttpMonitorState`] for listing.
    fn state(&self) -> HttpMonitorState {
        HttpMonitorState {
            config: self.config.clone(),
            running: self.running,
            paused: self.running && self.paused,
            last_result: self.last_result.clone(),
        }
    }
}

/// Central manager for all active network diagnostic tasks.
///
/// Registered as Tauri managed state alongside ConnectionManager, etc.
pub struct NetworkManager {
    /// Active scan / ping / traceroute tasks, keyed by task ID.
    active_tasks: Mutex<HashMap<String, CancellationToken>>,
    /// Running HTTP monitors, each an [`HttpMonitorService`] behind the core
    /// [`Service`](termihub_core::service::Service) trait (#2157).
    http_monitors: Mutex<HashMap<String, HttpMonitorService>>,
    /// HTTP monitors hosted on a remote agent, keyed by monitor id (#2592).
    /// Disjoint from `http_monitors` (desktop-hosted): an agent-hosted monitor's
    /// poll loop runs on the agent, so the desktop tracks only the control handle
    /// here. `Arc`-shared so the periodic `service.status` poller task can refresh
    /// each handle without a `&self` reference.
    agent_monitors: Arc<Mutex<HashMap<String, AgentMonitorHandle>>>,
    /// Per-monitor run-location preference — which machine hosts each monitor
    /// (#2592). Keyed by monitor id. In-memory today (like the embedded-server
    /// preference, #2214); an absent entry means [`RunLocation::ThisComputer`],
    /// the desktop default and today's behaviour. Persisted configs auto-start
    /// on this computer after a relaunch, exactly as before.
    monitor_run_locations: Mutex<HashMap<String, RunLocation>>,
    /// Handle to the single periodic agent `service.status` poller task (#2592).
    /// `Some` while at least one agent-hosted monitor exists; the task self-reaps
    /// once none remain, and shutdown aborts it.
    agent_status_poller: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Desktop-side registry of run-location-routable services. The HTTP monitor
    /// is registered here (discovery, schema, capabilities) as the S2 pilot.
    service_registry: ServiceRegistry,
    /// Resolver deciding where a tool/service runs (local vs agent). Honours the
    /// per-tool preference in `run_locations`; a tool with no recorded preference
    /// resolves local, so users see no behaviour change (#2190).
    run_location: RunLocationResolver,
    /// Per-tool run-location preference — which machine each network tool runs on
    /// (#2190). Keyed by the tool-type keys in [`agent_tools::tool`]. In-memory
    /// today; the selector UI that records a non-default choice is a later
    /// S-phase (#2191). An absent entry means [`RunLocation::ThisComputer`], the
    /// desktop default and today's behaviour.
    run_locations: Mutex<HashMap<String, RunLocation>>,
    /// Saved Wake-on-LAN devices (persisted to disk).
    wol_devices: Mutex<Vec<WolDevice>>,
    /// App config directory for persistence.
    config_dir: PathBuf,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl NetworkManager {
    /// Create a new manager. Call [`NetworkManager::init`] after the Tauri
    /// app is set up to provide the config directory.
    pub fn new() -> Self {
        Self {
            active_tasks: Mutex::new(HashMap::new()),
            http_monitors: Mutex::new(HashMap::new()),
            agent_monitors: Arc::new(Mutex::new(HashMap::new())),
            monitor_run_locations: Mutex::new(HashMap::new()),
            agent_status_poller: Arc::new(Mutex::new(None)),
            service_registry: build_service_registry(),
            run_location: RunLocationResolver::new(),
            run_locations: Mutex::new(HashMap::new()),
            wol_devices: Mutex::new(Vec::new()),
            config_dir: PathBuf::new(),
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    /// The services registered for run-location routing (currently just the
    /// HTTP monitor). Backs future discovery / the run-location selector UI.
    pub fn available_services(&self) -> Vec<ServiceInfo> {
        self.service_registry.available_services()
    }

    // ── Run-location routing (#2190) ─────────────────────────────────────────

    /// Set (or clear) the run-location preference for a network tool (#2190).
    ///
    /// [`RunLocation::ThisComputer`] clears the entry (back to the desktop
    /// default); a [`RunLocation::Agent`] records which agent should run the tool
    /// on its next invocation. This is the desktop-side preference the S1
    /// resolver was designed around; the selector UI that calls it lands in a
    /// later S-phase (#2191), and it is the test hook for the agent-routed path
    /// meanwhile.
    ///
    /// A [`Locality::DesktopOnly`] tool (the HTTP monitor) refuses an agent
    /// location up front, so a forbidden choice never reaches the resolver.
    pub fn set_run_location(&self, tool: &str, location: RunLocation) -> Result<(), TerminalError> {
        // Validate desktop-only tools reject an agent request immediately.
        self.run_location
            .resolve(tool, agent_tools::locality_for(tool), &location)
            .map_err(|e| TerminalError::NetworkError(e.to_string()))?;

        let mut map = self
            .run_locations
            .lock()
            .map_err(|_| TerminalError::InternalError("run-location lock poisoned".into()))?;
        match location {
            RunLocation::ThisComputer => {
                map.remove(tool);
            }
            agent @ RunLocation::Agent(_) => {
                map.insert(tool.to_string(), agent);
            }
        }
        Ok(())
    }

    /// Read a tool's recorded run-location preference, defaulting to
    /// [`RunLocation::ThisComputer`] when none is set (#2190).
    fn requested_run_location(&self, tool: &str) -> RunLocation {
        self.run_locations
            .lock()
            .ok()
            .and_then(|map| map.get(tool).cloned())
            .unwrap_or_default()
    }

    /// Resolve where a network tool should run from its recorded preference
    /// (#2190). Defaults to [`ResolvedLocation::Local`] (no preference), and
    /// refuses an agent for a [`Locality::DesktopOnly`] tool.
    pub fn resolve_tool_location(&self, tool: &str) -> Result<ResolvedLocation, TerminalError> {
        self.run_location
            .resolve(
                tool,
                agent_tools::locality_for(tool),
                &self.requested_run_location(tool),
            )
            .map_err(|e| TerminalError::NetworkError(e.to_string()))
    }

    /// The agent RPC client from Tauri managed state, if available (#2190).
    ///
    /// `None` before the app is fully set up (e.g. in unit tests without a live
    /// Tauri app); the agent-routed path treats that as "agent unavailable".
    pub fn agent_rpc_client(&self) -> Option<Arc<dyn AgentRpcClient>> {
        use tauri::Manager;
        let app = self.app_handle()?;
        app.try_state::<Arc<dyn AgentRpcClient>>()
            .map(|state| (*state).clone())
    }

    /// Initialise the manager with the app config directory and app handle.
    /// Loads persisted WoL devices from disk.
    pub fn init(&mut self, config_dir: PathBuf, app_handle: AppHandle) {
        self.config_dir = config_dir.clone();
        if let Ok(mut handle) = self.app_handle.lock() {
            *handle = Some(app_handle);
        }
        match wol_storage::load_wol_devices(&config_dir) {
            Ok(devices) => {
                if let Ok(mut guard) = self.wol_devices.lock() {
                    *guard = devices;
                }
            }
            Err(e) => {
                error!("Failed to load WoL devices: {e}");
            }
        }
        // Reload persisted HTTP monitor configs and auto-start a poll loop for
        // each, so a monitor configured before the last shutdown resumes on
        // launch instead of silently vanishing.
        for config in self.load_persisted_monitor_configs() {
            let id = config.id.clone();
            if let Err(e) = self.spawn_http_monitor(config) {
                error!(monitor_id = %id, "Failed to auto-start persisted HTTP monitor: {e}");
            }
        }
    }

    // ── Task lifecycle ──────────────────────────────────────────────────────

    /// Register a new cancellable task. Returns the task ID.
    pub fn register_task(&self) -> (String, CancellationToken) {
        let task_id = Uuid::new_v4().to_string();
        let token = CancellationToken::new();
        if let Ok(mut tasks) = self.active_tasks.lock() {
            tasks.insert(task_id.clone(), token.clone());
        }
        debug!(%task_id, "Registered network task");
        (task_id, token)
    }

    /// Cancel and remove a task.
    pub fn cancel_task(&self, task_id: &str) -> Result<(), TerminalError> {
        let mut tasks = self
            .active_tasks
            .lock()
            .map_err(|_| TerminalError::InternalError("network task lock poisoned".into()))?;
        match tasks.remove(task_id) {
            Some(token) => {
                token.cancel();
                debug!(%task_id, "Cancelled network task");
                Ok(())
            }
            None => Err(TerminalError::NotFound(format!("network task '{task_id}'"))),
        }
    }

    /// Mark a task as complete (remove without cancelling).
    pub fn complete_task(&self, task_id: &str) {
        if let Ok(mut tasks) = self.active_tasks.lock() {
            tasks.remove(task_id);
        }
    }

    pub fn app_handle(&self) -> Option<AppHandle> {
        self.app_handle.lock().ok()?.clone()
    }

    // ── HTTP Monitors ───────────────────────────────────────────────────────

    // ── Per-monitor run-location (#2592) ─────────────────────────────────────

    /// Set (or clear) a monitor's run-location preference (#2592).
    ///
    /// [`RunLocation::ThisComputer`] clears the entry (back to the desktop
    /// default); a [`RunLocation::Agent`] records which agent should host the
    /// monitor on its next start. Mirrors the embedded-server preference (#2214).
    /// The HTTP monitor is [`Locality::LocalOrAgent`] (a network probe from a
    /// remote vantage), so an agent choice is accepted.
    pub fn set_http_monitor_run_location(
        &self,
        monitor_id: &str,
        location: RunLocation,
    ) -> Result<(), TerminalError> {
        // A network probe may run on an agent — validate through the resolver so
        // the boundary is enforced in one place.
        self.run_location
            .resolve(monitor_id, Locality::LocalOrAgent, &location)
            .map_err(|e| TerminalError::NetworkError(e.to_string()))?;

        let mut map = self.monitor_run_locations.lock().map_err(|_| {
            TerminalError::InternalError("monitor run-location lock poisoned".into())
        })?;
        match location {
            RunLocation::ThisComputer => {
                map.remove(monitor_id);
            }
            agent @ RunLocation::Agent(_) => {
                map.insert(monitor_id.to_string(), agent);
            }
        }
        Ok(())
    }

    /// Read a monitor's recorded run-location, defaulting to
    /// [`RunLocation::ThisComputer`] when none is set (#2592).
    fn requested_monitor_location(&self, monitor_id: &str) -> RunLocation {
        self.monitor_run_locations
            .lock()
            .ok()
            .and_then(|map| map.get(monitor_id).cloned())
            .unwrap_or_default()
    }

    /// Start a new HTTP monitor and persist its config. Returns its ID.
    ///
    /// `run_location` records where the monitor should run (default:
    /// [`RunLocation::ThisComputer`]); an agent choice hosts the monitor on that
    /// agent (#2592). The config is written to disk (see [`http_monitor_storage`])
    /// so the monitor is auto-restarted on the next launch. Runtime state (last
    /// result, running flag) and the run-location choice are never persisted.
    pub fn start_http_monitor(
        &self,
        config: HttpMonitorConfig,
        run_location: RunLocation,
    ) -> Result<String, TerminalError> {
        // Record the run-location before spawning so the resolver routes it.
        self.set_http_monitor_run_location(&config.id, run_location)?;
        // Persist first so a monitor the user just created survives a restart
        // even if it is stopped before the next save.
        self.persist_monitor_config(config.clone())?;
        self.spawn_http_monitor(config)
    }

    /// Spawn the poll loop for a config and track its service, **without**
    /// touching disk. Used both by [`start_http_monitor`](Self::start_http_monitor)
    /// (after persisting) and by [`init`](Self::init) when auto-starting the
    /// persisted monitors on launch.
    ///
    /// The monitor's run-location is resolved through the [`RunLocationResolver`]
    /// from its recorded preference (default: local). A monitor resolving to an
    /// agent is hosted on that agent over the agent RPC (#2592); the desktop path
    /// below is unchanged. The desktop service emits check results on its core
    /// [`EventChannel`](termihub_core::service::EventChannel); a bridge task
    /// forwards them to the [`HTTP_MONITOR_CHECK_EVENT`] Tauri event so the
    /// frontend contract is unchanged.
    fn spawn_http_monitor(&self, config: HttpMonitorConfig) -> Result<String, TerminalError> {
        // Route by run-location (#2592). No preference → local (unchanged); an
        // agent preference hosts the monitor on that agent over the agent RPC.
        match self
            .run_location
            .resolve(
                &config.id,
                Locality::LocalOrAgent,
                &self.requested_monitor_location(&config.id),
            )
            .map_err(|e| TerminalError::NetworkError(e.to_string()))?
        {
            ResolvedLocation::Local => {}
            ResolvedLocation::Agent(agent_id) => {
                return self.start_agent_monitor(config, &agent_id);
            }
        }

        let app = self
            .app_handle()
            .ok_or_else(|| TerminalError::InternalError("app handle not available".into()))?;
        let id = config.id.clone();

        let mut service = HttpMonitorService::new();
        // Subscribe before starting so the bridge cannot miss the first check.
        let events = service.subscribe_events();
        service.start_with(config);
        spawn_event_bridge(app, events);

        if let Ok(mut monitors) = self.http_monitors.lock() {
            monitors.insert(id.clone(), service);
        }
        Ok(id)
    }

    // ── Agent-hosted monitors (#2592) ────────────────────────────────────────

    /// Host a monitor on a remote agent over the agent RPC (#2592).
    ///
    /// Sends `service.start` with the monitor id as the instance id, the
    /// `http_monitor` service id, and the full [`HttpMonitorConfig`] — mirroring
    /// [`EmbeddedServerManager::start_agent_service`](crate::embedded_servers::EmbeddedServerManager).
    /// On success the control handle is tracked and the `service.status` poller is
    /// (re)started so streamed checks reach the frontend.
    fn start_agent_monitor(
        &self,
        config: HttpMonitorConfig,
        agent_id: &str,
    ) -> Result<String, TerminalError> {
        let id = config.id.clone();
        if self.lock_agent_monitors()?.contains_key(&id) {
            return Err(TerminalError::NetworkError(format!(
                "Monitor {id} is already running on an agent"
            )));
        }

        let client = self.agent_rpc_client().ok_or_else(|| {
            TerminalError::NetworkError("Agent manager is not available".to_string())
        })?;
        let params = json!({
            "instanceId": id,
            "serviceId": http_monitor::SERVICE_ID,
            "config": serde_json::to_value(&config)
                .map_err(|e| TerminalError::NetworkError(format!("serialize monitor config: {e}")))?,
        });

        client
            .send_request(agent_id, "service.start", params)
            .map_err(|e| {
                TerminalError::NetworkError(format!("agent-hosted HTTP monitor start failed: {e}"))
            })?;

        self.lock_agent_monitors()?.insert(
            id.clone(),
            AgentMonitorHandle {
                agent_id: agent_id.to_string(),
                config,
                last_result: None,
                running: true,
                paused: false,
            },
        );
        self.ensure_agent_status_poller();
        tracing::info!("HTTP monitor {id} started on agent {agent_id}");
        Ok(id)
    }

    /// Ensure the single periodic agent `service.status` poller task is running
    /// (#2592).
    ///
    /// Idempotent, mirroring the embedded-server poller (#2214): every
    /// [`AGENT_STATUS_POLL_INTERVAL`] it snapshots the live agent-monitor set,
    /// polls each running one's `service.status` over the agent RPC (blocking, on
    /// a `spawn_blocking` thread), and re-emits [`HTTP_MONITOR_CHECK_EVENT`] with
    /// the streamed [`HttpCheckResult`] when a fresh check arrives — so a
    /// monitor's checks reach the frontend from the agent's vantage exactly as a
    /// desktop-hosted monitor's do. The task self-reaps once no agent monitor
    /// remains.
    fn ensure_agent_status_poller(&self) {
        let mut slot = match self.agent_status_poller.lock() {
            Ok(slot) => slot,
            Err(_) => return,
        };
        if slot.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return;
        }

        let agent_monitors = Arc::clone(&self.agent_monitors);
        let poller_slot = Arc::clone(&self.agent_status_poller);
        let app = self.app_handle();

        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(AGENT_STATUS_POLL_INTERVAL).await;

                // Snapshot the running (monitor id, agent id) targets under the
                // lock, then release it before any RPC so a slow agent never
                // blocks a start/stop that also touches this map.
                let targets: Vec<(String, String)> = match agent_monitors.lock() {
                    Ok(map) => map
                        .iter()
                        .filter(|(_, h)| h.running && !h.paused)
                        .map(|(id, h)| (id.clone(), h.agent_id.clone()))
                        .collect(),
                    Err(_) => break,
                };
                // No agent monitor left at all: stop polling and clear the slot.
                let any_left = agent_monitors
                    .lock()
                    .map(|m| !m.is_empty())
                    .unwrap_or(false);
                if !any_left {
                    break;
                }
                if targets.is_empty() {
                    continue;
                }

                let (Some(app), Some(client)) = (app.clone(), resolve_agent_client(app.as_ref()))
                else {
                    continue;
                };

                let samples = tokio::task::spawn_blocking(move || {
                    poll_agent_monitor_checks(client, &targets)
                })
                .await
                .unwrap_or_default();

                // Write fresh checks back into the handles and emit each new one.
                let mut fresh = Vec::new();
                if let Ok(mut map) = agent_monitors.lock() {
                    for (id, result) in samples {
                        if let Some(handle) = map.get_mut(&id) {
                            let is_new = handle
                                .last_result
                                .as_ref()
                                .map(|prev| prev.timestamp_ms != result.timestamp_ms)
                                .unwrap_or(true);
                            handle.last_result = Some(result.clone());
                            if is_new {
                                fresh.push(result);
                            }
                        }
                    }
                }
                for result in fresh {
                    let _ = app.emit(HTTP_MONITOR_CHECK_EVENT, result);
                }
            }
            if let Ok(mut slot) = poller_slot.lock() {
                *slot = None;
            }
        });
        *slot = Some(handle);
    }

    /// The agent hosting `monitor_id`, if it is an agent-hosted monitor (#2607).
    /// A cheap map read used to branch agent-vs-desktop hosting before an RPC.
    fn agent_monitor_agent_id(&self, monitor_id: &str) -> Option<String> {
        self.agent_monitors
            .lock()
            .ok()
            .and_then(|map| map.get(monitor_id).map(|h| h.agent_id.clone()))
    }

    /// Send `service.stop` for an agent-hosted monitor (best-effort). Returns the
    /// handle's agent id if the monitor was agent-hosted.
    fn stop_agent_monitor_rpc(&self, monitor_id: &str) -> Option<String> {
        let agent_id = self
            .agent_monitors
            .lock()
            .ok()
            .and_then(|map| map.get(monitor_id).map(|h| h.agent_id.clone()))?;
        if let Some(client) = self.agent_rpc_client() {
            let params = json!({ "instanceId": monitor_id });
            if let Err(e) = client.send_request(&agent_id, "service.stop", params) {
                tracing::warn!("Failed to stop agent-hosted HTTP monitor {monitor_id}: {e}");
            }
        }
        Some(agent_id)
    }

    fn lock_agent_monitors(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, AgentMonitorHandle>>, TerminalError> {
        self.agent_monitors
            .lock()
            .map_err(|_| TerminalError::InternalError("agent monitor lock poisoned".into()))
    }

    /// Stop a running HTTP monitor, keeping it **listed** (as `running: false`).
    ///
    /// Audit Gap #6: Stop must suspend polling without destroying the monitor —
    /// its handle stays in the map (with a cancelled token, so it lists as not
    /// running) and its persisted config is kept, so [`resume_http_monitor`]
    /// (or the next launch) can bring it back. Use [`remove_http_monitor`] to
    /// truly delete it.
    pub fn stop_http_monitor(&self, monitor_id: &str) -> Result<(), TerminalError> {
        // Agent-hosted monitors live in their own track: tell the agent to tear
        // the poll loop down, but keep the control handle listed as `running:
        // false` so a later Resume can re-host it (#2592).
        if let Some(_agent_id) = self.stop_agent_monitor_rpc(monitor_id) {
            if let Ok(mut map) = self.agent_monitors.lock() {
                if let Some(handle) = map.get_mut(monitor_id) {
                    handle.running = false;
                    handle.paused = false;
                }
            }
            return Ok(());
        }
        let mut monitors = self
            .http_monitors
            .lock()
            .map_err(|_| TerminalError::InternalError("http monitor lock poisoned".into()))?;
        match monitors.get_mut(monitor_id) {
            Some(service) => {
                // Cancel the poll loop but leave the service in the map so the
                // monitor stays listed as `running: false`. Its event channel
                // stays open, so a later Resume keeps the same bridge task.
                service.shutdown();
                Ok(())
            }
            None => Err(TerminalError::NotFound(format!("monitor '{monitor_id}'"))),
        }
    }

    /// Remove an HTTP monitor entirely: cancel its poll loop, drop its handle
    /// from the map, and delete its persisted config.
    ///
    /// Audit Gap #6: this is the destructive counterpart to [`stop_http_monitor`].
    pub fn remove_http_monitor(&self, monitor_id: &str) -> Result<(), TerminalError> {
        // Agent-hosted monitor: `service.stop` on the agent, drop the control
        // handle and its run-location preference, and delete the persisted config
        // (#2592).
        if self.stop_agent_monitor_rpc(monitor_id).is_some() {
            self.lock_agent_monitors()?.remove(monitor_id);
            if let Ok(mut map) = self.monitor_run_locations.lock() {
                map.remove(monitor_id);
            }
            if let Err(e) = self.remove_persisted_monitor_config(monitor_id) {
                error!(monitor_id, "Failed to remove persisted HTTP monitor: {e}");
            }
            return Ok(());
        }
        let mut monitors = self
            .http_monitors
            .lock()
            .map_err(|_| TerminalError::InternalError("http monitor lock poisoned".into()))?;
        match monitors.remove(monitor_id) {
            Some(mut service) => {
                // Cancel the poll loop; dropping the service also drops its event
                // channel sender, so the bridge task exits cleanly.
                service.shutdown();
                drop(monitors);
                // Best-effort disk cleanup; a persistence error must not leave
                // the handle re-inserted.
                if let Err(e) = self.remove_persisted_monitor_config(monitor_id) {
                    error!(monitor_id, "Failed to remove persisted HTTP monitor: {e}");
                }
                Ok(())
            }
            None => Err(TerminalError::NotFound(format!("monitor '{monitor_id}'"))),
        }
    }

    /// Pause a running HTTP monitor: the poll loop stays alive but its poll body
    /// is suspended (audit Gap #5). Lists as `running: true, paused: true`.
    pub fn pause_http_monitor(&self, monitor_id: &str) -> Result<(), TerminalError> {
        // Agent-hosted monitor: pause it IN PLACE over `service.pause` (#2607).
        // The instance stays hosted on the agent with its poll body suspended —
        // no stop-and-relist — for the same user-visible effect as a desktop
        // pause (lists `running: true, paused: true`). Best-effort, mirroring the
        // desktop-hosted pause, which cannot fail.
        if let Some(agent_id) = self.agent_monitor_agent_id(monitor_id) {
            if let Some(client) = self.agent_rpc_client() {
                let params = json!({ "instanceId": monitor_id });
                if let Err(e) = client.send_request(&agent_id, "service.pause", params) {
                    tracing::warn!("Failed to pause agent-hosted HTTP monitor {monitor_id}: {e}");
                }
            }
            if let Ok(mut map) = self.agent_monitors.lock() {
                if let Some(handle) = map.get_mut(monitor_id) {
                    handle.paused = true;
                }
            }
            debug!(monitor_id, "Paused agent-hosted HTTP monitor in place");
            return Ok(());
        }
        let monitors = self
            .http_monitors
            .lock()
            .map_err(|_| TerminalError::InternalError("http monitor lock poisoned".into()))?;
        match monitors.get(monitor_id) {
            Some(service) => {
                service.pause();
                debug!(monitor_id, "Paused HTTP monitor");
                Ok(())
            }
            None => Err(TerminalError::NotFound(format!("monitor '{monitor_id}'"))),
        }
    }

    /// Resume a paused or stopped HTTP monitor with the same config.
    ///
    /// - A **paused** monitor (loop still alive) simply clears its `paused` flag.
    /// - A **stopped** monitor (loop cancelled, but still listed) is re-spawned
    ///   with a fresh cancellation token, reusing the same config/id.
    pub fn resume_http_monitor(&self, monitor_id: &str) -> Result<(), TerminalError> {
        // Agent-hosted monitor. Two cases, mirroring the desktop-hosted service
        // (#2607):
        // - A **paused** monitor (`running: true`) is still hosted on the agent,
        //   so resume it IN PLACE over `service.resume` — just clears the pause
        //   flag, no re-hosting.
        // - A **stopped** monitor (`running: false`) was torn down on the agent
        //   (`service.stop` removed the instance), so re-host it with a fresh
        //   `service.start` carrying the same config/id, exactly as before.
        let agent_target = self.agent_monitors.lock().ok().and_then(|map| {
            map.get(monitor_id)
                .map(|h| (h.agent_id.clone(), h.config.clone(), h.running))
        });
        if let Some((agent_id, config, running)) = agent_target {
            let client = self.agent_rpc_client().ok_or_else(|| {
                TerminalError::NetworkError("Agent manager is not available".to_string())
            })?;
            if running {
                let params = json!({ "instanceId": monitor_id });
                client
                    .send_request(&agent_id, "service.resume", params)
                    .map_err(|e| {
                        TerminalError::NetworkError(format!(
                            "agent-hosted HTTP monitor resume failed: {e}"
                        ))
                    })?;
            } else {
                let params = json!({
                    "instanceId": monitor_id,
                    "serviceId": http_monitor::SERVICE_ID,
                    "config": serde_json::to_value(&config).map_err(|e| {
                        TerminalError::NetworkError(format!("serialize monitor config: {e}"))
                    })?,
                });
                client
                    .send_request(&agent_id, "service.start", params)
                    .map_err(|e| {
                        TerminalError::NetworkError(format!(
                            "agent-hosted HTTP monitor resume failed: {e}"
                        ))
                    })?;
            }
            if let Ok(mut map) = self.agent_monitors.lock() {
                if let Some(handle) = map.get_mut(monitor_id) {
                    handle.running = true;
                    handle.paused = false;
                }
            }
            self.ensure_agent_status_poller();
            debug!(monitor_id, "Resumed agent-hosted HTTP monitor");
            return Ok(());
        }
        let mut monitors = self
            .http_monitors
            .lock()
            .map_err(|_| TerminalError::InternalError("http monitor lock poisoned".into()))?;
        match monitors.get_mut(monitor_id) {
            Some(service) => {
                // The service resumes in place: a paused loop clears its flag; a
                // stopped loop is re-spawned on the same event channel, so the
                // existing bridge task keeps forwarding without re-subscribing.
                service.resume();
                debug!(monitor_id, "Resumed HTTP monitor");
                Ok(())
            }
            None => Err(TerminalError::NotFound(format!("monitor '{monitor_id}'"))),
        }
    }

    // ── HTTP Monitor persistence ────────────────────────────────────────────

    /// Load the persisted HTTP monitor configs from disk (empty on any error).
    fn load_persisted_monitor_configs(&self) -> Vec<HttpMonitorConfig> {
        match http_monitor_storage::load_http_monitors(&self.config_dir) {
            Ok(configs) => configs,
            Err(e) => {
                error!("Failed to load persisted HTTP monitors: {e}");
                Vec::new()
            }
        }
    }

    /// Persist a single monitor config, replacing any existing entry with the
    /// same ID.
    fn persist_monitor_config(&self, config: HttpMonitorConfig) -> Result<(), TerminalError> {
        let mut configs = self.load_persisted_monitor_configs();
        if let Some(existing) = configs.iter_mut().find(|c| c.id == config.id) {
            *existing = config;
        } else {
            configs.push(config);
        }
        http_monitor_storage::save_http_monitors(&self.config_dir, &configs)
            .map_err(|e| TerminalError::InternalError(e.to_string()))
    }

    /// Remove the persisted config for a monitor. No-op if the file has no such
    /// entry (the map removal already happened).
    fn remove_persisted_monitor_config(&self, monitor_id: &str) -> Result<(), TerminalError> {
        let mut configs = self.load_persisted_monitor_configs();
        let before = configs.len();
        configs.retain(|c| c.id != monitor_id);
        if configs.len() == before {
            return Ok(());
        }
        http_monitor_storage::save_http_monitors(&self.config_dir, &configs)
            .map_err(|e| TerminalError::InternalError(e.to_string()))
    }

    /// Stop and remove **all** running HTTP monitors.
    ///
    /// Used during app shutdown (mirrors [`TunnelManager::stop_all`] /
    /// [`EmbeddedServerManager::stop_all`]): cancels every monitor's
    /// [`CancellationToken`] so its poll loop breaks and any in-flight `reqwest`
    /// request is aborted, then clears the map so nothing lingers. Without this,
    /// the poll tasks would only die when the process exits, abandoning
    /// in-flight requests — inconsistent with every sibling subsystem's clean
    /// teardown.
    pub fn stop_all_http_monitors(&self) {
        if let Ok(mut monitors) = self.http_monitors.lock() {
            for (id, mut service) in monitors.drain() {
                service.shutdown();
                debug!(monitor_id = %id, "Stopped HTTP monitor during teardown");
            }
        } else {
            error!("http monitor lock poisoned during stop_all");
        }

        // Tear down agent-hosted monitors too (#2592): `service.stop` each and
        // drop its handle, then abort the poller.
        let ids: Vec<String> = self
            .agent_monitors
            .lock()
            .map(|map| map.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            self.stop_agent_monitor_rpc(&id);
        }
        if let Ok(mut map) = self.agent_monitors.lock() {
            map.clear();
        }
        if let Ok(mut slot) = self.agent_status_poller.lock() {
            if let Some(handle) = slot.take() {
                handle.abort();
            }
        }
    }

    /// List all HTTP monitors (running and stopped), desktop- and agent-hosted.
    pub fn list_http_monitors(&self) -> Vec<HttpMonitorState> {
        let mut states: Vec<HttpMonitorState> = self
            .http_monitors
            .lock()
            .map(|monitors| monitors.values().filter_map(|s| s.state()).collect())
            .unwrap_or_default();
        // An agent-hosted monitor (#2592) projects from its control handle, just
        // like a desktop-hosted one, so the frontend cannot tell where it runs.
        if let Ok(agent) = self.agent_monitors.lock() {
            states.extend(agent.values().map(|h| h.state()));
        }
        states
    }

    // ── WoL Devices ─────────────────────────────────────────────────────────

    pub fn list_wol_devices(&self) -> Vec<WolDevice> {
        self.wol_devices
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    pub fn save_wol_device(&self, device: WolDevice) -> Result<(), TerminalError> {
        let mut guard = self
            .wol_devices
            .lock()
            .map_err(|_| TerminalError::InternalError("wol devices lock poisoned".into()))?;
        // Replace existing device with same ID, or append.
        if let Some(existing) = guard.iter_mut().find(|d| d.id == device.id) {
            *existing = device;
        } else {
            guard.push(device);
        }
        wol_storage::save_wol_devices(&self.config_dir, &guard)
            .map_err(|e| TerminalError::InternalError(e.to_string()))
    }

    pub fn delete_wol_device(&self, device_id: &str) -> Result<(), TerminalError> {
        let mut guard = self
            .wol_devices
            .lock()
            .map_err(|_| TerminalError::InternalError("wol devices lock poisoned".into()))?;
        let before = guard.len();
        guard.retain(|d| d.id != device_id);
        if guard.len() == before {
            return Err(TerminalError::NotFound(format!("WoL device '{device_id}'")));
        }
        wol_storage::save_wol_devices(&self.config_dir, &guard)
            .map_err(|e| TerminalError::InternalError(e.to_string()))
    }
}

impl Default for NetworkManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Build the desktop [`ServiceRegistry`] with the run-location-routable services.
///
/// Delegates to the shared [`register_http_monitor`] so the desktop host and the
/// agent register an identical HTTP-monitor factory from one source of truth
/// (#2592) — the same pattern the embedded servers use.
fn build_service_registry() -> ServiceRegistry {
    let mut registry = ServiceRegistry::new();
    register_http_monitor(&mut registry);
    registry
}

/// Bridge a monitor's core [`EventChannel`](termihub_core::service::EventChannel)
/// to the desktop's Tauri emitter.
///
/// Forwards each `check` [`ServiceEvent`](termihub_core::service::ServiceEvent)
/// as a [`HTTP_MONITOR_CHECK_EVENT`] Tauri event so the frontend receives the
/// same `HttpCheckResult` payload as before the lift. The task ends when the
/// service is dropped (channel closed).
fn spawn_event_bridge(app: AppHandle, mut events: termihub_core::service::ServiceEventReceiver) {
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) if event.kind == http_monitor::CHECK_EVENT_KIND => {
                    let _ = app.emit(HTTP_MONITOR_CHECK_EVENT, event.payload);
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

/// Resolve the agent RPC client from Tauri managed state (#2592).
///
/// A free function (no `&self`) so the periodic poller task can resolve the
/// client fresh each tick without holding a [`NetworkManager`] reference — an
/// agent may connect after the poller started.
fn resolve_agent_client(app: Option<&AppHandle>) -> Option<Arc<dyn AgentRpcClient>> {
    app?.try_state::<Arc<dyn AgentRpcClient>>()
        .map(|state| (*state).clone())
}

/// Poll `service.status` for a batch of agent-hosted monitors and collect the
/// latest streamed [`HttpCheckResult`] for each (#2592).
///
/// `AgentRpcClient::send_request` is blocking, so this runs on a blocking thread.
/// A monitor with no streamed check yet, or one no longer running on the agent,
/// simply contributes nothing this tick.
fn poll_agent_monitor_checks(
    client: Arc<dyn AgentRpcClient>,
    targets: &[(String, String)],
) -> Vec<(String, HttpCheckResult)> {
    let mut out = Vec::new();
    for (monitor_id, agent_id) in targets {
        let params = json!({ "instanceId": monitor_id });
        match client.send_request(agent_id, "service.status", params) {
            Ok(reply) => {
                if let Some(result) = parse_agent_check(monitor_id, &reply) {
                    out.push((monitor_id.clone(), result));
                }
            }
            Err(e) => {
                tracing::warn!(
                    "service.status poll for monitor {monitor_id} on agent {agent_id} failed: {e}"
                );
            }
        }
    }
    out
}

/// Parse an agent `service.status` reply into the latest [`HttpCheckResult`], or
/// `None` when the monitor is not running or has streamed no check yet (#2592).
///
/// Pure, so the parse is unit-testable without an agent mock.
fn parse_agent_check(monitor_id: &str, reply: &serde_json::Value) -> Option<HttpCheckResult> {
    if reply["running"].as_bool() != Some(true) {
        return None;
    }
    let mut result: HttpCheckResult = serde_json::from_value(reply["state"].clone()).ok()?;
    // Defend against a config-id/instance-id mismatch: the desktop keys checks by
    // the monitor id it started, so normalise to it.
    result.monitor_id = monitor_id.to_string();
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Insert a monitor service in the `Running` state (no real poll loop, so no
    /// Tauri app or network needed) so manager bookkeeping can be exercised.
    /// Returns the monitor id.
    fn insert_dummy_monitor(mgr: &NetworkManager) -> String {
        let config = HttpMonitorConfig::new(
            "https://example.com".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        insert_dummy_monitor_config(mgr, config)
    }

    /// Insert a running monitor service for a specific config (so persistence +
    /// map stay in sync in tests that also persist the config).
    fn insert_dummy_monitor_config(mgr: &NetworkManager, config: HttpMonitorConfig) -> String {
        let id = config.id.clone();
        mgr.http_monitors
            .lock()
            .expect("http monitor lock")
            .insert(id.clone(), HttpMonitorService::test_running(config));
        id
    }

    #[test]
    fn stop_all_http_monitors_cancels_and_clears() {
        let mgr = NetworkManager::new();
        let _id1 = insert_dummy_monitor(&mgr);
        let _id2 = insert_dummy_monitor(&mgr);

        let listed = mgr.list_http_monitors();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|m| m.running));

        mgr.stop_all_http_monitors();

        // Every monitor is stopped and drained so nothing lingers.
        assert!(mgr.list_http_monitors().is_empty());
    }

    #[test]
    fn http_monitor_registered_in_service_registry() {
        // The S2 pilot registers the HTTP monitor in the desktop ServiceRegistry
        // with the run-location-routable capabilities.
        let mgr = NetworkManager::new();
        let services = mgr.available_services();
        let monitor = services
            .iter()
            .find(|s| s.service_id == http_monitor::SERVICE_ID)
            .expect("http_monitor must be registered");
        assert_eq!(monitor.display_name, http_monitor::DISPLAY_NAME);
        assert!(monitor.capabilities.emits_events);
        // A network probe may run on an agent — not desktop-only.
        assert!(!monitor.capabilities.desktop_only);
    }

    // ── Per-monitor run-location + agent hosting (#2592) ─────────────────────

    #[test]
    fn monitors_default_to_this_computer() {
        let mgr = NetworkManager::new();
        assert_eq!(
            mgr.requested_monitor_location("mon-1"),
            RunLocation::ThisComputer
        );
    }

    #[test]
    fn set_http_monitor_run_location_accepts_an_agent_and_clears() {
        // Unlike a desktop-only capability, a monitor may be hosted on an agent
        // (a probe from a remote vantage), so recording an agent is accepted.
        let mgr = NetworkManager::new();
        mgr.set_http_monitor_run_location("mon-1", RunLocation::Agent("edge".into()))
            .expect("agent location accepted for a monitor");
        assert_eq!(
            mgr.requested_monitor_location("mon-1"),
            RunLocation::Agent("edge".into())
        );
        // This computer clears it back to the default.
        mgr.set_http_monitor_run_location("mon-1", RunLocation::ThisComputer)
            .expect("clear");
        assert_eq!(
            mgr.requested_monitor_location("mon-1"),
            RunLocation::ThisComputer
        );
    }

    #[test]
    fn list_http_monitors_includes_agent_hosted() {
        // An agent-hosted monitor projects from its control handle, so it lists
        // alongside desktop-hosted monitors and the frontend can't tell them apart.
        let mgr = NetworkManager::new();
        let cfg = HttpMonitorConfig::new(
            "https://edge.example/health".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        let id = cfg.id.clone();
        mgr.agent_monitors.lock().unwrap().insert(
            id.clone(),
            AgentMonitorHandle {
                agent_id: "edge".into(),
                config: cfg,
                last_result: None,
                running: true,
                paused: false,
            },
        );
        let listed = mgr.list_http_monitors();
        let found = listed.iter().find(|m| m.config.id == id).expect("listed");
        assert!(found.running);
        assert_eq!(found.config.url, "https://edge.example/health");
    }

    #[test]
    fn agent_hosted_paused_in_place_lists_as_running_and_paused() {
        // With in-place pause (#2607) an agent-hosted monitor keeps `running:
        // true` while `paused: true`, so its listing is identical to a
        // desktop-hosted paused monitor — the user cannot tell it pauses without a
        // stop-and-relist. (Before #2607 the desktop marked it paused too, but had
        // torn the agent instance down; now the instance stays hosted.)
        let mgr = NetworkManager::new();
        let cfg = HttpMonitorConfig::new(
            "https://edge.example/health".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        let id = cfg.id.clone();
        mgr.agent_monitors.lock().unwrap().insert(
            id.clone(),
            AgentMonitorHandle {
                agent_id: "edge".into(),
                config: cfg,
                last_result: None,
                running: true,
                paused: true,
            },
        );
        let listed = mgr.list_http_monitors();
        let found = listed.iter().find(|m| m.config.id == id).expect("listed");
        assert!(found.running, "a paused-in-place monitor stays running");
        assert!(found.paused, "and reports paused");
    }

    #[test]
    fn parse_agent_check_reads_running_state_and_normalizes_id() {
        // A `service.status` reply for a running agent monitor yields the streamed
        // check, keyed to the desktop's monitor id.
        let reply = json!({
            "running": true,
            "state": {
                "monitorId": "instance-side-id",
                "statusCode": 200,
                "latencyMs": 12,
                "ok": true,
                "error": null,
                "timestampMs": 1_700_000_000_000_u64
            }
        });
        let result = parse_agent_check("mon-1", &reply).expect("a running monitor yields a check");
        assert_eq!(result.monitor_id, "mon-1");
        assert_eq!(result.status_code, Some(200));
        assert!(result.ok);
    }

    #[test]
    fn parse_agent_check_none_when_not_running_or_no_check() {
        // Not running → no check.
        assert!(parse_agent_check("mon-1", &json!({ "running": false })).is_none());
        // Running but no streamed state yet → no check.
        assert!(parse_agent_check("mon-1", &json!({ "running": true, "state": null })).is_none());
    }

    // ── Run-location routing (#2190) ─────────────────────────────────────────

    #[test]
    fn tools_default_to_local_with_no_preference() {
        let mgr = NetworkManager::new();
        for t in [
            agent_tools::tool::PING,
            agent_tools::tool::TRACEROUTE,
            agent_tools::tool::PORT_SCAN,
            agent_tools::tool::DNS,
            agent_tools::tool::WOL,
            agent_tools::tool::HTTP_MONITOR,
        ] {
            assert_eq!(
                mgr.resolve_tool_location(t).expect("resolve"),
                ResolvedLocation::Local,
                "{t} must default to local"
            );
        }
    }

    #[test]
    fn recording_an_agent_routes_a_routable_tool_to_it() {
        let mgr = NetworkManager::new();
        mgr.set_run_location(
            agent_tools::tool::PING,
            RunLocation::Agent("build-box".into()),
        )
        .expect("set agent");
        assert_eq!(
            mgr.resolve_tool_location(agent_tools::tool::PING).unwrap(),
            ResolvedLocation::Agent("build-box".into())
        );
        // Other tools are unaffected — the preference is per-tool.
        assert_eq!(
            mgr.resolve_tool_location(agent_tools::tool::DNS).unwrap(),
            ResolvedLocation::Local
        );
    }

    #[test]
    fn this_computer_clears_a_recorded_preference() {
        let mgr = NetworkManager::new();
        mgr.set_run_location(
            agent_tools::tool::TRACEROUTE,
            RunLocation::Agent("a1".into()),
        )
        .expect("set agent");
        mgr.set_run_location(agent_tools::tool::TRACEROUTE, RunLocation::ThisComputer)
            .expect("clear");
        assert_eq!(
            mgr.resolve_tool_location(agent_tools::tool::TRACEROUTE)
                .unwrap(),
            ResolvedLocation::Local
        );
    }

    #[test]
    fn http_monitor_refuses_an_agent_location() {
        let mgr = NetworkManager::new();
        // Setting an agent location on the desktop-only HTTP monitor is rejected
        // up front, so nothing that must stay local is ever offered an agent.
        let err = mgr.set_run_location(
            agent_tools::tool::HTTP_MONITOR,
            RunLocation::Agent("a1".into()),
        );
        assert!(err.is_err(), "http monitor must refuse an agent location");
        // And it still resolves local.
        assert_eq!(
            mgr.resolve_tool_location(agent_tools::tool::HTTP_MONITOR)
                .unwrap(),
            ResolvedLocation::Local
        );
    }

    #[test]
    fn stop_all_http_monitors_is_noop_when_empty() {
        let mgr = NetworkManager::new();
        assert!(mgr.list_http_monitors().is_empty());
        mgr.stop_all_http_monitors();
        assert!(mgr.list_http_monitors().is_empty());
    }

    /// A manager pointed at a temp config dir, so persistence can be exercised
    /// without a live Tauri app.
    fn manager_with_config_dir(dir: &std::path::Path) -> NetworkManager {
        let mut mgr = NetworkManager::new();
        mgr.config_dir = dir.to_path_buf();
        mgr
    }

    #[test]
    fn persist_and_reload_monitor_configs() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let mgr = manager_with_config_dir(dir.path());

        let cfg = HttpMonitorConfig::new(
            "https://example.com/health".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        let id = cfg.id.clone();
        mgr.persist_monitor_config(cfg).expect("persist config");

        // A fresh manager over the same dir reloads the saved config.
        let reloaded = manager_with_config_dir(dir.path());
        let loaded = reloaded.load_persisted_monitor_configs();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, id);
        assert_eq!(loaded[0].url, "https://example.com/health");
    }

    #[test]
    fn removing_persisted_config_deletes_it_from_disk() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let mgr = manager_with_config_dir(dir.path());

        let cfg = HttpMonitorConfig::new(
            "https://example.com".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        let id = cfg.id.clone();
        mgr.persist_monitor_config(cfg).expect("persist config");
        assert_eq!(mgr.load_persisted_monitor_configs().len(), 1);

        mgr.remove_persisted_monitor_config(&id)
            .expect("remove config");
        assert!(mgr.load_persisted_monitor_configs().is_empty());
    }

    #[test]
    fn persist_overwrites_config_with_same_id() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let mgr = manager_with_config_dir(dir.path());

        let mut cfg = HttpMonitorConfig::new(
            "https://old.example.com".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        mgr.persist_monitor_config(cfg.clone()).expect("persist");
        // Same id, different url.
        cfg.url = "https://new.example.com".into();
        mgr.persist_monitor_config(cfg.clone())
            .expect("persist again");

        let loaded = mgr.load_persisted_monitor_configs();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].url, "https://new.example.com");
    }

    // ── Stop vs. Remove (audit Gap #6) ────────────────────────────────────────

    #[test]
    fn stop_keeps_monitor_listed_as_not_running() {
        // Gap #6: "Stop" must cancel the poll loop but KEEP the monitor listed
        // (as running:false) so the user can resume it — it must NOT delete it.
        let dir = tempfile::TempDir::new().expect("tempdir");
        let mgr = manager_with_config_dir(dir.path());

        let cfg = HttpMonitorConfig::new(
            "https://example.com".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        let id = insert_dummy_monitor_config(&mgr, cfg.clone());
        mgr.persist_monitor_config(cfg).expect("persist");

        mgr.stop_http_monitor(&id).expect("stop");

        // The poll loop is cancelled but the monitor stays listed as not running...
        let listed = mgr.list_http_monitors();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].config.id, id);
        assert!(!listed[0].running);
        // ...and its persisted config survives so it resumes on restart.
        assert_eq!(mgr.load_persisted_monitor_configs().len(), 1);
    }

    #[test]
    fn remove_deletes_monitor_and_config() {
        // Gap #6: "Remove" is the destructive action — it cancels, drops the
        // handle from the map, and deletes the persisted config.
        let dir = tempfile::TempDir::new().expect("tempdir");
        let mgr = manager_with_config_dir(dir.path());

        let cfg = HttpMonitorConfig::new(
            "https://example.com".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        let id = insert_dummy_monitor_config(&mgr, cfg.clone());
        mgr.persist_monitor_config(cfg).expect("persist");

        mgr.remove_http_monitor(&id).expect("remove");

        assert!(mgr.list_http_monitors().is_empty());
        assert!(mgr.load_persisted_monitor_configs().is_empty());
    }

    #[test]
    fn remove_unknown_monitor_errors() {
        let mgr = NetworkManager::new();
        assert!(mgr.remove_http_monitor("does-not-exist").is_err());
    }

    // ── Pause / Resume (audit Gap #5) ─────────────────────────────────────────

    #[test]
    fn pause_suspends_and_keeps_monitor_running() {
        // Gap #5: pausing suspends the poll body via the handle's `paused` flag
        // while keeping the loop alive (running stays true) and the config intact.
        let dir = tempfile::TempDir::new().expect("tempdir");
        let mgr = manager_with_config_dir(dir.path());

        let cfg = HttpMonitorConfig::new(
            "https://example.com".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        let id = insert_dummy_monitor_config(&mgr, cfg.clone());
        mgr.persist_monitor_config(cfg).expect("persist");

        // Initially running, not paused.
        let listed = mgr.list_http_monitors();
        assert!(listed[0].running);
        assert!(!listed[0].paused);

        mgr.pause_http_monitor(&id).expect("pause");

        // The poll body is suspended, but the loop is not cancelled and the
        // monitor is still listed as running and paused, with its config kept.
        let listed = mgr.list_http_monitors();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].running);
        assert!(listed[0].paused);
        assert_eq!(mgr.load_persisted_monitor_configs().len(), 1);
    }

    #[test]
    fn resume_restarts_a_paused_monitor_with_same_config() {
        // Resuming a paused monitor clears the flag and keeps the same config —
        // no new id, no lost history binding.
        let dir = tempfile::TempDir::new().expect("tempdir");
        let mgr = manager_with_config_dir(dir.path());

        let cfg = HttpMonitorConfig::new(
            "https://example.com".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        let cfg_id = cfg.id.clone();
        let id = insert_dummy_monitor_config(&mgr, cfg.clone());
        mgr.persist_monitor_config(cfg).expect("persist");

        mgr.pause_http_monitor(&id).expect("pause");
        assert!(mgr.list_http_monitors()[0].paused);

        mgr.resume_http_monitor(&id).expect("resume");

        let listed = mgr.list_http_monitors();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].config.id, cfg_id);
        assert!(listed[0].running);
        assert!(!listed[0].paused);
    }

    #[test]
    fn pause_unknown_monitor_errors() {
        let mgr = NetworkManager::new();
        assert!(mgr.pause_http_monitor("does-not-exist").is_err());
        assert!(mgr.resume_http_monitor("does-not-exist").is_err());
    }
}
