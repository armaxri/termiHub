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
//!
//! **Crashes (#4184):** every runner exit the host did not ask for (crash,
//! hang, out of memory, invalid data) is charged to the plugin's
//! [`CrashBudget`]. While it lasts the runner is respawned at once, so new
//! sessions work (crashed sessions are not recreated: plugin types have no
//! resume protocol, PLG-004); the crash that exceeds it auto-disables the
//! plugin and reports the reason to the host, which persists it.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use termihub_plugin_api::PluginError;
use termihub_plugin_runner::ipc::{Cancel, Configure, Message, ResourceLimits, SandboxReport};
use termihub_plugin_runner::loader::LoadedPluginInfo;
use termihub_plugin_runner::sandbox::SandboxPolicy;

use crate::plugin::log_rate_limit::PluginLogLimiter;
use crate::plugin::security::{RecoveryAction, MAX_RESTART_ATTEMPTS};
use crate::plugin::HostError;

use super::client::SandboxedPlugin;
use super::exit::{auto_disable_reason, CrashBudget, RunnerExitCause, DEFAULT_CRASH_WINDOW};
use super::watchdog::WatchdogConfig;

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
    /// Resource limits every runner applies before loading its plugin
    /// (host-chosen, never from the manifest).
    pub limits: ResourceLimits,
    /// Hang detection and the resident-size poll.
    pub watchdog: WatchdogConfig,
    /// A plugin's crash budget resets after this long without a crash.
    pub crash_window: Duration,
    /// Confine each runner with the OS sandbox (#4186). On by default; tests
    /// that need an unconfined runner turn it off.
    pub os_sandbox: bool,
    /// Send this policy instead of the derived one (tests of the setup-failure
    /// path only).
    #[doc(hidden)]
    pub sandbox_policy_override: Option<SandboxPolicy>,
}

impl PluginRunnerConfig {
    /// Run plugins through `runner_path` with the concept's defaults: 5 min
    /// idle reap, 512 MiB / 256 descriptors / no child processes, ping every
    /// 5 s with a 10 s timeout, a 1 GiB resident-size poll on macOS, a
    /// 10-minute crash window, and the OS sandbox on.
    #[must_use]
    pub fn new(runner_path: impl Into<PathBuf>) -> Self {
        Self {
            runner_path: runner_path.into(),
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            limits: ResourceLimits::plugin_defaults(),
            watchdog: WatchdogConfig::default(),
            crash_window: DEFAULT_CRASH_WINDOW,
            os_sandbox: true,
            sandbox_policy_override: None,
        }
    }

    /// Send `policy` to the runner instead of the derived one, to exercise the
    /// sandbox setup-failure path in tests. Never used by the application.
    #[doc(hidden)]
    #[must_use]
    pub fn with_sandbox_policy_for_tests(mut self, policy: SandboxPolicy) -> Self {
        self.sandbox_policy_override = Some(policy);
        self
    }

    /// Run the plugin without the OS sandbox (tests of the unconfined path).
    #[must_use]
    pub fn without_os_sandbox(mut self) -> Self {
        self.os_sandbox = false;
        self
    }

    /// Override the idle timeout (tests use a short one).
    #[must_use]
    pub fn with_idle_timeout(mut self, idle_timeout: Duration) -> Self {
        self.idle_timeout = idle_timeout;
        self
    }

    /// Override the resource limits.
    #[must_use]
    pub fn with_limits(mut self, limits: ResourceLimits) -> Self {
        self.limits = limits;
        self
    }

    /// Override the watchdog (tests use short intervals).
    #[must_use]
    pub fn with_watchdog(mut self, watchdog: WatchdogConfig) -> Self {
        self.watchdog = watchdog;
        self
    }
}

/// A sandboxed plugin's health, for the plugin list's status (UI phase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHealth {
    /// Whether a runner is running now.
    pub running: bool,
    /// Crashes counted in the current window ("Restarting (n/3)").
    pub crashes: u32,
    /// Crashes that are restarted before the plugin is auto-disabled.
    pub max_restarts: u32,
    /// How the last runner ended, if one did.
    pub last_exit: Option<RunnerExitCause>,
    /// Why the plugin was auto-disabled ("Disabled after 3 crashes").
    pub auto_disabled: Option<String>,
}

/// Called once with the reason when the plugin is auto-disabled.
pub(crate) type AutoDisableHook = Box<dyn Fn(&str) + Send + Sync>;

