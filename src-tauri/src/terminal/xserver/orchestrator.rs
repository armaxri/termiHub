//! The cross-platform `ensure_x_server()` orchestrator (#1052).
//!
//! A single entry point the SSH connect flow calls when `enable_x11_forwarding`
//! is set: *ensure a usable local X server, per platform*, or return a typed,
//! actionable error. The per-platform *internals* (VcXsrv acquisition #1048,
//! lifecycle #1049, auth #1050; XQuartz install #1054; Linux gap classification
//! #1055) are their own issues — this module owns the **dispatch** and the
//! adopt-existing / typed-error decision.

use termihub_core::backends::ssh::x11::detect_local_x_server;

use super::manager::XServerManager;
use super::types::{XServerError, XServerPlatform, XServerState, XServerStatus};

/// Inputs to the pure platform-dispatch decision, decoupled from any real
/// system probing so the dispatch logic is unit-testable on every platform.
#[derive(Debug, Clone)]
pub struct EnsureContext {
    /// Host platform.
    pub platform: XServerPlatform,
    /// Whether automatic provisioning is enabled (resolved from settings).
    pub provide_automatically: bool,
    /// Display number of a reachable server, if one was detected.
    pub existing_display: Option<u32>,
    /// Whether the detected server is termiHub-managed (vs. adopted external).
    pub managed: bool,
    /// Whether the platform's X dependency is installed.
    pub dependency_available: bool,
    /// Active X11 session count (for the returned status).
    pub session_count: u32,
}

/// Pure per-platform decision: given the situation, either report a usable
/// server ([`Ok`]) or a typed, actionable failure ([`Err`]).
///
/// This is the heart of the orchestrator and is deliberately side-effect-free so
/// the "dispatches to the correct platform path; failures → typed errors"
/// acceptance criterion can be verified without a real X server on any CI host.
pub fn classify(ctx: &EnsureContext) -> Result<XServerStatus, XServerError> {
    // A reachable server (managed or external) is always adopted — this is the
    // common, cross-platform happy path and must never regress existing X11.
    if let Some(display) = ctx.existing_display {
        let message = if ctx.managed {
            format!("termiHub-managed X server on display :{display}")
        } else {
            format!("Adopted an existing X server on display :{display}")
        };
        return Ok(adopted_status(
            ctx.platform,
            display,
            ctx.managed,
            ctx.session_count,
            Some(ctx.dependency_available),
            Some(message),
        ));
    }

    // No server reachable — dispatch to the platform-specific guidance. The
    // Windows `provide_automatically` branch is the seam for #1048–#1050:
    // automatic VcXsrv provisioning is not yet implemented, so it surfaces an
    // actionable error rather than a silent no-op.
    match ctx.platform {
        XServerPlatform::Windows if ctx.provide_automatically => {
            Err(XServerError::windows_provisioning_unavailable())
        }
        XServerPlatform::Windows => Err(XServerError::windows_no_local_server()),
        XServerPlatform::MacOs if ctx.dependency_available => {
            Err(XServerError::macos_server_unreachable())
        }
        XServerPlatform::MacOs => Err(XServerError::xquartz_missing()),
        XServerPlatform::Linux if ctx.dependency_available => {
            Err(XServerError::linux_server_unreachable())
        }
        XServerPlatform::Linux => Err(XServerError::linux_x_missing()),
    }
}

/// Build the [`XServerStatus`] for a reachable server. Shared by [`classify`]
/// (adopt branch) and [`current_status`] so the "detected server" shape has a
/// single source.
fn adopted_status(
    platform: XServerPlatform,
    display: u32,
    managed: bool,
    session_count: u32,
    dependency_available: Option<bool>,
    message: Option<String>,
) -> XServerStatus {
    XServerStatus {
        state: if managed {
            XServerState::Running
        } else {
            XServerState::Adopted
        },
        platform,
        display_number: Some(display),
        managed,
        session_count,
        dependency_available,
        message,
    }
}

