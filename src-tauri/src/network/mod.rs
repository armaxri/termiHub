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

use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error};
use uuid::Uuid;

use http_monitor::{HttpMonitorConfig, HttpMonitorService, HttpMonitorState};
use termihub_core::network::WolDevice;
use termihub_core::service::{Service, ServiceInfo, ServiceRegistry};

use crate::run_location::{ResolvedLocation, RunLocation, RunLocationResolver};
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

/// Tauri event forwarded to the frontend for each HTTP monitor check.
///
/// The [`HttpMonitorService`] itself emits on the core
/// [`EventChannel`](termihub_core::service::EventChannel); the desktop host
/// bridges that channel to this Tauri event so the frontend contract is
/// unchanged (see [`NetworkManager::spawn_http_monitor`]).
const HTTP_MONITOR_CHECK_EVENT: &str = "network-http-monitor-check";

/// Central manager for all active network diagnostic tasks.
///
/// Registered as Tauri managed state alongside ConnectionManager, etc.
pub struct NetworkManager {
    /// Active scan / ping / traceroute tasks, keyed by task ID.
    active_tasks: Mutex<HashMap<String, CancellationToken>>,
    /// Running HTTP monitors, each an [`HttpMonitorService`] behind the core
    /// [`Service`](termihub_core::service::Service) trait (#2157).
    http_monitors: Mutex<HashMap<String, HttpMonitorService>>,
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

    /// Start a new HTTP monitor and persist its config. Returns its ID.
    ///
    /// The config is written to disk (see [`http_monitor_storage`]) so the
    /// monitor is auto-restarted on the next launch. Runtime state (last
    /// result, running flag) is never persisted.
    pub fn start_http_monitor(&self, config: HttpMonitorConfig) -> Result<String, TerminalError> {
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
    /// (S1 default: always local). The service emits check results on its core
    /// [`EventChannel`](termihub_core::service::EventChannel); a bridge task
    /// forwards them to the [`HTTP_MONITOR_CHECK_EVENT`] Tauri event so the
    /// frontend contract is unchanged.
    fn spawn_http_monitor(&self, config: HttpMonitorConfig) -> Result<String, TerminalError> {
        // The HTTP monitor is desktop-only (Open Design Decision #4): the agent
        // has no HTTP-monitor method, so the resolver refuses an agent location
        // for it and it always runs locally (#2190).
        match self.resolve_tool_location(agent_tools::tool::HTTP_MONITOR)? {
            ResolvedLocation::Local => {}
            ResolvedLocation::Agent(agent) => {
                return Err(TerminalError::InternalError(format!(
                    "HTTP monitors are desktop-only and cannot run on an agent (requested '{agent}')"
                )));
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

    /// Stop a running HTTP monitor, keeping it **listed** (as `running: false`).
    ///
    /// Audit Gap #6: Stop must suspend polling without destroying the monitor —
    /// its handle stays in the map (with a cancelled token, so it lists as not
    /// running) and its persisted config is kept, so [`resume_http_monitor`]
    /// (or the next launch) can bring it back. Use [`remove_http_monitor`] to
    /// truly delete it.
    pub fn stop_http_monitor(&self, monitor_id: &str) -> Result<(), TerminalError> {
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
        let Ok(mut monitors) = self.http_monitors.lock() else {
            error!("http monitor lock poisoned during stop_all");
            return;
        };
        for (id, mut service) in monitors.drain() {
            service.shutdown();
            debug!(monitor_id = %id, "Stopped HTTP monitor during teardown");
        }
    }

    /// List all HTTP monitors (running and stopped).
    pub fn list_http_monitors(&self) -> Vec<HttpMonitorState> {
        let Ok(monitors) = self.http_monitors.lock() else {
            return Vec::new();
        };
        monitors.values().filter_map(|s| s.state()).collect()
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
/// The HTTP monitor is the S2 pilot (#2157) — the first existing service lifted
/// onto the core [`Service`](termihub_core::service::Service) trait.
fn build_service_registry() -> ServiceRegistry {
    let mut registry = ServiceRegistry::new();
    registry.register(
        http_monitor::SERVICE_ID,
        http_monitor::DISPLAY_NAME,
        "activity",
        Box::new(|| Box::new(HttpMonitorService::new())),
    );
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
