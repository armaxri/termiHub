//! [`SandboxedPluginHandle`]: one enabled native plugin served out of process,
//! across runner restarts (#4182).
//!
//! The handle owns the *recipe* for a runner (binary, `Configure`) and at most
//! one running [`SandboxedPlugin`]. Sessions [`acquire`](SandboxedPluginHandle::acquire)
//! it, which respawns the runner lazily when it is not running — after an idle
//! reap or after it died. Each respawn re-runs the whole load sequence in the
//! runner, so the library digest is re-verified every time.
//!
//! **Idle reap:** once the runner has had no session for
//! [`PluginRunnerConfig::idle_timeout`] (5 minutes by default) it is shut down;
//! a background thread holding only a weak reference checks for that.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use termihub_plugin_api::PluginError;
use termihub_plugin_runner::ipc::{Cancel, Configure, Message};
use termihub_plugin_runner::loader::LoadedPluginInfo;

use crate::plugin::log_rate_limit::PluginLogLimiter;
use crate::plugin::HostError;

use super::client::SandboxedPlugin;

/// Default idle time after which a session-free runner is shut down.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Longest pause between two idle checks.
const MAX_IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// How the host runs native plugins out of process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginRunnerConfig {
    /// The `termihub-plugin-runner` binary.
    pub runner_path: PathBuf,
    /// How long a runner may sit without sessions before it is shut down.
    pub idle_timeout: Duration,
}

impl PluginRunnerConfig {
    /// Run plugins through `runner_path`, with the default idle timeout.
    #[must_use]
    pub fn new(runner_path: impl Into<PathBuf>) -> Self {
        Self {
            runner_path: runner_path.into(),
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
        }
    }

    /// Override the idle timeout (tests use a short one).
    #[must_use]
    pub fn with_idle_timeout(mut self, idle_timeout: Duration) -> Self {
        self.idle_timeout = idle_timeout;
        self
    }
}

/// An enabled plugin served by a (re)spawnable runner.
pub struct SandboxedPluginHandle {
    config: PluginRunnerConfig,
    configure: Configure,
    info: LoadedPluginInfo,
    data_dir: Mutex<String>,
    log_limiter: Arc<PluginLogLimiter>,
    current: Mutex<Option<Arc<SandboxedPlugin>>>,
    stopped: AtomicBool,
}

impl std::fmt::Debug for SandboxedPluginHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SandboxedPluginHandle")
            .field("info", &self.info)
            .field("running", &self.running().is_some())
            .finish_non_exhaustive()
    }
}

impl SandboxedPluginHandle {
    /// Spawn the first runner (the load-time gates run now, so an incompatible
    /// or broken plugin fails `PluginHost::load` exactly as in process) and
    /// start the idle reaper.
    pub(crate) fn start(
        config: PluginRunnerConfig,
        configure: Configure,
        log_limiter: Arc<PluginLogLimiter>,
    ) -> Result<Arc<Self>, HostError> {
        let first =
            SandboxedPlugin::spawn(&config.runner_path, &configure, Arc::clone(&log_limiter))?;
        let handle = Arc::new(Self {
            info: first.info().clone(),
            config,
            configure,
            data_dir: Mutex::new(String::new()),
            log_limiter,
            current: Mutex::new(Some(first)),
            stopped: AtomicBool::new(false),
        });
        spawn_idle_reaper(Arc::downgrade(&handle), handle.config.idle_timeout);
        Ok(handle)
    }

    /// Metadata the plugin reported at its first load.
    #[must_use]
    pub fn info(&self) -> &LoadedPluginInfo {
        &self.info
    }

    /// Set the ABI 1.1 data directory handed to every new session.
    pub(crate) fn set_data_dir(&self, data_dir: String) {
        *self.data_dir.lock().unwrap_or_else(|e| e.into_inner()) = data_dir;
    }

    /// The data directory handed to new sessions (empty for none).
    pub(crate) fn data_dir(&self) -> String {
        self.data_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The running runner, respawning it if it was reaped or died. Refused once
    /// the plugin was stopped (unloaded).
    pub(crate) fn acquire(&self) -> Result<Arc<SandboxedPlugin>, PluginError> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err(PluginError::NotAlive);
        }
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(plugin) = current.as_ref().filter(|p| p.is_alive()) {
            return Ok(Arc::clone(plugin));
        }
        let plugin = SandboxedPlugin::spawn(
            &self.config.runner_path,
            &self.configure,
            Arc::clone(&self.log_limiter),
        )
        .map_err(|e| PluginError::Other(format!("restarting the plugin runner failed: {e}")))?;
        // The library is re-verified on every spawn; it must still be the same
        // plugin at the same ABI the host registered.
        if plugin.info().id != self.info.id || plugin.info().abi_version != self.info.abi_version {
            plugin.shutdown();
            return Err(PluginError::Other(
                "the plugin library changed since it was loaded".to_owned(),
            ));
        }
        *current = Some(Arc::clone(&plugin));
        Ok(plugin)
    }

    /// The running runner, if any (no respawn).
    #[must_use]
    pub fn running(&self) -> Option<Arc<SandboxedPlugin>> {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|p| p.is_alive())
            .cloned()
    }

    /// Set the plugin-wide cancellation flag in the running runner.
    pub fn signal_shutdown(&self) {
        if let Some(plugin) = self.running() {
            let _ = plugin.send(&Message::Cancel(Cancel { session_id: None }));
        }
    }

    /// Stop for good (disable / revoke / uninstall / quit): bounded close of
    /// every session, `Shutdown`, kill. Later `acquire`s fail.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let plugin = self
            .current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(plugin) = plugin {
            plugin.shutdown();
        }
    }

    /// Shut the runner down if it has been session-free for the idle timeout.
    /// Returns whether it did.
    fn reap_if_idle(&self) -> bool {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        let idle = current.as_ref().is_some_and(|p| {
            !p.is_alive()
                || (p.session_count() == 0
                    && p.idle_since()
                        .is_some_and(|since| since.elapsed() >= self.config.idle_timeout))
        });
        if !idle {
            return false;
        }
        let plugin = current.take();
        drop(current);
        if let Some(plugin) = plugin {
            plugin.shutdown();
        }
        true
    }
}

impl Drop for SandboxedPluginHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

fn spawn_idle_reaper(handle: Weak<SandboxedPluginHandle>, idle_timeout: Duration) {
    let interval = (idle_timeout / 4).clamp(Duration::from_millis(10), MAX_IDLE_CHECK_INTERVAL);
    let _ = std::thread::Builder::new()
        .name("plugin-runner-idle-reaper".to_owned())
        .spawn(move || loop {
            std::thread::sleep(interval);
            let Some(handle) = handle.upgrade() else {
                return;
            };
            if handle.stopped.load(Ordering::SeqCst) {
                return;
            }
            handle.reap_if_idle();
        });
}
