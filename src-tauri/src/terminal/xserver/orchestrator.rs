//! The cross-platform `ensure_x_server()` orchestrator (#1052).
//!
//! A thin layer over the [`XServerManager`] lifecycle manager (#1049): it drives
//! the manager's adopt/spawn logic, adds the pieces that are specific to the
//! *connection flow* — best-effort XQuartz launch on macOS, cross-platform
//! detection of a Unix-socket server the manager's TCP probe can't see, and
//! typed, actionable per-platform errors — and reports a frontend-friendly
//! status. The per-platform install internals (VcXsrv download #1047 remainder,
//! XQuartz install #1054, Linux gap classification #1055) are their own issues.

use termihub_core::backends::ssh::x11::detect_local_x_server;

use super::manager::{XServerManager, XServerStatus as ManagedStatus};
use super::types::{XServerError, XServerPlatform, XServerState, XServerStatusReport};

/// Ensure a usable local X server for the current platform.
///
/// Resolution order: the manager's own adopt/spawn (`ensure_running`) → a
/// cross-platform detection fallback for a user-run server the TCP probe can't
/// see (e.g. XQuartz on a Unix socket) → a typed, actionable error.
pub fn ensure_x_server(
    manager: &XServerManager,
    provide_automatically: bool,
) -> Result<XServerStatusReport, XServerError> {
    let platform = XServerPlatform::current();
    let dependency = dependency_available(platform);

    // macOS: if XQuartz is installed but idle, nudge it up so detection and the
    // SSH `DISPLAY` handshake can succeed.
    #[cfg(target_os = "macos")]
    if dependency && detect_local_x_server(None).is_none() {
        macos::launch_xquartz();
    }

    // 1. Let the manager adopt/reuse/spawn (TCP-based; covers Windows + managed).
    if let Ok(info) = manager.ensure_running() {
        let state = if info.managed {
            XServerState::Running
        } else {
            XServerState::Adopted
        };
        return Ok(report(
            platform,
            state,
            Some(info.display),
            info.managed,
            dependency,
        ));
    }

    // 2. Fall back to cross-platform detection for a user-run server the TCP
    //    probe cannot see (DISPLAY / Unix socket on macOS & Linux).
    if let Some(local) = detect_local_x_server(None) {
        return Ok(report(
            platform,
            XServerState::Adopted,
            Some(local.display_number),
            false,
            dependency,
        ));
    }

    // 3. Nothing usable — return actionable, typed guidance.
    Err(classify_failure(
        platform,
        provide_automatically,
        dependency,
    ))
}

/// Report the current X server status without side effects (no launching, no
/// provisioning). Backs the `x_server_status` command.
pub fn current_status(manager: &XServerManager) -> XServerStatusReport {
    let platform = XServerPlatform::current();
    let dependency = dependency_available(platform);

    match manager.status() {
        ManagedStatus::Running { display } => report(
            platform,
            XServerState::Running,
            Some(display),
            true,
            dependency,
        ),
        ManagedStatus::Adopted { display } => report(
            platform,
            XServerState::Adopted,
            Some(display),
            false,
            dependency,
        ),
        ManagedStatus::Failed { message } => {
            let mut r = report(platform, XServerState::Failed, None, false, dependency);
            r.message = Some(message);
            r
        }
        ManagedStatus::Stopped => {
            // The manager only tracks TCP servers; consult cross-platform
            // detection for an adopted Unix-socket server it can't see.
            match detect_local_x_server(None) {
                Some(local) => report(
                    platform,
                    XServerState::Adopted,
                    Some(local.display_number),
                    false,
                    dependency,
                ),
                None => {
                    let mut r = report(platform, XServerState::Absent, None, false, dependency);
                    r.message = Some("No local X server detected.".to_string());
                    r
                }
            }
        }
    }
}

/// Pure per-platform decision for the *no server available* case: which typed,
/// actionable error to surface. Side-effect-free so the "dispatches to the
/// correct platform path; failures → typed errors" acceptance criterion is
/// verifiable on any CI host.
pub fn classify_failure(
    platform: XServerPlatform,
    provide_automatically: bool,
    dependency_available: bool,
) -> XServerError {
    match platform {
        XServerPlatform::Windows if provide_automatically => {
            XServerError::windows_provisioning_unavailable()
        }
        XServerPlatform::Windows => XServerError::windows_no_local_server(),
        XServerPlatform::MacOs if dependency_available => XServerError::macos_server_unreachable(),
        XServerPlatform::MacOs => XServerError::xquartz_missing(),
        XServerPlatform::Linux if dependency_available => XServerError::linux_server_unreachable(),
        XServerPlatform::Linux => XServerError::linux_x_missing(),
    }
}

/// Build a status report with an adoption/managed message derived from the state.
fn report(
    platform: XServerPlatform,
    state: XServerState,
    display_number: Option<u32>,
    managed: bool,
    dependency_available: bool,
) -> XServerStatusReport {
    let message = match (state, display_number) {
        (XServerState::Running, Some(d)) => {
            Some(format!("termiHub-managed X server on display :{d}"))
        }
        (XServerState::Adopted, Some(d)) => {
            Some(format!("Adopted an existing X server on display :{d}"))
        }
        _ => None,
    };
    XServerStatusReport {
        state,
        platform,
        display_number,
        managed,
        dependency_available: Some(dependency_available),
        message,
    }
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

    #[test]
    fn windows_with_auto_provisioning_returns_provisioning_unavailable() {
        let err = classify_failure(XServerPlatform::Windows, true, false);
        assert!(matches!(err, XServerError::ProvisioningUnavailable { .. }));
    }

    #[test]
    fn windows_without_auto_provisioning_returns_no_local_server() {
        let err = classify_failure(XServerPlatform::Windows, false, false);
        assert!(matches!(err, XServerError::NoLocalServer { .. }));
    }

    #[test]
    fn macos_without_xquartz_returns_dependency_missing() {
        let err = classify_failure(XServerPlatform::MacOs, false, false);
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
        let err = classify_failure(XServerPlatform::MacOs, false, true);
        assert!(matches!(err, XServerError::ServerUnreachable { .. }));
    }

    #[test]
    fn linux_without_x_server_returns_dependency_missing() {
        let err = classify_failure(XServerPlatform::Linux, false, false);
        match err {
            XServerError::DependencyMissing { dependency, .. } => {
                assert_eq!(dependency, "Xorg/XWayland");
            }
            other => panic!("expected DependencyMissing, got {other:?}"),
        }
    }

    #[test]
    fn linux_with_dependency_but_no_display_returns_unreachable() {
        let err = classify_failure(XServerPlatform::Linux, false, true);
        assert!(matches!(err, XServerError::ServerUnreachable { .. }));
    }

    #[test]
    fn report_sets_adopted_message_and_display() {
        let r = report(
            XServerPlatform::Linux,
            XServerState::Adopted,
            Some(7),
            false,
            true,
        );
        assert_eq!(r.state, XServerState::Adopted);
        assert_eq!(r.display_number, Some(7));
        assert!(!r.managed);
        assert!(r.message.unwrap().contains(":7"));
    }
}
