//! Desktop-side network diagnostics manager.
//!
//! Wraps the `termihub-core` network tools and exposes them via Tauri commands.
//! Manages running task lifetimes (port scans, ping sessions, traceroutes) and
//! the persistent HTTP monitors.

mod agent_monitors;
pub mod agent_stream;
pub mod agent_tools;
#[cfg(test)]
mod entry_extra_tests;
pub mod events;
pub mod http_monitor;
pub mod http_monitor_storage;
pub mod monitor_history;
pub mod monitor_history_manager;
pub mod monitor_history_storage;
pub mod tool_history;
pub mod tool_history_manager;
pub mod tool_history_storage;
pub mod tool_runner;
pub mod wol_storage;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use termihub_core::service::drain_broadcast;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error};
use uuid::Uuid;

use crate::agent_service::hosted::{
    is_unanswered, HostedServices, Outcome, Sample, StopPlan, Target,
};
use crate::agent_service::{
    agent_for_start, agent_start_error, stopping_reason, AgentStatusPollDelegate, AgentStatusPoller,
};
use crate::app_tasks::AppTasks;
use crate::connection::recovery::RecoveryWarning;
use agent_monitors::{AgentMonitors, HostedMonitors};
use http_monitor::{HttpCheckResult, HttpMonitorConfig, HttpMonitorService, HttpMonitorState};
use std::time::Instant;
use termihub_core::network::WolDevice;
use termihub_core::protocol::methods::{
    ServicePauseParams, ServiceResumeParams, ServiceStartParams, ServiceStatusResult,
};
use termihub_core::service::Service;
use termihub_core::tool::ToolRegistry;
use termihub_core::util::entry_extra::upsert_keeping_extra;
use termihub_core::util::service_host::{HostChoice, ServiceHost};

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

/// Tauri event sent when a monitor's row says more than fresh numbers: its
/// agent went or came back, a stop was confirmed (#6052).
const HTTP_MONITOR_CHANGED_EVENT: &str = "network-http-monitor-changed";