/// Ensure a usable local X server for the current platform.
///
/// Performs real detection (consulting the manager first, then the platform
/// fallbacks in [`detect_local_x_server`]), best-effort launches XQuartz on
/// macOS when it is installed but idle, then applies the pure [`classify`]
/// decision. Returns a coherent status or a typed, actionable error.
pub fn ensure_x_server(
    manager: &XServerManager,
    provide_automatically: bool,
) -> Result<XServerStatus, XServerError> {
    let platform = XServerPlatform::current();
    let dependency_available = dependency_available(platform);

    // Detect once. On macOS, if XQuartz is installed but not yet running, nudge
    // it up and re-probe a single time so the SSH `DISPLAY` handshake can
    // succeed.
    #[cfg(target_os = "macos")]
    let detected = {
        let mut found = detect(manager);
        if found.is_none() && !manager.has_managed_server() && dependency_available {
            macos::launch_xquartz();
            found = detect(manager);
        }
        found
    };
    #[cfg(not(target_os = "macos"))]
    let detected = detect(manager);

    let (existing_display, managed) = detected.map_or((None, false), |(d, m)| (Some(d), m));

    let ctx = EnsureContext {
        platform,
        provide_automatically,
        existing_display,
        managed,
        dependency_available,
        session_count: manager.session_count(),
    };
    classify(&ctx)
}

/// Report the current X server status without any side effects (no launching,
/// no provisioning). Backs the `x_server_status` command.
pub fn current_status(manager: &XServerManager) -> XServerStatus {
    let platform = XServerPlatform::current();
    let dependency_available = Some(dependency_available(platform));
    match detect(manager) {
        Some((display, managed)) => adopted_status(
            platform,
            display,
            managed,
            manager.session_count(),
            dependency_available,
            None,
        ),
        None => XServerStatus {
            state: XServerState::Absent,
            platform,
            display_number: None,
            managed: false,
            session_count: manager.session_count(),
            dependency_available,
            message: Some("No local X server detected.".to_string()),
        },
    }
}

/// Detect a reachable local server, returning `(display_number, managed)`.
///
/// A termiHub-managed server (recorded in the manager) wins; otherwise the core
/// platform detection (DISPLAY / Unix sockets / Windows TCP probe) is used.
fn detect(manager: &XServerManager) -> Option<(u32, bool)> {
    use termihub_core::backends::ssh::x11::ManagedXServerSource;
    if let Some(server) = manager.managed_server() {
        return Some((server.display_number, true));
    }
    // Pass `None`: the managed case is handled above, so this probes only for a
    // user-run server.
    detect_local_x_server(None).map(|info| (info.display_number, false))
}

/// Whether the platform's X dependency is installed.
///
/// - macOS: XQuartz at `/opt/X11` or `/Applications/Utilities/XQuartz.app`.
/// - Linux: the X socket dir or an `Xorg`/`Xwayland` binary on `PATH`.
/// - Windows: currently `false` — a user-installed VcXsrv is discovered via the
///   running-server TCP probe, and managed acquisition is #1048.
fn dependency_available(platform: XServerPlatform) -> bool {
    match platform {
        XServerPlatform::MacOs => {
            std::path::Path::new("/opt/X11").exists()
                || std::path::Path::new("/Applications/Utilities/XQuartz.app").exists()
        }
        XServerPlatform::Linux => {
            std::path::Path::new("/tmp/.X11-unix").is_dir()
                || binary_on_path("Xwayland")
                || binary_on_path("Xorg")
        }
        XServerPlatform::Windows => false,
    }
}

/// Whether `name` resolves to an executable on `PATH` (best-effort).
#[cfg(not(target_os = "windows"))]
fn binary_on_path(name: &str) -> bool {
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(name).exists())
}

#[cfg(target_os = "windows")]
fn binary_on_path(_name: &str) -> bool {
    false
}

