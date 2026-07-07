//! Desktop-side network diagnostics manager.
//!
//! Wraps the `termihub-core` network tools and exposes them via Tauri commands.
//! Manages running task lifetimes (port scans, ping sessions, traceroutes) and
//! the persistent HTTP monitors.

pub mod http_monitor;
pub mod http_monitor_storage;
pub mod wol_storage;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use tauri::AppHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error};
use uuid::Uuid;

use http_monitor::{HttpMonitorConfig, HttpMonitorHandle, HttpMonitorState};
use termihub_core::network::WolDevice;

use crate::utils::errors::TerminalError;

/// Central manager for all active network diagnostic tasks.
///
/// Registered as Tauri managed state alongside ConnectionManager, etc.
pub struct NetworkManager {
    /// Active scan / ping / traceroute tasks, keyed by task ID.
    active_tasks: Mutex<HashMap<String, CancellationToken>>,
    /// Running HTTP monitors.
    http_monitors: Mutex<HashMap<String, HttpMonitorHandle>>,
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
            wol_devices: Mutex::new(Vec::new()),
            config_dir: PathBuf::new(),
            app_handle: Arc::new(Mutex::new(None)),
        }
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

    /// Spawn the poll loop for a config and track its handle, **without**
    /// touching disk. Used both by [`start_http_monitor`](Self::start_http_monitor)
    /// (after persisting) and by [`init`](Self::init) when auto-starting the
    /// persisted monitors on launch.
    fn spawn_http_monitor(&self, config: HttpMonitorConfig) -> Result<String, TerminalError> {
        let app = self
            .app_handle()
            .ok_or_else(|| TerminalError::InternalError("app handle not available".into()))?;
        let id = config.id.clone();
        let handle = http_monitor::start_monitor(config, app);
        if let Ok(mut monitors) = self.http_monitors.lock() {
            monitors.insert(id.clone(), handle);
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
        let monitors = self
            .http_monitors
            .lock()
            .map_err(|_| TerminalError::InternalError("http monitor lock poisoned".into()))?;
        match monitors.get(monitor_id) {
            Some(handle) => {
                // Cancel the poll loop but leave the handle in the map so the
                // monitor stays listed as `running: false`. `paused` is cleared
                // so a later Resume starts clean.
                handle.cancel.cancel();
                handle.paused.store(false, Ordering::SeqCst);
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
            Some(handle) => {
                handle.cancel.cancel();
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
            Some(handle) => {
                handle.paused.store(true, Ordering::SeqCst);
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
        // Take the current handle so we can decide whether to un-pause in place
        // or re-spawn a stopped loop. Clone the config first; drop the lock
        // before re-spawning (spawn re-locks the map).
        let stopped_config = {
            let mut monitors = self
                .http_monitors
                .lock()
                .map_err(|_| TerminalError::InternalError("http monitor lock poisoned".into()))?;
            match monitors.get(monitor_id) {
                Some(handle) if !handle.cancel.is_cancelled() => {
                    // Alive (running or paused): clear the pause flag in place.
                    handle.paused.store(false, Ordering::SeqCst);
                    debug!(monitor_id, "Resumed paused HTTP monitor");
                    None
                }
                Some(_) => {
                    // Stopped: remove the dead handle and re-spawn below.
                    monitors.remove(monitor_id).map(|h| h.config)
                }
                None => return Err(TerminalError::NotFound(format!("monitor '{monitor_id}'"))),
            }
        };

        if let Some(config) = stopped_config {
            self.spawn_http_monitor(config)?;
            debug!(monitor_id, "Restarted stopped HTTP monitor");
        }
        Ok(())
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
        for (id, handle) in monitors.drain() {
            handle.cancel.cancel();
            debug!(monitor_id = %id, "Stopped HTTP monitor during teardown");
        }
    }

    /// List all HTTP monitors (running and stopped).
    pub fn list_http_monitors(&self) -> Vec<HttpMonitorState> {
        let Ok(monitors) = self.http_monitors.lock() else {
            return Vec::new();
        };
        monitors
            .values()
            .map(|h| {
                let last_result = h.last_result.lock().ok().and_then(|g| g.clone());
                let running = !h.cancel.is_cancelled();
                HttpMonitorState {
                    config: h.config.clone(),
                    running,
                    // A stopped loop can't be paused; only report paused while alive.
                    paused: running && h.paused.load(Ordering::SeqCst),
                    last_result,
                }
            })
            .collect()
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

#[cfg(test)]
mod tests {
    use super::*;
    use http_monitor::HttpCheckResult;

    use std::sync::atomic::AtomicBool;

    /// Insert a bare monitor handle (no spawned task) so `stop_all_http_monitors`
    /// can be exercised without a live Tauri `AppHandle`. Returns the id plus the
    /// handle's cancellation token and `paused` flag so tests can assert on them.
    fn insert_dummy_monitor(mgr: &NetworkManager) -> (String, CancellationToken, Arc<AtomicBool>) {
        let config = HttpMonitorConfig::new(
            "https://example.com".into(),
            30_000,
            "GET".into(),
            200,
            5_000,
        );
        insert_dummy_monitor_config(mgr, config)
    }

    /// Insert a dummy handle for a specific config (so persistence + map stay in
    /// sync in tests that also persist the config).
    fn insert_dummy_monitor_config(
        mgr: &NetworkManager,
        config: HttpMonitorConfig,
    ) -> (String, CancellationToken, Arc<AtomicBool>) {
        let id = config.id.clone();
        let cancel = CancellationToken::new();
        let paused = Arc::new(AtomicBool::new(false));
        let handle = HttpMonitorHandle {
            config,
            cancel: cancel.clone(),
            paused: Arc::clone(&paused),
            last_result: Arc::new(Mutex::new(None::<HttpCheckResult>)),
        };
        mgr.http_monitors
            .lock()
            .expect("http monitor lock")
            .insert(id.clone(), handle);
        (id, cancel, paused)
    }

    #[test]
    fn stop_all_http_monitors_cancels_and_clears() {
        let mgr = NetworkManager::new();
        let (_id1, token1, _p1) = insert_dummy_monitor(&mgr);
        let (_id2, token2, _p2) = insert_dummy_monitor(&mgr);

        assert_eq!(mgr.list_http_monitors().len(), 2);
        assert!(!token1.is_cancelled());
        assert!(!token2.is_cancelled());

        mgr.stop_all_http_monitors();

        // Every monitor's cancellation token is fired...
        assert!(token1.is_cancelled());
        assert!(token2.is_cancelled());
        // ...and the map is emptied so nothing lingers.
        assert!(mgr.list_http_monitors().is_empty());
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
        let (id, token, _paused) = insert_dummy_monitor_config(&mgr, cfg.clone());
        mgr.persist_monitor_config(cfg).expect("persist");

        mgr.stop_http_monitor(&id).expect("stop");

        // The poll loop is cancelled...
        assert!(token.is_cancelled());
        // ...but the monitor stays listed as not running...
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
        let (id, token, _paused) = insert_dummy_monitor_config(&mgr, cfg.clone());
        mgr.persist_monitor_config(cfg).expect("persist");

        mgr.remove_http_monitor(&id).expect("remove");

        assert!(token.is_cancelled());
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
        let (id, token, paused) = insert_dummy_monitor_config(&mgr, cfg.clone());
        mgr.persist_monitor_config(cfg).expect("persist");

        assert!(!paused.load(Ordering::SeqCst));

        mgr.pause_http_monitor(&id).expect("pause");

        // The poll body is suspended...
        assert!(paused.load(Ordering::SeqCst));
        // ...but the loop is not cancelled and the monitor is still listed as
        // running and paused, with its config kept.
        assert!(!token.is_cancelled());
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
        let (id, _token, paused) = insert_dummy_monitor_config(&mgr, cfg.clone());
        mgr.persist_monitor_config(cfg).expect("persist");

        mgr.pause_http_monitor(&id).expect("pause");
        assert!(paused.load(Ordering::SeqCst));

        mgr.resume_http_monitor(&id).expect("resume");

        assert!(!paused.load(Ordering::SeqCst));
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