/// Where a monitor runs, as its entry stores it (#6039).
fn host_of(location: &RunLocation) -> ServiceHost {
    match location {
        RunLocation::ThisComputer => ServiceHost::default(),
        RunLocation::Agent(agent_id) => ServiceHost::agent(agent_id),
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
    /// HTTP monitors set to run on agents (#2592), with the states of services
    /// (#6052). Disjoint from `http_monitors` (desktop-hosted). Shared with the
    /// periodic `service.status` poller.
    agent_monitors: Arc<AgentMonitors>,
    /// The single periodic agent `service.status` poller (#2592). Runs while at
    /// least one agent-hosted monitor exists, self-reaping once none remain; the
    /// shared [`AgentStatusPoller`] owns the task lifecycle (DUP-020).
    agent_status_poller: AgentStatusPoller,
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
    /// The built-in network tools this computer runs (#3731). A local run goes
    /// through this registry — the same core `ToolRegistry` an agent's `tool.*`
    /// methods dispatch to — so each tool has one code path wherever it runs.
    tool_registry: Arc<ToolRegistry>,
    /// Saved Wake-on-LAN devices (persisted to disk).
    wol_devices: Mutex<Vec<WolDevice>>,
    /// App config directory for persistence.
    config_dir: PathBuf,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
    /// The app-wide owned-task registry (ARCH-007, #3105), captured in
    /// [`load_persisted`](Self::load_persisted). Every desktop-hosted HTTP-monitor poll loop is
    /// scoped to it (its stop token is a child of the app token and its thread
    /// is tracked), so app teardown cancels and awaits the loops even if a
    /// monitor escaped [`stop_all_http_monitors`](Self::stop_all_http_monitors).
    /// `None` until `load_persisted` (and in unit tests), where loops stay standalone.
    tasks: Option<AppTasks>,
}

impl NetworkManager {
    /// Create a new manager. Call [`NetworkManager::load_persisted`] after
    /// the Tauri app is set up to provide the config directory.
    pub fn new() -> Self {
        Self {
            active_tasks: Mutex::new(HashMap::new()),
            http_monitors: Mutex::new(HashMap::new()),
            agent_monitors: Arc::new(AgentMonitors::with(HostedServices::default())),
            agent_status_poller: AgentStatusPoller::new(),
            run_location: RunLocationResolver::new(),
            run_locations: Mutex::new(HashMap::new()),
            tool_registry: Arc::new(ToolRegistry::with_builtin_network_tools()),
            wol_devices: Mutex::new(Vec::new()),
            config_dir: PathBuf::new(),
            app_handle: Arc::new(Mutex::new(None)),
            tasks: None,
        }
    }

    /// Adopt the app-wide owned-task registry (ARCH-007, #3105): HTTP-monitor
    /// poll loops and the agent `service.status` poller become app-owned, so
    /// app teardown cancels them and waits (bounded) for them to finish.
    fn adopt_app_tasks(&mut self, tasks: AppTasks) {
        self.agent_status_poller = AgentStatusPoller::with_tasks(tasks.clone());
        self.tasks = Some(tasks);
    }

    /// Scope a desktop-hosted monitor's poll loop to the app lifetime when the
    /// app task registry is known (see [`adopt_app_tasks`](Self::adopt_app_tasks)).
    fn own_monitor(&self, service: &mut HttpMonitorService) {
        if let Some(tasks) = &self.tasks {
            service.set_owner(tasks.cancellation_token(), tasks.tracker());
        }
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

    /// The registry of built-in network tools a local run dispatches to (#3731).
    pub fn tool_registry(&self) -> Arc<ToolRegistry> {
        Arc::clone(&self.tool_registry)
    }

    /// The agent RPC client from Tauri managed state, if available (#2190).
    ///
    /// `None` before the app is fully set up (e.g. in unit tests without a live
    /// Tauri app); the agent-routed path treats that as "agent unavailable".
    pub fn agent_rpc_client(&self) -> Option<Arc<dyn AgentRpcClient>> {
        self.app_handle()
            .and_then(|app| crate::agent_service::agent_rpc_client(&app))
    }

    /// Hand the manager the app handle it emits events and reaches managed
    /// state through. Called at boot before
    /// [`load_persisted`](Self::load_persisted).
    pub fn attach_app_handle(&self, app_handle: AppHandle) {
        if let Ok(mut handle) = self.app_handle.lock() {
            *handle = Some(app_handle);
        }
    }

    /// Initialise the manager with the app config directory: adopt the app
    /// task registry (when there is one), then load the persisted WoL devices
    /// and HTTP monitor configs from disk, returning any recovery warnings (a
    /// newer-version file left untouched, a corrupt file backed up and
    /// salvaged) for the startup notice (#3946). Takes no `AppHandle`, so the
    /// boot phase runs on a mock app (#5313).
    pub(crate) fn load_persisted(
        &mut self,
        config_dir: PathBuf,
        tasks: Option<AppTasks>,
    ) -> Vec<RecoveryWarning> {
        let mut warnings = Vec::new();
        self.config_dir = config_dir.clone();
        // Before any monitor is loaded, so every poll loop is app-owned.
        if let Some(tasks) = tasks {
            self.adopt_app_tasks(tasks);
        }
        match wol_storage::load_wol_devices_with_recovery(&config_dir) {
            Ok(result) => {
                warnings.extend(result.warnings);
                if let Ok(mut guard) = self.wol_devices.lock() {
                    *guard = result.data;
                }
            }
            Err(e) => {
                error!("Failed to load WoL devices: {e}");
            }
        }
        // Reload persisted HTTP monitor configs and list each as a *stopped*
        // monitor (PERF-008): a saved monitor is no longer auto-started into a
        // continuously-polling loop on launch. It still appears in the UI (so it
        // does not silently vanish and can be resumed) but does zero network work
        // until the user starts/resumes it. This removes the steady-state
        // CPU/network cost of every saved monitor firing requests from launch,
        // forever, whether or not the monitors view is ever opened.
        let configs = match http_monitor_storage::load_http_monitors_with_recovery(&config_dir) {
            Ok(result) => {
                warnings.extend(result.warnings);
                result.data
            }
            Err(e) => {
                error!("Failed to load persisted HTTP monitors: {e}");
                Vec::new()
            }
        };
        // Stops agents owed before the app ended are sent again (#6051).
        self.agent_monitors = Arc::new(AgentMonitors::stored(&config_dir));
        for config in configs {
            self.load_http_monitor_stopped(config);
        }
        if self.agent_monitors.hosted.any() {
            self.ensure_status_poller();
        }
        warnings
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

    // ── Where a monitor runs (#2592, #6039) ──────────────────────────────────

    /// Find an **actively-running** monitor (desktop- or agent-hosted) whose
    /// target URL matches `url`, returning its monitor id (SM-019).
    ///
    /// The server-side dedupe key is the exact target URL: two monitors that
    /// poll the same URL are duplicate work, so
    /// [`start_http_monitor`](Self::start_http_monitor) returns the existing one
    /// instead of spawning a second loop. Only *running* loops count. A poisoned
    /// lock yields `None` (fail-open).
    fn active_monitor_id_for_url(&self, url: &str) -> Option<String> {
        if let Ok(monitors) = self.http_monitors.lock() {
            if let Some(id) = monitors.iter().find_map(|(id, svc)| {
                svc.state()
                    .filter(|s| s.running && s.config.url == url)
                    .map(|_| id.clone())
            }) {
                return Some(id);
            }
        }
        self.agent_monitors.running_with_url(url)
    }

    /// Start a new HTTP monitor and persist its config. Returns its ID.
    ///
    /// `run_location` is stored with it (#6039): an agent choice hosts the
    /// monitor on that agent (#2592), now and after a restart. The config is
    /// written to disk so the monitor survives a relaunch, where it loads
    /// *stopped* and is resumed on demand (PERF-008). Blocking while it reaches
    /// an agent: the command runs it off the main thread (#6052).
    pub fn start_http_monitor(
        &self,
        mut config: HttpMonitorConfig,
        run_location: RunLocation,
    ) -> Result<String, TerminalError> {
        // Server-side dedupe by URL (SM-019): only running loops dedupe.
        if let Some(existing) = self.active_monitor_id_for_url(&config.url) {
            debug!(
                url = %config.url,
                existing_monitor = %existing,
                "HTTP monitor already running for URL — returning existing id (SM-019)"
            );
            return Ok(existing);
        }
        self.run_location
            .resolve(&config.id, Locality::LocalOrAgent, &run_location)
            .map_err(|e| TerminalError::NetworkError(e.to_string()))?;
        config.host = host_of(&run_location);
        // Persist first so a monitor the user just created survives a restart
        // even if it is stopped before the next save.
        self.persist_monitor_config(config.clone())?;
        self.spawn_http_monitor(config)
    }

    /// Start the monitor of `config` where its stored host says, **without**
    /// touching disk: on this computer, on its agent, or — a host this build
    /// cannot read — nowhere (#6039).
    fn spawn_http_monitor(&self, config: HttpMonitorConfig) -> Result<String, TerminalError> {
        match config.host.choice() {
            HostChoice::ThisComputer => {}
            HostChoice::Agent(agent_id) => {
                let agent_id = agent_id.to_string();
                return self.start_agent_monitor(config, &agent_id);
            }
            HostChoice::Unreadable => {
                // Listed with the reason; never checked from this computer.
                let reason = "Not started: termiHub cannot read where it runs.".to_string();
                if let Ok(mut monitors) = self.http_monitors.lock() {
                    monitors.remove(&config.id);
                }
                self.agent_monitors.refuse(&config.id, reason.clone());
                self.agent_monitors.list(config);
                self.announce_monitors();
                return Err(TerminalError::NetworkError(reason));
            }
        }

        let app = self
            .app_handle()
            .ok_or_else(|| TerminalError::InternalError("app handle not available".into()))?;
        let id = config.id.clone();

        let mut service = HttpMonitorService::new();
        self.own_monitor(&mut service);
        // Subscribe before starting so the bridge cannot miss the first check.
        let events = service.subscribe_events();
        service.start_with(config);
        spawn_event_bridge(app, events);

        if let Ok(mut monitors) = self.http_monitors.lock() {
            monitors.insert(id.clone(), service);
        }
        Ok(id)
    }

    /// Load a persisted monitor as **stopped-but-listed** on launch, without
    /// starting its poll loop (PERF-008). One stored to run on an agent is
    /// listed there, and its agent is asked whether it still checks (#6051).
    fn load_http_monitor_stopped(&self, config: HttpMonitorConfig) {
        if config.host.choice() != HostChoice::ThisComputer {
            if let Some(agent_id) = agent_monitors::agent_of(&config) {
                self.agent_monitors.hosted.expect(&config.id, agent_id);
            }
            self.agent_monitors.list(config);
            return;
        }
        let id = config.id.clone();
        let mut service = HttpMonitorService::stopped_with(config);
        // A later resume re-spawns the loop app-owned.
        self.own_monitor(&mut service);
        // Wire the bridge now so a later resume forwards events without a
        // re-subscribe; skipped only when there is no app handle (unit tests).
        if let Some(app) = self.app_handle() {
            let events = service.subscribe_events();
            spawn_event_bridge(app, events);
        }
        if let Ok(mut monitors) = self.http_monitors.lock() {
            monitors.insert(id, service);
        }
    }

    // ── Agent-hosted monitors (#2592, #6052) ─────────────────────────────────

    /// Host a monitor on its agent over the agent RPC: the right agent or not
    /// at all (#6039). An agent that is removed, offline, too old or refuses
    /// starts nothing, and the row says why; one that does not answer may still
    /// check there, and its next answer decides (#6052).
    fn start_agent_monitor(
        &self,
        config: HttpMonitorConfig,
        agent_id: &str,
    ) -> Result<String, TerminalError> {
        let id = config.id.clone();
        // Listed there, not here.
        if let Ok(mut monitors) = self.http_monitors.lock() {
            if let Some(mut service) = monitors.remove(&id) {
                service.shutdown();
            }
        }
        let monitors = Arc::clone(&self.agent_monitors);
        monitors.list(config.clone());
        monitors.clear_refusal(&id);
        let refuse = |reason: String| {
            monitors.refuse(&id, reason.clone());
            self.announce_monitors();
            Err(TerminalError::NetworkError(reason))
        };
        let client = match self.app_handle() {
            Some(app) => match agent_for_start(&app, agent_id) {
                Ok(client) => client,
                Err(reason) => return refuse(reason.text),
            },
            None => match self.agent_rpc_client() {
                Some(client) => client,
                None => return refuse("Not started: its agent is not connected.".into()),
            },
        };
        let ticket = match monitors.hosted.begin(&id) {
            Ok(ticket) => ticket,
            // It checks there already, or a start is under way.
            Err(_) => return Ok(id),
        };
        // An older stop the agent has not confirmed comes first.
        if !monitors
            .hosted
            .send_owed_stop(client.as_ref(), agent_id, &id, Instant::now())
        {
            monitors
                .hosted
                .finish(ticket, Outcome::Failed, Instant::now());
            let reason = match self.app_handle() {
                Some(app) => stopping_reason(&app, agent_id).text,
                None => "Its agent has not confirmed the last stop yet.".into(),
            };
            return refuse(reason);
        }
        let params = ServiceStartParams {
            instance_id: id.clone(),
            service_id: http_monitor::SERVICE_ID.to_string(),
            config: serde_json::to_value(agent_monitors::for_agent(&config)).map_err(|e| {
                TerminalError::NetworkError(format!("serialize monitor config: {e}"))
            })?,
        };
        let params = serde_json::to_value(params)
            .map_err(|e| TerminalError::NetworkError(format!("build service.start params: {e}")))?;
        let outcome = match client.send_request(
            agent_id,
            termihub_core::protocol::methods::SERVICE_START,
            params,
        ) {
            Ok(_) => Outcome::Started {
                agent_id: agent_id.to_string(),
                state: None,
            },
            Err(e) if is_unanswered(&e) => {
                tracing::warn!(monitor_id = %id, %agent_id, error = %e, "start got no answer");
                Outcome::Unanswered {
                    agent_id: agent_id.to_string(),
                    state: None,
                }
            }
            Err(e) => {
                monitors
                    .hosted
                    .finish(ticket, Outcome::Failed, Instant::now());
                return refuse(agent_start_error(&e).text);
            }
        };
        let finished = monitors.hosted.finish(ticket, outcome, Instant::now());
        if let Some(agent) = AgentMonitors::finished(finished) {
            // Stopped while it was starting: stop what it started.
            monitors
                .hosted
                .send_owed_stop(client.as_ref(), &agent, &id, Instant::now());
        }
        monitors.set_paused(&id, false);
        self.ensure_status_poller();
        self.announce_monitors();
        tracing::info!("HTTP monitor {id} started on agent {agent_id}");
        Ok(id)
    }

    /// Ensure the single periodic agent `service.status` poller is running
    /// (#2592). Idempotent. No-op without an app handle (unit tests).
    fn ensure_status_poller(&self) {
        if let Some(app) = self.app_handle() {
            self.agent_status_poller.ensure(AgentMonitorPoll {
                monitors: Arc::clone(&self.agent_monitors),
                app,
            });
        }
    }

    /// Tell the windows that a monitor's row changed more than its numbers.
    fn announce_monitors(&self) {
        if let Some(app) = self.app_handle() {
            let _ = app.emit(HTTP_MONITOR_CHANGED_EVENT, ());
        }
    }

    /// Stop an agent-hosted monitor, keeping it listed: the stop is owed until
    /// its agent confirms it, however long it is away, and across a restart
    /// (#6052). Blocking while it reaches the agent.
    fn stop_agent_monitor(&self, monitor_id: &str) {
        let monitors = &self.agent_monitors;
        monitors.set_paused(monitor_id, false);
        monitors.clear_refusal(monitor_id);
        if let StopPlan::StopThere(agent_id) = monitors.hosted.stop(monitor_id) {
            if let Some(client) = self.agent_rpc_client() {
                monitors.hosted.send_owed_stop(
                    client.as_ref(),
                    &agent_id,
                    monitor_id,
                    Instant::now(),
                );
            }
            self.ensure_status_poller();
        }
        self.announce_monitors();
    }

    /// Send `service.pause` / `service.resume` to the agent of `monitor_id`.
    fn agent_monitor_request(
        &self,
        monitor_id: &str,
        method: &'static str,
        params: serde_json::Value,
    ) -> Result<(), TerminalError> {
        let agent_id = self
            .agent_monitors
            .hosted
            .agent_id_of(monitor_id)
            .ok_or_else(|| TerminalError::NotFound(format!("monitor '{monitor_id}'")))?;
        let client = self.agent_rpc_client().ok_or_else(|| {
            TerminalError::NetworkError("Agent manager is not available".to_string())
        })?;
        client
            .send_request(&agent_id, method, params)
            .map(|_| ())
            .map_err(|e| TerminalError::NetworkError(format!("agent-hosted HTTP monitor: {e}")))
    }

    /// Stop a running HTTP monitor, keeping it **listed** (as `running: false`).
    ///
    /// Audit Gap #6: Stop must suspend polling without destroying the monitor —
    /// its handle stays listed and its persisted config is kept, so
    /// [`resume_http_monitor`](Self::resume_http_monitor) (or the next launch)
    /// can bring it back. Use [`remove_http_monitor`](Self::remove_http_monitor)
    /// to truly delete it.
    pub fn stop_http_monitor(&self, monitor_id: &str) -> Result<(), TerminalError> {
        // Write the checks recorded since the last persist, so a stopped
        // monitor's history is complete on disk (#3462).
        if let Some(app) = self.app_handle() {
            monitor_history_manager::flush_history(&app);
        }
        if self.agent_monitors.has(monitor_id) {
            self.stop_agent_monitor(monitor_id);
            return Ok(());
        }
        let mut monitors = self
            .http_monitors
            .lock()
            .map_err(|_| TerminalError::InternalError("http monitor lock poisoned".into()))?;
        match monitors.get_mut(monitor_id) {
            Some(service) => {
                // Cancel the poll loop but leave the service listed; its event
                // channel stays open, so a later Resume keeps the same bridge.
                service.shutdown();
                Ok(())
            }
            None => Err(TerminalError::NotFound(format!("monitor '{monitor_id}'"))),
        }
    }

    /// Remove an HTTP monitor entirely: cancel its poll loop, drop its handle
    /// and delete its persisted config. On an agent, its stop stays owed.
    pub fn remove_http_monitor(&self, monitor_id: &str) -> Result<(), TerminalError> {
        // A removed monitor's check history goes with it (#3462).
        if let Some(app) = self.app_handle() {
            monitor_history_manager::forget_monitor(&app, monitor_id);
        }
        if self.agent_monitors.has(monitor_id) {
            self.stop_agent_monitor(monitor_id);
            self.agent_monitors.forget(monitor_id);
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
                service.shutdown();
                drop(monitors);
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
        // Agent-hosted: paused IN PLACE over `service.pause` (#2607).
        if self.agent_monitors.has(monitor_id) {
            if !self.agent_monitors.hosted.is_running(monitor_id) {
                return Err(TerminalError::NetworkError(
                    "It does not run on its agent now.".into(),
                ));
            }
            let params = serde_json::to_value(ServicePauseParams {
                instance_id: monitor_id.to_string(),
            })
            .map_err(|e| TerminalError::NetworkError(format!("build service.pause params: {e}")))?;
            self.agent_monitor_request(
                monitor_id,
                termihub_core::protocol::methods::SERVICE_PAUSE,
                params,
            )?;
            self.agent_monitors.set_paused(monitor_id, true);
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

    /// Resume a paused or stopped HTTP monitor with the same config, where its
    /// stored host says (#6039).
    ///
    /// - A **paused** monitor (loop still alive) simply clears its `paused` flag.
    /// - A **stopped** monitor is started again, reusing the same config/id.
    pub fn resume_http_monitor(&self, monitor_id: &str) -> Result<(), TerminalError> {
        if let Some(config) = self.agent_monitors.config(monitor_id) {
            if self.agent_monitors.hosted.is_running(monitor_id) {
                if self.agent_monitors.is_paused(monitor_id) {
                    let params = serde_json::to_value(ServiceResumeParams {
                        instance_id: monitor_id.to_string(),
                    })
                    .map_err(|e| {
                        TerminalError::NetworkError(format!("build service.resume params: {e}"))
                    })?;
                    self.agent_monitor_request(
                        monitor_id,
                        termihub_core::protocol::methods::SERVICE_RESUME,
                        params,
                    )?;
                    self.agent_monitors.set_paused(monitor_id, false);
                }
                return Ok(());
            }
            // Stopped (or moved off): start where it is stored to run now.
            let config = self
                .load_persisted_monitor_configs()
                .into_iter()
                .find(|c| c.id == monitor_id)
                .unwrap_or(config);
            if config.host.choice() == HostChoice::ThisComputer {
                self.agent_monitors.forget(monitor_id);
            }
            return self.spawn_http_monitor(config).map(|_| ());
        }
        let stored = self
            .load_persisted_monitor_configs()
            .into_iter()
            .find(|c| c.id == monitor_id);
        // Set to run on an agent, or where this build cannot read: not here.
        if let Some(config) = stored.filter(|c| c.host.choice() != HostChoice::ThisComputer) {
            let running = self
                .http_monitors
                .lock()
                .is_ok_and(|monitors| monitors.get(monitor_id).is_some_and(|s| s.is_running()));
            if running {
                return Ok(());
            }
            return self.spawn_http_monitor(config).map(|_| ());
        }
        let mut monitors = self
            .http_monitors
            .lock()
            .map_err(|_| TerminalError::InternalError("http monitor lock poisoned".into()))?;
        match monitors.get_mut(monitor_id) {
            Some(service) => {
                // A paused loop clears its flag; a stopped loop is re-spawned on
                // the same event channel.
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
        // Keep the entry's unknown on-disk fields, drop the IPC copy's (#3951).
        upsert_keeping_extra(&mut configs, config);
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

        // Agent-hosted monitors too (#2592): a stop each; one an offline agent
        // does not get is kept and sent after the next start (#6051).
        for id in self.agent_monitors.ids() {
            self.stop_agent_monitor(&id);
        }
        self.agent_status_poller.stop();

        // Persist the checks recorded since the last write (app shutdown, #3462).
        if let Some(app) = self.app_handle() {
            monitor_history_manager::flush_history(&app);
        }
    }

    /// List all HTTP monitors (running and stopped), desktop- and agent-hosted.
    pub fn list_http_monitors(&self) -> Vec<HttpMonitorState> {
        let mut states: Vec<HttpMonitorState> = self
            .http_monitors
            .lock()
            .map(|monitors| monitors.values().filter_map(|s| s.state()).collect())
            .unwrap_or_default();
        // A monitor on an agent says what is known there (#6052).
        states.extend(self.agent_monitors.states(self.app_handle().as_ref()));
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
        // Replace existing device with same ID, or append. The entry keeps its
        // unknown on-disk fields and drops the IPC copy's (#3951).
        upsert_keeping_extra(&mut guard, device);
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

/// Bridge a monitor's core [`EventChannel`](termihub_core::service::EventChannel)
/// to the desktop's Tauri emitter.
///
/// Forwards each `check` [`ServiceEvent`](termihub_core::service::ServiceEvent)
/// as a [`HTTP_MONITOR_CHECK_EVENT`] Tauri event so the frontend receives the
/// same `HttpCheckResult` payload as before the lift. The task ends when the
/// service is dropped (channel closed).
///
/// # A deliberate permanent observer (#2811)
///
/// The bridge holds its subscription for the monitor's whole lifetime, so the
/// poll loop's observer gate (PERF-008) always sees a subscriber for a desktop
/// monitor. That is intended: the forwarded results feed consumers that work
/// with the Network Tools UI closed — the app-wide up/down toasts
/// (`useHttpMonitorNotifications`, mounted at the app root) and the backend check
/// history recorded below (#3462). A monitor the user started therefore keeps
/// checking in the background until they pause or stop it; making this
/// subscription panel-scoped would silently break both. The PERF-008 launch
/// saving comes from loading saved monitors *stopped* instead
/// ([`NetworkManager::load_http_monitor_stopped`]), not from this gate.
fn spawn_event_bridge(app: AppHandle, events: termihub_core::service::ServiceEventReceiver) {
    // Not app-owned (#3105): ends when the monitor's service (and its channel) drops.
    tauri::async_runtime::spawn(async move {
        drain_broadcast(events, move |event| {
            if event.kind == http_monitor::CHECK_EVENT_KIND {
                // Record the check backend-side (#3462) so the monitor's history
                // survives stop/resume and restart even with the panel closed.
                if let Ok(result) = serde_json::from_value::<HttpCheckResult>(event.payload.clone())
                {
                    monitor_history_manager::record_check(&app, &result);
                }
                let _ = app.emit(HTTP_MONITOR_CHECK_EVENT, event.payload);
            }
        })
        .await;
    });
}

/// The HTTP-monitor side of the shared agent status poller (DUP-020): asks the
/// agents about their monitors and sends the stops they owe (#6052), and passes
/// each fresh check on as a desktop-hosted one's.
struct AgentMonitorPoll {
    monitors: Arc<AgentMonitors>,
    app: AppHandle,
}

impl AgentStatusPollDelegate for AgentMonitorPoll {
    type Target = Target<agent_monitors::Seen>;
    type Sample = Sample<agent_monitors::Seen>;

    fn interval(&self) -> Duration {
        AGENT_STATUS_POLL_INTERVAL
    }

    fn client(&self) -> Option<Arc<dyn AgentRpcClient>> {
        crate::agent_service::agent_rpc_client(&self.app)
    }

    fn snapshot_targets(&self) -> (Vec<Self::Target>, bool) {
        self.monitors.targets()
    }

    fn poll(client: Arc<dyn AgentRpcClient>, targets: &[Self::Target]) -> Vec<Self::Sample> {
        HostedServices::<HostedMonitors>::poll(client.as_ref(), targets)
    }

    fn apply(&self, samples: Vec<Self::Sample>) {
        let applied = self.monitors.apply(samples);
        for check in applied.checks {
            // Agent-hosted checks are recorded on the desktop too (#3462).
            monitor_history_manager::record_check(&self.app, &check);
            let _ = self.app.emit(HTTP_MONITOR_CHECK_EVENT, check);
        }
        if applied.changed {
            let _ = self.app.emit(HTTP_MONITOR_CHANGED_EVENT, ());
        }
    }
}

/// Parse an agent `service.status` reply into the latest [`HttpCheckResult`], or
/// `None` when the monitor is not running or has streamed no check yet (#2592).
///
/// Pure, so the parse is unit-testable without an agent mock.
fn parse_agent_check(monitor_id: &str, reply: &serde_json::Value) -> Option<HttpCheckResult> {
    // Parse the reply into the shared `ServiceStatusResult` DTO (DUP-001); a
    // not-running instance or an unparseable reply yields no sample.
    let status = serde_json::from_value::<ServiceStatusResult>(reply.clone()).ok()?;
    if !status.running {
        return None;
    }
    let mut result: HttpCheckResult = serde_json::from_value(status.state?).ok()?;
    // Defend against a config-id/instance-id mismatch: the desktop keys checks by
    // the monitor id it started, so normalise to it.
    result.monitor_id = monitor_id.to_string();
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use termihub_core::protocol::methods::{ServiceStatusParams, ServiceStopParams};

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

    /// App teardown (ARCH-007, #3105): a desktop-hosted monitor's poll loop —
    /// on its own thread + runtime — is scoped to the app's [`AppTasks`], so
    /// `shutdown` cancels it and awaits its thread even without
    /// `stop_all_http_monitors`, well within the bound. (Real clock: the loop
    /// runs on its own runtime, which a paused test clock cannot drive.)
    #[tokio::test]
    async fn http_monitor_loop_stops_on_app_cancellation() {
        let tasks = AppTasks::new();
        let mut mgr = NetworkManager::new();
        mgr.adopt_app_tasks(tasks.clone());

        // A long interval: without cancellation the loop would sleep for a
        // minute; nothing subscribes, so it does no network work either.
        let config = HttpMonitorConfig::new(
            "http://127.0.0.1:9/".to_string(),
            60_000,
            "GET".to_string(),
            200,
            1_000,
        );
        let mut service = HttpMonitorService::new();
        mgr.own_monitor(&mut service);
        service.start_with(config);
        assert!(service.is_running());
        // Let the loop thread get past client setup into its long idle sleep;
        // it is still registered with the tracker (it would sleep 60 s).
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(tasks.tracker().len(), 1, "the loop thread is tracked");

        let started = std::time::Instant::now();
        let outcome = tasks
            .shutdown(crate::app_tasks::DEFAULT_SHUTDOWN_TIMEOUT)
            .await;

        assert_eq!(outcome, crate::app_tasks::ShutdownOutcome::Completed);
        assert!(
            started.elapsed() < crate::app_tasks::DEFAULT_SHUTDOWN_TIMEOUT,
            "teardown completes within its bound"
        );
        assert!(
            !service.is_running(),
            "the app token cancelled the monitor's own stop token"
        );
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

    // ── Per-monitor run-location + agent hosting (#2592) ─────────────────────

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

    /// DUP-001: the agent-hosted HTTP-monitor `service.*` requests serialize
    /// byte-for-byte to the pre-migration hand-built `json!` — a change is a WIRE
    /// BREAK, the agent deserializes these into `Service*Params`.
    #[test]
    fn agent_service_params_serialize_to_expected_wire() {
        assert_eq!(
            serde_json::to_value(ServiceStartParams {
                instance_id: "mon-1".to_string(),
                service_id: http_monitor::SERVICE_ID.to_string(),
                config: json!({ "url": "https://x" }),
            })
            .unwrap(),
            json!({
                "instanceId": "mon-1",
                "serviceId": http_monitor::SERVICE_ID,
                "config": { "url": "https://x" },
            }),
        );
        for value in [
            serde_json::to_value(ServiceStopParams {
                instance_id: "mon-1".to_string(),
            })
            .unwrap(),
            serde_json::to_value(ServicePauseParams {
                instance_id: "mon-1".to_string(),
            })
            .unwrap(),
            serde_json::to_value(ServiceResumeParams {
                instance_id: "mon-1".to_string(),
            })
            .unwrap(),
            serde_json::to_value(ServiceStatusParams {
                instance_id: "mon-1".to_string(),
            })
            .unwrap(),
        ] {
            assert_eq!(value, json!({ "instanceId": "mon-1" }));
        }
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
    fn persisted_monitors_load_stopped_not_auto_started() {
        // PERF-008: on launch a saved monitor must be *listed* but *stopped* — it
        // must not auto-start a continuously-polling loop. The user resumes it
        // when they actually want it running.
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

        // Mirror what `load_persisted` does at launch: load each persisted config stopped.
        for config in mgr.load_persisted_monitor_configs() {
            mgr.load_http_monitor_stopped(config);
        }

        let listed = mgr.list_http_monitors();
        assert_eq!(listed.len(), 1, "the saved monitor is still listed");
        assert_eq!(listed[0].config.id, id);
        assert!(
            !listed[0].running,
            "a saved monitor must load stopped, not auto-started (PERF-008)"
        );
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

    // ── Server-side dedupe by URL (SM-019) ────────────────────────────────────

    #[test]
    fn active_monitor_id_for_url_matches_a_running_monitor() {
        // A running desktop monitor is found by its exact URL; a different URL is
        // not matched, so a genuinely-new monitor still starts.
        let mgr = NetworkManager::new();
        let cfg = HttpMonitorConfig::new(
            "https://svc.example/health".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        let url = cfg.url.clone();
        let id = insert_dummy_monitor_config(&mgr, cfg);
        assert_eq!(mgr.active_monitor_id_for_url(&url), Some(id));
        assert_eq!(
            mgr.active_monitor_id_for_url("https://other.example/"),
            None,
            "a new URL must not be deduped"
        );
    }

    #[test]
    fn active_monitor_id_for_url_ignores_stopped_monitors() {
        // A stopped-but-listed monitor (a persisted config, or one the user
        // stopped) must NOT dedupe — restarting/resuming that URL is legitimate.
        let mgr = NetworkManager::new();
        let cfg = HttpMonitorConfig::new(
            "https://svc.example/health".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        let url = cfg.url.clone();
        mgr.load_http_monitor_stopped(cfg);
        assert_eq!(
            mgr.active_monitor_id_for_url(&url),
            None,
            "a stopped monitor must not block re-starting its URL"
        );
    }

    #[test]
    fn start_http_monitor_dedupes_a_running_url_and_does_not_double_spawn() {
        // SM-019: the backend is the authoritative guard against double-polling a
        // URL — it must not rely on the client-side guard. If a monitor is already
        // actively polling a URL and a second start for that same URL reaches the
        // backend (client guard bypassed, a race, or a duplicate call), the backend
        // must NOT spawn a second poll loop; it returns the already-running
        // monitor's id, idempotently.
        let dir = tempfile::TempDir::new().expect("tempdir");
        let mgr = manager_with_config_dir(dir.path());

        // An already-running monitor for the URL (a live poll loop).
        let running_cfg = HttpMonitorConfig::new(
            "https://dup.example/health".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        let url = running_cfg.url.clone();
        let existing_id = insert_dummy_monitor_config(&mgr, running_cfg);

        // A second start for the SAME url but a DISTINCT id — as if the client
        // guard was bypassed or a start raced. Before the fix this would spawn a
        // second loop (or, without an app handle, error); after the fix it returns
        // the existing id without spawning anything.
        let dup_cfg = HttpMonitorConfig::new(url.clone(), 30_000, "GET".into(), 200, 5_000);
        assert_ne!(
            dup_cfg.id, existing_id,
            "the duplicate start carries a fresh id"
        );
        let returned = mgr
            .start_http_monitor(dup_cfg, RunLocation::ThisComputer)
            .expect("dedupe returns the existing id, not an error");
        assert_eq!(
            returned, existing_id,
            "start returns the already-running monitor's id"
        );

        // Exactly one monitor is tracked for that URL — no second poll loop.
        let listed = mgr.list_http_monitors();
        assert_eq!(
            listed.iter().filter(|m| m.config.url == url).count(),
            1,
            "only one loop may poll a given URL"
        );
        assert_eq!(listed.len(), 1, "no second monitor was created");
        // The duplicate config was never persisted — dedupe happens before persist.
        assert!(
            mgr.load_persisted_monitor_configs().is_empty(),
            "a deduped start must not persist a duplicate config"
        );
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

    /// Regression for TAURI-002: background tasks must reach the manager through
    /// an owned `Arc<NetworkManager>` clone moved into the task — not a `State`
    /// reference laundered through a `usize` pointer. This exercises that exact
    /// pattern (clone the `Arc`, `move` it into a spawned task, complete the
    /// task from inside) and asserts the bookkeeping still works.
    #[tokio::test]
    async fn owned_arc_clone_completes_task_from_spawned_task() {
        let manager = Arc::new(NetworkManager::new());
        let (task_id, _cancel) = manager.register_task();

        // The clone is what the network commands now move into `tokio::spawn`.
        let task_manager = Arc::clone(&manager);
        let tid = task_id.clone();
        tokio::spawn(async move {
            task_manager.complete_task(&tid);
        })
        .await
        .expect("spawned task joins");

        // The task removed itself, so cancelling the same id now reports it gone.
        assert!(
            manager.cancel_task(&task_id).is_err(),
            "completed task must no longer be registered"
        );
    }

    // ── Task lifecycle (ping / scan / traceroute runs, #5288) ────────────────

    #[test]
    fn cancel_task_cancels_its_token_and_forgets_it() {
        let mgr = NetworkManager::new();
        let (id, token) = mgr.register_task();
        assert!(!token.is_cancelled());

        mgr.cancel_task(&id).expect("a registered task cancels");
        assert!(token.is_cancelled(), "the running trace sees the cancel");
        // Gone: a second cancel is NotFound.
        assert!(matches!(
            mgr.cancel_task(&id),
            Err(TerminalError::NotFound(_))
        ));
    }

    #[test]
    fn complete_task_forgets_it_without_cancelling() {
        let mgr = NetworkManager::new();
        let (id, token) = mgr.register_task();
        mgr.complete_task(&id);
        assert!(!token.is_cancelled(), "a finished run is not cancelled");
        assert!(matches!(
            mgr.cancel_task(&id),
            Err(TerminalError::NotFound(_))
        ));
        // Completing an unknown task is a harmless no-op.
        mgr.complete_task("never-registered");
    }

    #[test]
    fn concurrent_tasks_get_distinct_ids_and_cancel_independently() {
        let mgr = NetworkManager::new();
        let (a, token_a) = mgr.register_task();
        let (b, token_b) = mgr.register_task();
        assert_ne!(a, b);
        mgr.cancel_task(&a).unwrap();
        assert!(token_a.is_cancelled());
        assert!(!token_b.is_cancelled(), "the other run keeps going");
        mgr.cancel_task(&b).unwrap();
    }

    // ── WoL devices ──────────────────────────────────────────────────────────

    fn wol_device(id: &str, name: &str) -> WolDevice {
        WolDevice {
            id: id.to_string(),
            name: name.to_string(),
            mac: "AA:BB:CC:DD:EE:FF".to_string(),
            broadcast: "255.255.255.255".to_string(),
            port: 9,
            extra: Default::default(),
        }
    }

    #[test]
    fn wol_devices_save_replace_and_delete_persist() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let mgr = manager_with_config_dir(dir.path());
        mgr.save_wol_device(wol_device("nas", "NAS")).unwrap();
        mgr.save_wol_device(wol_device("pc", "PC")).unwrap();
        // Same id replaces in place rather than appending.
        mgr.save_wol_device(wol_device("nas", "NAS (renamed)"))
            .unwrap();
        let names: Vec<String> = mgr.list_wol_devices().into_iter().map(|d| d.name).collect();
        assert_eq!(names, ["NAS (renamed)", "PC"]);

        mgr.delete_wol_device("pc").unwrap();
        let on_disk = wol_storage::load_wol_devices_with_recovery(dir.path())
            .expect("load")
            .data;
        assert_eq!(on_disk.len(), 1);
        assert_eq!(on_disk[0].name, "NAS (renamed)");
    }

    #[test]
    fn deleting_an_unknown_wol_device_is_not_found_and_writes_nothing() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let mgr = manager_with_config_dir(dir.path());
        assert!(matches!(
            mgr.delete_wol_device("ghost"),
            Err(TerminalError::NotFound(_))
        ));
        assert!(
            std::fs::read_dir(dir.path()).unwrap().next().is_none(),
            "a failed delete does not create the file"
        );
    }
}
