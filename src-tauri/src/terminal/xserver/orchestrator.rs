//! The cross-platform `ensure_x_server()` orchestrator (#1052).
//!
//! A thin layer over the [`XServerManager`] lifecycle manager (#1049): it drives
//! the manager's adopt/spawn logic, adds the pieces that are specific to the
//! *connection flow* — best-effort XQuartz launch on macOS, cross-platform
//! detection of a Unix-socket server the manager's TCP probe can't see, and
//! typed, actionable per-platform errors — and reports a frontend-friendly
//! status. The per-platform install internals (VcXsrv download #1047 remainder,
//! XQuartz install #1054, Linux gap classification #1055) are their own issues.

use termihub_core::backends::ssh::x11::{
    detect_local_x_server, read_local_xauth_cookie, LocalXServerInfo, ResolvedXServer,
};

use super::manager::{XServerManager, XServerStatus as ManagedStatus};
use super::types::{XServerError, XServerPlatform, XServerState, XServerStatusReport};

/// Outcome of [`ensure_x_server`]: the UI-facing status report plus, on success,
/// the fully-resolved server the SSH connect path should forward to.
///
/// Threading the resolved server here (rather than re-detecting it in
/// [`X11Forwarder::start`](termihub_core::backends::ssh::x11::X11Forwarder::start))
/// removes the second socket/DISPLAY/TCP probe on the connect hot path (#1087).
pub struct EnsureOutcome {
    /// Frontend-friendly status (state, platform, message).
    pub report: XServerStatusReport,
    /// Where to forward to, when a usable server was resolved; `None` when the
    /// call returned a report without a reachable server.
    pub resolved: Option<ResolvedXServer>,
}

