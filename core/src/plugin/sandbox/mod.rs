//! Out-of-process, OS-sandboxed native plugin hosting (#4182, ADR-19).
//!
//! termiHub never `dlopen`s a native plugin into itself. The host runs every
//! native plugin in a dedicated `termihub-plugin-runner` sidecar process, one
//! per enabled plugin, and talks to it over a private framed IPC channel
//! (protocol: [`termihub_plugin_runner::ipc`]). The plugin library is
//! unchanged and is loaded by the runner, after it confined itself, through the
//! shared loader and its gates ([`termihub_plugin_runner::loader`]).
//!
//! * [`SandboxedPluginHandle`] — one enabled plugin: spawns the runner at load
//!   (so load-time refusals surface from `PluginHost::load`), respawns it lazily
//!   after an idle reap or a crash, and stops it with a bounded sequence
//!   (cancel → close every session → `Shutdown` → kill) on unload.
//! * [`SandboxedPlugin`] — one running runner: handshake, frame validation
//!   (the runner is an untrusted peer; any violation kills it, and so does
//!   output beyond its [`OutputRateCap`], #4203), session multiplexing by
//!   host-assigned id.
//! * [`SandboxedSession`] — the out-of-process counterpart of
//!   `LoadedBackend` behind `PluginConnectionType`.
//!
//! * The capability bridge is served by the host over the channel
//!   ([`BridgeGrant`], phase 2, #4183): the runner forwards each bridge call,
//!   the host runs the permission / scope / policy guards,
//!   passes approved sockets to the runner (`SCM_RIGHTS`) or proxies them, and
//!   records every refusal as a [`BridgeDenial`].
//! * Crash isolation (#4184, phase 3): every runner exit gets a
//!   [`RunnerExitCause`]; a [`CrashBudget`] respawns after three crashes and
//!   auto-disables on the fourth; a watchdog detects hangs (ping/pong) and, on
//!   macOS, excess memory; the runner applies [`ResourceLimits`] before it
//!   loads the plugin (Windows: the host's job object enforces them).
//! * Transport: a `socketpair` end inherited as descriptor 3 on Unix; on
//!   Windows a private named pipe passed through a `CreateProcessW` handle
//!   list, the runner inside a kill-on-close job object (#4201). Approved
//!   bridge sockets are duplicated into the runner (`DuplicateHandle`, #4219).
//!
//! * OS confinement (#4186, phase 5a): the host derives a [`SandboxPolicy`]
//!   from the plugin's folders ([`sandbox_policy`]); the runner applies it to
//!   itself before `dlopen` (Seatbelt on macOS, landlock + seccomp on Linux,
//!   #4185) and answers with a
//!   [`SandboxReport`]. On Windows (#4187) the host starts the runner in the
//!   plugin's Less-Privileged AppContainer with zero capabilities, inside its
//!   job object, and the runner verifies that before `dlopen`. A failed
//!   setup, or a required layer that is missing, refuses the plugin
//!   ([`HostError::SandboxSetupFailed`](super::HostError)).
//!
//! * Status for the UI (#4188, phase 6): [`PluginSandboxStatus`] — the
//!   isolation badge, process state and recent bridge denials — and the
//!   `reducedIsolationAccepted` gate: reduced isolation loads only with the
//!   hash-bound acknowledgement.
//!
//! **The only model.** Since the phase-7 cut-over (#4189) this is the one way
//! native plugins run: there is no in-process load path and no user switch to
//! run a plugin unsandboxed. A debug build may point the host at a different
//! runner binary ([`debug_runner_config_from_env`]). See ADR-19 and
//! `docs/concepts/implemented/plugin-os-sandbox.html`.

#[cfg(windows)]
mod appcontainer;
mod bridge;
mod client;
mod exit;
mod handle;
mod locate;
mod peer;
mod policy;
mod proxy;
mod rate;
mod session;
mod spawn;
mod status;
mod watchdog;
mod writer;

#[cfg(windows)]
pub(crate) use appcontainer::remove_profile as remove_app_container_profile;
pub use bridge::{BridgeDenial, BridgeGrant, DenialReason};
pub use client::SandboxedPlugin;
pub use exit::{auto_disable_reason, CrashBudget, RunnerExitCause, DEFAULT_CRASH_WINDOW};
pub(crate) use handle::AutoDisableHook;
pub use handle::{PluginHealth, PluginRunnerConfig, SandboxedPluginHandle, DEFAULT_IDLE_TIMEOUT};
pub use locate::{default_runner_path, log_bundled_runner, RUNNER_BIN_NAME, RUNNER_MISSING};
pub use policy::sandbox_policy;
pub use rate::OutputRateCap;
pub use session::SandboxedSession;
pub(crate) use status::SandboxOutcome;
pub use status::{
    DenialInfo, IsolationStatus, PluginExitInfo, PluginSandboxStatus, ProcessState, ProcessStatus,
    STATUS_DENIALS,
};
pub use termihub_plugin_runner::ipc::{ResourceLimits, SandboxReport};
pub use termihub_plugin_runner::sandbox::{layer, Isolation, SandboxPolicy};
pub use watchdog::{
    WatchdogConfig, DEFAULT_HANG_TIMEOUT, DEFAULT_PING_INTERVAL, DEFAULT_RSS_LIMIT,
    DEFAULT_RSS_POLL_INTERVAL,
};

/// Environment override for the runner binary (debug builds, tests).
pub const RUNNER_PATH_ENV: &str = "TERMIHUB_PLUGIN_RUNNER";

/// The runner configuration a debug build overrides the default with: `Some`
/// when [`RUNNER_PATH_ENV`] names a runner binary. It only changes *which*
/// runner runs the plugins — every native plugin runs in one either way. The
/// desktop calls this only under `cfg(debug_assertions)`, so a release build
/// always uses the bundled, digest-checked runner.
#[must_use]
pub fn debug_runner_config_from_env() -> Option<PluginRunnerConfig> {
    runner_config_from(std::env::var_os(RUNNER_PATH_ENV).map(std::path::PathBuf::from))
}

fn runner_config_from(runner: Option<std::path::PathBuf>) -> Option<PluginRunnerConfig> {
    runner
        .filter(|path| !path.as_os_str().is_empty())
        .map(PluginRunnerConfig::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_debug_override_names_a_runner_or_nothing() {
        assert!(runner_config_from(None).is_none());
        assert!(runner_config_from(Some(std::path::PathBuf::new())).is_none());
        let config =
            runner_config_from(Some(std::path::PathBuf::from("/x/runner"))).expect("override");
        assert_eq!(config.runner_path, std::path::PathBuf::from("/x/runner"));
        assert_eq!(config.idle_timeout, DEFAULT_IDLE_TIMEOUT);
        assert!(config.os_sandbox, "an override never turns the sandbox off");
    }
}