/// An enabled plugin served by a (re)spawnable runner.
pub struct SandboxedPluginHandle {
    config: PluginRunnerConfig,
    configure: Configure,
    info: LoadedPluginInfo,
    data_dir: Mutex<String>,
    log_limiter: Arc<PluginLogLimiter>,
    current: Mutex<Option<Arc<SandboxedPlugin>>>,
    stopped: AtomicBool,
    /// This handle, for the exit hooks it installs on each runner.
    weak: Weak<Self>,
    budget: Mutex<CrashBudget>,
    last_exit: Mutex<Option<RunnerExitCause>>,
    auto_disabled: Mutex<Option<String>>,
    on_auto_disable: Mutex<Option<AutoDisableHook>>,
    /// The sandbox report of the latest runner (#4188).
    report: Mutex<SandboxReport>,
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
        let first = SandboxedPlugin::spawn(&config, &configure, Arc::clone(&log_limiter))?;
        let budget = Mutex::new(CrashBudget::new(config.crash_window));
        let report = Mutex::new(first.sandbox_report().clone());
        let handle = Arc::new_cyclic(|weak| Self {
            report,
            info: first.info().clone(),
            config,
            configure,
            data_dir: Mutex::new(String::new()),
            log_limiter,
            current: Mutex::new(None),
            stopped: AtomicBool::new(false),
            weak: weak.clone(),
            budget,
            last_exit: Mutex::new(None),
            auto_disabled: Mutex::new(None),
            on_auto_disable: Mutex::new(None),
        });
        handle.watch(&first);
        *handle.current.lock().unwrap_or_else(|e| e.into_inner()) = Some(first);
        spawn_idle_reaper(Arc::downgrade(&handle), handle.config.idle_timeout);
        Ok(handle)
    }

    /// Have `plugin` report its exit to this handle.
    fn watch(&self, plugin: &SandboxedPlugin) {
        let handle = self.weak.clone();
        plugin.set_exit_hook(Box::new(move |cause| {
            if let Some(handle) = handle.upgrade() {
                handle.runner_exited(cause);
            }
        }));
    }

    /// A runner ended: charge a failure to the budget, then respawn or
    /// auto-disable. Runs on whichever thread reaped the runner, possibly
    /// under `current`'s lock, so the follow-up work runs on its own thread.
    fn runner_exited(&self, cause: &RunnerExitCause) {
        *self.last_exit.lock().unwrap_or_else(|e| e.into_inner()) = Some(cause.clone());
        if !cause.is_failure() || self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let action = self
            .budget
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .record_crash(Instant::now());
        let handle = self.weak.clone();
        let follow_up: Box<dyn FnOnce(&Self) + Send> = match action {
            RecoveryAction::Restart => Box::new(|handle: &Self| {
                // Respawn now so the next session finds a running plugin.
                if let Err(e) = handle.acquire() {
                    tracing::warn!(
                        target: crate::plugin::PLUGIN_LOG_TARGET,
                        "[{}] restarting the plugin after a crash failed: {e}",
                        handle.info.id
                    );
                }
            }),
            RecoveryAction::Disable => {
                let reason = auto_disable_reason();
                *self.auto_disabled.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(reason.clone());
                self.stopped.store(true, Ordering::SeqCst);
                tracing::warn!(
                    target: crate::plugin::PLUGIN_LOG_TARGET,
                    "[{}] {reason}: the plugin is disabled until it is re-enabled",
                    self.info.id
                );
                Box::new(move |handle: &Self| {
                    handle.stop();
                    if let Some(hook) = handle
                        .on_auto_disable
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .as_ref()
                    {
                        hook(&reason);
                    }
                })
            }
        };
        let _ = std::thread::Builder::new()
            .name("plugin-runner-recovery".to_owned())
            .spawn(move || {
                if let Some(handle) = handle.upgrade() {
                    follow_up(&handle);
                }
            });
    }

    /// Set what happens when the crash budget is spent (the host unregisters
    /// the plugin's type and persists the reason). Runs at most once.
    pub(crate) fn on_auto_disable(&self, hook: AutoDisableHook) {
        *self
            .on_auto_disable
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(hook);
    }

    /// Why the plugin was auto-disabled, if it was.
    #[must_use]
    pub fn auto_disabled(&self) -> Option<String> {
        self.auto_disabled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The plugin's health: running, crash count, last exit, auto-disable.
    #[must_use]
    pub fn health(&self) -> PluginHealth {
        PluginHealth {
            running: self.running().is_some(),
            crashes: self
                .budget
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .crashes(),
            max_restarts: MAX_RESTART_ATTEMPTS,
            last_exit: self
                .last_exit
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            auto_disabled: self.auto_disabled(),
        }
    }

    /// What OS confinement the latest runner reported (#4186), kept across an
    /// idle reap so the Settings row still shows it.
    #[must_use]
    pub fn sandbox_report(&self) -> SandboxReport {
        self.report
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
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
        if let Some(reason) = self.auto_disabled() {
            return Err(PluginError::Other(reason));
        }
        if self.stopped.load(Ordering::SeqCst) {
            return Err(PluginError::NotAlive);
        }
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        // Re-checked under the lock: `stop` takes it after setting the flag,
        // so a respawn racing a stop never leaves a runner behind.
        if self.stopped.load(Ordering::SeqCst) {
            return Err(PluginError::NotAlive);
        }
        if let Some(plugin) = current.as_ref().filter(|p| p.is_alive()) {
            return Ok(Arc::clone(plugin));
        }
        let plugin =
            SandboxedPlugin::spawn(&self.config, &self.configure, Arc::clone(&self.log_limiter))
                .map_err(|e| {
                    PluginError::Other(format!("restarting the plugin runner failed: {e}"))
                })?;
        // The library is re-verified on every spawn; it must still be the same
        // plugin at the same ABI the host registered.
        if plugin.info().id != self.info.id || plugin.info().abi_version != self.info.abi_version {
            plugin.shutdown();
            return Err(PluginError::Other(
                "the plugin library changed since it was loaded".to_owned(),
            ));
        }
        self.watch(&plugin);
        *self.report.lock().unwrap_or_else(|e| e.into_inner()) = plugin.sandbox_report().clone();
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