/// Ensure a usable local X server for the current platform.
///
/// Resolution order: the manager's own adopt/spawn (`ensure_running`) → a
/// cross-platform detection fallback for a user-run server the TCP probe can't
/// see (e.g. XQuartz on a Unix socket) → a typed, actionable error.
pub fn ensure_x_server(
    manager: &XServerManager,
    provide_automatically: bool,
) -> Result<EnsureOutcome, XServerError> {
    let platform = XServerPlatform::current();
    let dependency = dependency_available(platform);

    // macOS: if XQuartz is installed but idle, nudge it up so detection and the
    // SSH `DISPLAY` handshake can succeed.
    #[cfg(target_os = "macos")]
    if dependency && detect_local_x_server().is_none() {
        macos::launch_xquartz();
    }

    // 1. Let the manager adopt/reuse/spawn (TCP-based; covers Windows + managed).
    if let Ok(info) = manager.ensure_running() {
        // Both managed and TCP-adopted servers are reached at 127.0.0.1:6000+n;
        // resolve here so the forwarder need not probe again. A managed server's
        // cookie is known up front; an adopted one's is read via `xauth` (a
        // no-op on Windows, where an `-ac` server needs no cookie).
        let (state, cookie) = if info.managed {
            (
                XServerState::Running,
                manager.managed_server().and_then(|m| m.cookie),
            )
        } else {
            (XServerState::Adopted, read_local_xauth_cookie(info.display))
        };
        let resolved = ResolvedXServer {
            info: LocalXServerInfo::tcp_loopback(info.display),
            cookie,
        };
        let report = report(
            platform,
            state,
            Some(info.display),
            info.managed,
            dependency,
        );
        return Ok(EnsureOutcome {
            report,
            resolved: Some(resolved),
        });
    }

    // 2. Fall back to cross-platform detection for a user-run server the TCP
    //    probe cannot see (DISPLAY / Unix socket on macOS & Linux). Thread the
    //    resolved info (and its cookie) straight through to the forwarder.
    if let Some(local) = detect_local_x_server() {
        let cookie = read_local_xauth_cookie(local.display_number);
        let report = report(
            platform,
            XServerState::Adopted,
            Some(local.display_number),
            false,
            dependency,
        );
        return Ok(EnsureOutcome {
            report,
            resolved: Some(ResolvedXServer {
                info: local,
                cookie,
            }),
        });
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
            match detect_local_x_server() {
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
///
/// Uses the `which` crate so `PATH` parsing and platform executable rules
/// (Windows `PATHEXT`, etc.) are handled by a maintained library rather than a
/// hand-rolled split.
fn binary_on_path(name: &str) -> bool {
    which::which(name).is_ok()
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

    // ── Resolved-server threading (#1087) ────────────────────────────────
    //
    // These exercise `ensure_x_server` end-to-end with an injected manager to
    // prove the resolved server (the thing that removes the forwarder's second
    // probe) is threaded through. Skipped on macOS, where `ensure_x_server`
    // best-effort launches XQuartz when idle — an unwanted side effect in a unit
    // test. The resolution logic is platform-independent, so Windows + Linux
    // coverage is sufficient.
    #[cfg(not(target_os = "macos"))]
    mod resolved {
        use super::*;
        use crate::terminal::xserver::auth::{XAuth, XAuthProvider};
        use crate::terminal::xserver::manager::{ManagedProcess, PortProbe, XServerLauncher};
        use std::path::{Path, PathBuf};
        use termihub_core::backends::ssh::x11::LocalXConnection;

        const FAKE_COOKIE: &str = "0011223344556677889900aabbccddee";

        struct FakeProbe {
            open: Vec<u16>,
        }
        impl PortProbe for FakeProbe {
            fn is_open(&self, port: u16) -> bool {
                self.open.contains(&port)
            }
        }

        struct FakeProc;
        impl ManagedProcess for FakeProc {
            fn is_alive(&mut self) -> bool {
                true
            }
            fn terminate(&mut self) {}
        }

        struct FakeLauncher;
        impl XServerLauncher for FakeLauncher {
            fn launch(
                &self,
                _exe: &Path,
                _display: u32,
                _auth_file: Option<&Path>,
            ) -> anyhow::Result<Box<dyn ManagedProcess>> {
                Ok(Box::new(FakeProc))
            }
        }

        struct FakeAuth;
        impl XAuthProvider for FakeAuth {
            fn provision(&self, _display: u32) -> anyhow::Result<XAuth> {
                Ok(XAuth {
                    auth_file: PathBuf::from("fake/.Xauthority"),
                    cookie_hex: FAKE_COOKIE.to_string(),
                })
            }
        }

        fn manager(open: Vec<u16>, provides_managed: bool) -> XServerManager {
            XServerManager::new(
                Box::new(FakeProbe { open }),
                Box::new(FakeLauncher),
                Box::new(|| Ok(PathBuf::from("vcxsrv.exe"))),
                Box::new(FakeAuth),
                provides_managed,
                false,
            )
        }

        fn assert_tcp_loopback(conn: &LocalXConnection, port: u16) {
            match conn {
                LocalXConnection::Tcp(host, p) => {
                    assert_eq!(host, "127.0.0.1");
                    assert_eq!(*p, port);
                }
                #[cfg(unix)]
                LocalXConnection::UnixSocket(_) => panic!("expected TCP loopback, got a socket"),
            }
        }

        #[test]
        fn spawned_managed_server_is_resolved_with_cookie() {
            // No port open → the manager spawns a managed server on :0. The
            // outcome carries the resolved TCP-loopback target and the known
            // cookie, so the forwarder needs no second probe or `xauth` call.
            let mgr = manager(vec![], true);
            let outcome = ensure_x_server(&mgr, true).expect("managed server ensured");

            assert_eq!(outcome.report.state, XServerState::Running);
            let resolved = outcome.resolved.expect("resolved server threaded through");
            assert_eq!(resolved.info.display_number, 0);
            assert_tcp_loopback(&resolved.info.connection, 6000);
            assert_eq!(resolved.cookie.as_deref(), Some(FAKE_COOKIE));
        }

        #[test]
        fn adopted_tcp_server_is_resolved_as_loopback() {
            // A reachable server on :0 is adopted and resolved to TCP loopback
            // (its cookie, if any, is read via `xauth` and is environment
            // dependent, so it is not asserted here).
            let mgr = manager(vec![6000], false);
            let outcome = ensure_x_server(&mgr, true).expect("adopted server ensured");

            assert_eq!(outcome.report.state, XServerState::Adopted);
            let resolved = outcome.resolved.expect("resolved adopted server threaded");
            assert_eq!(resolved.info.display_number, 0);
            assert_tcp_loopback(&resolved.info.connection, 6000);
        }
    }
}