#[cfg(target_os = "macos")]
mod macos {
    /// Best-effort launch of XQuartz. Errors are ignored — detection afterwards
    /// decides whether a server actually came up.
    pub(super) fn launch_xquartz() {
        let _ = std::process::Command::new("open")
            .args(["-a", "XQuartz"])
            .spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(platform: XServerPlatform) -> EnsureContext {
        EnsureContext {
            platform,
            provide_automatically: false,
            existing_display: None,
            managed: false,
            dependency_available: false,
            session_count: 0,
        }
    }

    #[test]
    fn adopts_existing_external_server_on_any_platform() {
        for platform in [
            XServerPlatform::Windows,
            XServerPlatform::MacOs,
            XServerPlatform::Linux,
        ] {
            let mut c = ctx(platform);
            c.existing_display = Some(0);
            let status = classify(&c).expect("existing server is adopted");
            assert_eq!(status.state, XServerState::Adopted);
            assert_eq!(status.display_number, Some(0));
            assert!(!status.managed);
        }
    }

    #[test]
    fn managed_existing_server_reports_running() {
        let mut c = ctx(XServerPlatform::Windows);
        c.existing_display = Some(0);
        c.managed = true;
        let status = classify(&c).expect("managed server is running");
        assert_eq!(status.state, XServerState::Running);
        assert!(status.managed);
    }

    #[test]
    fn windows_with_auto_provisioning_returns_provisioning_unavailable() {
        let mut c = ctx(XServerPlatform::Windows);
        c.provide_automatically = true;
        let err = classify(&c).expect_err("no server, auto on → typed error");
        assert!(matches!(err, XServerError::ProvisioningUnavailable { .. }));
    }

    #[test]
    fn windows_without_auto_provisioning_returns_no_local_server() {
        let c = ctx(XServerPlatform::Windows); // provide_automatically = false
        let err = classify(&c).expect_err("no server, auto off → typed error");
        assert!(matches!(err, XServerError::NoLocalServer { .. }));
    }

    #[test]
    fn macos_without_xquartz_returns_dependency_missing() {
        let c = ctx(XServerPlatform::MacOs); // dependency_available = false
        let err = classify(&c).expect_err("no XQuartz → typed error");
        match err {
            XServerError::DependencyMissing {
                dependency,
                install_command,
                ..
            } => {
                assert_eq!(dependency, "XQuartz");
                assert_eq!(
                    install_command.as_deref(),
                    Some("brew install --cask xquartz")
                );
            }
            other => panic!("expected DependencyMissing, got {other:?}"),
        }
    }

    #[test]
    fn macos_with_xquartz_but_no_server_returns_unreachable() {
        let mut c = ctx(XServerPlatform::MacOs);
        c.dependency_available = true;
        let err = classify(&c).expect_err("XQuartz present, idle → typed error");
        assert!(matches!(err, XServerError::ServerUnreachable { .. }));
    }

    #[test]
    fn linux_without_x_server_returns_dependency_missing() {
        let c = ctx(XServerPlatform::Linux); // dependency_available = false
        let err = classify(&c).expect_err("no Xorg → typed error");
        match err {
            XServerError::DependencyMissing { dependency, .. } => {
                assert_eq!(dependency, "Xorg/XWayland");
            }
            other => panic!("expected DependencyMissing, got {other:?}"),
        }
    }

    #[test]
    fn linux_with_dependency_but_no_display_returns_unreachable() {
        let mut c = ctx(XServerPlatform::Linux);
        c.dependency_available = true;
        let err = classify(&c).expect_err("Xorg present, no DISPLAY → typed error");
        assert!(matches!(err, XServerError::ServerUnreachable { .. }));
    }

    #[test]
    fn current_status_reports_session_count() {
        let mgr = XServerManager::new();
        mgr.register_session();
        let status = current_status(&mgr);
        assert_eq!(status.session_count, 1);
        assert_eq!(status.platform, XServerPlatform::current());
    }
}
