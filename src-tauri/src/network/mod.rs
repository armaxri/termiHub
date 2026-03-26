//! Desktop-side network diagnostics manager.
//!
//! Wraps the `termihub-core` network tools and exposes them via Tauri commands.
//! Manages running task lifetimes (port scans, ping sessions, traceroutes) and
//! the persistent HTTP monitors.

pub mod http_monitor;
pub mod wol_storage;

use std::collections::HashMap;
use std::path::PathBuf;
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

    /// Start a new HTTP monitor. Returns its ID.
    pub fn start_http_monitor(&self, config: HttpMonitorConfig) -> Result<String, TerminalError> {
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

    /// Stop a running HTTP monitor.
    pub fn stop_http_monitor(&self, monitor_id: &str) -> Result<(), TerminalError> {
        let mut monitors = self
            .http_monitors
            .lock()
            .map_err(|_| TerminalError::InternalError("http monitor lock poisoned".into()))?;
        match monitors.remove(monitor_id) {
            Some(handle) => {
                handle.cancel.cancel();
                Ok(())
            }
            None => Err(TerminalError::NotFound(format!("monitor '{monitor_id}'"))),
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
                HttpMonitorState {
                    config: h.config.clone(),
                    running: !h.cancel.is_cancelled(),
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
