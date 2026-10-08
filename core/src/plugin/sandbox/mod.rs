//! Out-of-process native plugin hosting (#4182, plugin OS-sandbox phase 1).
//!
//! Instead of `dlopen`ing a native plugin into termiHub, the host can run it in
//! a dedicated `termihub-plugin-runner` sidecar process, one per enabled
//! plugin, and talk to it over a private framed IPC channel (protocol:
//! [`termihub_plugin_runner::ipc`]). The plugin library is unchanged and is
//! loaded by the runner through the very same loader and gates the in-process
//! host uses ([`termihub_plugin_runner::loader`]).
//!
//! * [`SandboxedPluginHandle`] — one enabled plugin: spawns the runner at load
//!   (so load-time refusals surface exactly as in process), respawns it lazily
//!   after an idle reap or a crash, and stops it with a bounded sequence
//!   (cancel → close every session → `Shutdown` → kill) on unload.
//! * [`SandboxedPlugin`] — one running runner: handshake, frame validation
//!   (the runner is an untrusted peer; any violation kills it), session
//!   multiplexing by host-assigned id.
//! * [`SandboxedSession`] — the out-of-process counterpart of
//!   `LoadedBackend` behind `PluginConnectionType`.
//!
//! * The capability bridge is served by the host over the channel
//!   ([`BridgeGrant`], phase 2, #4183): the runner forwards each bridge call,
//!   the host runs the same permission / scope / policy guards as in process,
//!   passes approved sockets to the runner (`SCM_RIGHTS`) or proxies them, and
//!   records every refusal as a [`BridgeDenial`].
//! * Crash isolation (#4184, phase 3): every runner exit gets a
//!   [`RunnerExitCause`]; a [`CrashBudget`] respawns after three crashes and
//!   auto-disables on the fourth; a watchdog detects hangs (ping/pong) and, on
//!   macOS, excess memory; the runner applies [`ResourceLimits`] before it
//!   loads the plugin (Windows: the host's job object enforces them).
//! * Transport: a `socketpair` end inherited as descriptor 3 on Unix; on
//!   Windows a private named pipe passed through a `CreateProcessW` handle
//!   list, the runner inside a kill-on-close job object (#4201). Sockets are
//!   not passed over the pipe yet (#4219): bridge connections are proxied.
//!
//! * OS confinement (#4186, phase 5a): the host derives a [`SandboxPolicy`]
//!   from the plugin's folders ([`sandbox_policy`]); the runner applies it to
//!   itself before `dlopen` (Seatbelt on macOS, landlock + seccomp on Linux,
//!   #4185) and answers with a
//!   [`SandboxReport`]. A failed setup, or a required layer that is missing,
//!   refuses the plugin ([`HostError::SandboxSetupFailed`](super::HostError)).
//!
//! * Status for the UI (#4188, phase 6): [`PluginSandboxStatus`] — the
//!   isolation badge, process state and recent bridge denials — and the
//!   `reducedIsolationAccepted` gate: reduced isolation loads only with the
//!   hash-bound acknowledgement.
//!
//! **Scope so far.** OS confinement on macOS and Linux (LPAC is #4187). The
//! out-of-process path is therefore
//! **opt-in** ([`PluginHost::with_runner`](super::PluginHost::with_runner)); the
//! desktop enables it only in debug builds via an environment flag
//! ([`debug_runner_config_from_env`]), so users see no change until the phase-7
//! cut-over. See `docs/concepts/backlog/plugin-os-sandbox.html`.

mod bridge;
mod client;
mod exit;
mod handle;
mod locate;
mod peer;
mod policy;
mod proxy;
mod session;
mod spawn;
mod status;
mod watchdog;
mod writer;

pub use bridge::{BridgeDenial, BridgeGrant, DenialReason};
pub use client::SandboxedPlugin;
pub use exit::{auto_disable_reason, CrashBudget, RunnerExitCause, DEFAULT_CRASH_WINDOW};
pub(crate) use handle::AutoDisableHook;
pub use handle::{PluginHealth, PluginRunnerConfig, SandboxedPluginHandle, DEFAULT_IDLE_TIMEOUT};
pub use locate::{default_runner_path, log_bundled_runner, RUNNER_BIN_NAME, RUNNER_MISSING};
pub use policy::sandbox_policy;
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

/// Environment flag that opts a **debug build** into out-of-process plugins.
pub const OUT_OF_PROCESS_ENV: &str = "TERMIHUB_PLUGIN_OUT_OF_PROCESS";

/// Environment override for the runner binary (debug builds, tests).
pub const RUNNER_PATH_ENV: &str = "TERMIHUB_PLUGIN_RUNNER";

/// The runner configuration a debug build opts into: `Some` when
/// [`OUT_OF_PROCESS_ENV`] is `1`, using [`RUNNER_PATH_ENV`] or else
/// [`default_runner_path`] (the bundled sidecar, or the cargo-built runner).
/// The desktop calls this only under `cfg(debug_assertions)`, so a release
/// build never reads the flag.
#[must_use]
pub fn debug_runner_config_from_env() -> Option<PluginRunnerConfig> {
    runner_config_from(
        std::env::var(OUT_OF_PROCESS_ENV).ok().as_deref(),
        std::env::var_os(RUNNER_PATH_ENV).map(std::path::PathBuf::from),
    )
}

fn runner_config_from(
    flag: Option<&str>,
    runner: Option<std::path::PathBuf>,
) -> Option<PluginRunnerConfig> {
    if flag != Some("1") {
        return None;
    }
    let path = runner.or_else(default_runner_path)?;
    Some(PluginRunnerConfig::new(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_debug_flag_must_be_exactly_one() {
        let runner = Some(std::path::PathBuf::from("/x/runner"));
        assert!(runner_config_from(None, runner.clone()).is_none());
        assert!(runner_config_from(Some("0"), runner.clone()).is_none());
        assert!(runner_config_from(Some("true"), runner.clone()).is_none());
        let config = runner_config_from(Some("1"), runner).expect("enabled");
        assert_eq!(config.runner_path, std::path::PathBuf::from("/x/runner"));
        assert_eq!(config.idle_timeout, DEFAULT_IDLE_TIMEOUT);
        // Without an override the sidecar next to the executable is used.
        assert_eq!(
            runner_config_from(Some("1"), None).map(|c| c.runner_path),
            default_runner_path()
        );
    }
}
