//! The cross-platform `ensure_x_server()` orchestrator (#1052).
//!
//! A thin layer over the [`XServerManager`] lifecycle manager (#1049): it drives
//! the manager's adopt/spawn logic, adds the pieces that are specific to the
//! *connection flow* — best-effort XQuartz launch on macOS, cross-platform
//! detection of a Unix-socket server the manager's TCP probe can't see, and
//! typed, actionable per-platform errors — and reports a frontend-friendly
//! status. The per-platform install internals (VcXsrv download #1047 remainder,
//! XQuartz install #1054, Linux gap classification #1055) are their own issues.

use std::sync::Arc;

use termihub_core::backends::ssh::x11::{
    detect_local_x_server, read_local_xauth_cookie, LocalXServerInfo, ResolvedXServer,
};

use super::linux_gap::{self, LinuxXEnv};
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
    /// The server the SSH connect path should forward to (managed or adopted).
    /// Present on every `Ok`; the "no server at all" case is an `Err` instead.
    pub resolved: ResolvedXServer,
}

/// Ensure a usable local X server for the current platform, **without** claiming
/// a session against it (the status/probe path behind the `x_server_ensure`
/// command).
///
/// Resolution order: the manager's own adopt/spawn (`ensure_running`) → a
/// cross-platform detection fallback for a user-run server the TCP probe can't
/// see (e.g. XQuartz on a Unix socket) → a typed, actionable error.
pub fn ensure_x_server(
    manager: &XServerManager,
    provide_automatically: bool,
) -> Result<EnsureOutcome, XServerError> {
    ensure_x_server_impl(manager, provide_automatically)
}

/// Ensure a usable local X server **and** claim a session against it, returning
/// an owned [`SessionGuard`] whose drop releases the session exactly once (the
/// SSH X11 connect path, #1107).
///
/// The guard is threaded into core's connect path as a session-lifetime
/// resource, so [`release_session`](XServerManager::release_session) — and thus
/// the existing idle-shutdown behavior — fires when the session ends. The
/// returned [`EnsureOutcome::report`] reflects the freshly-incremented count.
pub fn ensure_x_server_for_session(
    manager: &Arc<XServerManager>,
    provide_automatically: bool,
) -> Result<(EnsureOutcome, super::manager::SessionGuard), XServerError> {
    // Acquire first: this drives the same adopt/reuse/spawn logic as
    // `ensure_running` while bumping the refcount, and hands back a guard that
    // releases on drop. If acquisition fails there is nothing to release.
    let guard = manager
        .acquire_session_lease()
        .map_err(|e| XServerError::LaunchFailed {
            message: format!("failed to acquire X server session: {e}"),
        })?;
    // Resolve the (now running) server for the report/forwarder. The lease
    // already ensured it, so this reuses the live process without a second
    // acquire. If resolution somehow fails, dropping `guard` releases the
    // session we just claimed.
    let outcome = ensure_x_server_impl(manager, provide_automatically)?;
    Ok((outcome, guard))
}

/// Shared adopt/reuse/spawn + resolve body for the probe and connect paths. The
/// session claim (if any) is made by the caller via `acquire_session_lease`;
/// this reads the resulting count into the report.
fn ensure_x_server_impl(
    manager: &XServerManager,
    provide_automatically: bool,
) -> Result<EnsureOutcome, XServerError> {
    let platform = XServerPlatform::current();
    let dependency = dependency_available(platform);

    // macOS: if XQuartz is installed but idle, nudge it up so detection and the
    // SSH `DISPLAY` handshake can succeed.
    #[cfg(target_os = "macos")]
    if dependency && detect_local_x_server().is_none() {
        super::macos::launch_xquartz();
    }

    // 1. Let the manager adopt/reuse/spawn (TCP-based; covers Windows + managed).
    if let Ok(info) = manager.ensure_running() {
        // Both managed and TCP-adopted servers are reached at 127.0.0.1:6000+n;
        // resolve here so the forwarder need not probe again. A server termiHub
        // spawned reports its cookie up front (`managed_server()`); an adopted
        // one's is read via `xauth` (a no-op on Windows, where an `-ac` server
        // needs none).
        let (state, managed, resolved) = match manager.managed_server() {
            Some(server) => (XServerState::Running, true, server.resolved()),
            None => (
                XServerState::Adopted,
                false,
                ResolvedXServer {
                    info: LocalXServerInfo::tcp_loopback(info.display),
                    cookie: read_local_xauth_cookie(info.display),
                },
            ),
        };
        let report = report(
            platform,
            state,
            Some(resolved.info.display_number),
            managed,
            dependency,
            manager.session_count(),
        );
        return Ok(EnsureOutcome { report, resolved });
    }

    // 2. Fall back to cross-platform detection for a user-run server the TCP
    //    probe cannot see (DISPLAY / Unix socket on macOS & Linux). Thread the
    //    resolved info (and its cookie) straight through to the forwarder.
    if let Some(resolved) = ResolvedXServer::detect_user_run() {
        let report = report(
            platform,
            XServerState::Adopted,
            Some(resolved.info.display_number),
            false,
            dependency,
            manager.session_count(),
        );
        return Ok(EnsureOutcome { report, resolved });
    }

    // 3. Nothing usable — return actionable, typed guidance. On Linux the
    //    specific gap (Wayland-without-XWayland / headless / sandboxed socket)
    //    is classified from an environment snapshot; other platforms ignore it,
    //    so only pay for the snapshot's filesystem/PATH scans on Linux.
    let linux_env = if platform == XServerPlatform::Linux {
        LinuxXEnv::detect()
    } else {
        LinuxXEnv::unknown()
    };
    Err(classify_failure(
        platform,
        provide_automatically,
        dependency,
        &linux_env,
    ))
}

/// Report the current X server status without side effects (no launching, no
/// provisioning). Backs the `x_server_status` command.
pub fn current_status(manager: &XServerManager) -> XServerStatusReport {
    let platform = XServerPlatform::current();
    let dependency = dependency_available(platform);

    // Live dependent-session count from the manager's refcount (#1107). Only the
    // manager-tracked Running/Adopted states carry live sessions; the
    // detection-fallback and Failed/Absent cases report zero.
    let sessions = manager.session_count();

    match manager.status() {
        ManagedStatus::Running { display } => report(
            platform,
            XServerState::Running,
            Some(display),
            true,
            dependency,
            sessions,
        ),
        ManagedStatus::Adopted { display } => report(
            platform,
            XServerState::Adopted,
            Some(display),
            false,
            dependency,
            sessions,
        ),
        ManagedStatus::Failed { message } => {
            let mut r = report(platform, XServerState::Failed, None, false, dependency, 0);
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
                    0,
                ),
                None => {
                    let mut r = report(platform, XServerState::Absent, None, false, dependency, 0);
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
    linux_env: &LinuxXEnv,
) -> XServerError {
    match platform {
        XServerPlatform::Windows if provide_automatically => {
            XServerError::windows_provisioning_unavailable()
        }
        XServerPlatform::Windows => XServerError::windows_no_local_server(),
        XServerPlatform::MacOs if dependency_available => XServerError::macos_server_unreachable(),
        XServerPlatform::MacOs => XServerError::xquartz_missing(),
        // Linux never installs a server; the specific gap decides the hint.
        XServerPlatform::Linux => linux_gap::classify(linux_env).to_error(),
    }
}

/// Build a status report with an adoption/managed message derived from the state.
///
/// `session_count` is the live dependent-session refcount (#1107), surfaced to
/// the UI; it is `0` for states with no active server.
fn report(
    platform: XServerPlatform,
    state: XServerState,
    display_number: Option<u32>,
    managed: bool,
    dependency_available: bool,
    session_count: usize,
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
        session_count,
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
        XServerPlatform::MacOs => super::macos::xquartz_installed(),
        XServerPlatform::Linux => {
            std::path::Path::new("/tmp/.X11-unix").is_dir()
                || super::binary_on_path("Xwayland")
                || super::binary_on_path("Xorg")
        }
        XServerPlatform::Windows => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Windows/macOS cases ignore the Linux env; pass the neutral `unknown()`
    // snapshot. The Linux gap logic itself is covered exhaustively in
    // `linux_gap`'s own tests.

    #[test]
    fn windows_with_auto_provisioning_returns_provisioning_unavailable() {
        let err = classify_failure(XServerPlatform::Windows, true, false, &LinuxXEnv::unknown());
        assert!(matches!(err, XServerError::ProvisioningUnavailable { .. }));
    }

    #[test]
    fn windows_without_auto_provisioning_returns_no_local_server() {
        let err = classify_failure(
            XServerPlatform::Windows,
            false,
            false,
            &LinuxXEnv::unknown(),
        );
        assert!(matches!(err, XServerError::NoLocalServer { .. }));
    }

    #[test]
    fn macos_without_xquartz_returns_dependency_missing() {
        let err = classify_failure(XServerPlatform::MacOs, false, false, &LinuxXEnv::unknown());
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
        let err = classify_failure(XServerPlatform::MacOs, false, true, &LinuxXEnv::unknown());
        assert!(matches!(err, XServerError::ServerUnreachable { .. }));
    }

    #[test]
    fn linux_without_x_server_returns_dependency_missing() {
        // No display, an x11 session claimed, but no server binary or socket.
        let env = LinuxXEnv {
            display: Some(":0".to_string()),
            xdg_session_type: Some("x11".to_string()),
            ..LinuxXEnv::unknown()
        };
        match classify_failure(XServerPlatform::Linux, false, false, &env) {
            XServerError::DependencyMissing { dependency, .. } => {
                assert_eq!(dependency, "Xorg/XWayland");
            }
            other => panic!("expected DependencyMissing, got {other:?}"),
        }
    }

    #[test]
    fn linux_with_dependency_but_no_display_returns_unreachable() {
        // Xorg installed but no reachable display → unreachable, not missing.
        let env = LinuxXEnv {
            display: Some(":0".to_string()),
            xdg_session_type: Some("x11".to_string()),
            xorg_on_path: true,
            ..LinuxXEnv::unknown()
        };
        let err = classify_failure(XServerPlatform::Linux, false, true, &env);
        assert!(matches!(err, XServerError::ServerUnreachable { .. }));
    }

    #[test]
    fn linux_wayland_without_xwayland_returns_xwayland_dependency() {
        // The headline edge case: Wayland session, no XWayland, no socket.
        let env = LinuxXEnv {
            wayland_display: Some("wayland-0".to_string()),
            xdg_session_type: Some("wayland".to_string()),
            ..LinuxXEnv::unknown()
        };
        match classify_failure(XServerPlatform::Linux, false, false, &env) {
            XServerError::DependencyMissing { dependency, .. } => {
                assert_eq!(dependency, "XWayland");
            }
            other => panic!("expected DependencyMissing(XWayland), got {other:?}"),
        }
    }

    #[test]
    fn report_sets_adopted_message_and_display() {
        let r = report(
            XServerPlatform::Linux,
            XServerState::Adopted,
            Some(7),
            false,
            true,
            3,
        );
        assert_eq!(r.state, XServerState::Adopted);
        assert_eq!(r.display_number, Some(7));
        assert!(!r.managed);
        assert_eq!(r.session_count, 3);
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
            let resolved = outcome.resolved;
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
            let resolved = outcome.resolved;
            assert_eq!(resolved.info.display_number, 0);
            assert_tcp_loopback(&resolved.info.connection, 6000);
        }

        // ── Session refcount wiring (#1107) ──────────────────────────────

        #[test]
        fn acquire_flag_increments_refcount_and_populates_session_count() {
            // The connect path acquires a session: the refcount rises and the
            // status report surfaces it as `session_count`.
            let mgr = manager(vec![], true);

            // Hold each guard alive: dropping it would release the session and
            // decrement the refcount, so the accumulation assertions below rely
            // on both leases staying in scope.
            let (outcome, _guard1) =
                ensure_x_server_for_session(&mgr, true).expect("session acquired");
            assert_eq!(outcome.report.session_count, 1, "first session counted");
            assert_eq!(mgr.session_count(), 1);

            let (outcome, _guard2) =
                ensure_x_server_for_session(&mgr, true).expect("second session acquired");
            assert_eq!(outcome.report.session_count, 2, "second session counted");
            assert_eq!(mgr.session_count(), 2);
        }

        #[test]
        fn probe_only_ensure_does_not_acquire_a_session() {
            // The status/probe path (`x_server_ensure` command) must not leak a
            // refcount: it ensures the server but acquires nothing.
            let mgr = manager(vec![], true);

            let outcome = ensure_x_server(&mgr, true).expect("server ensured");
            assert_eq!(outcome.report.session_count, 0, "probe must not acquire");
            assert_eq!(mgr.session_count(), 0);
        }

        #[test]
        fn current_status_reflects_live_session_count() {
            let mgr = manager(vec![], true);

            // Keep both leases alive so the live count stays at 2.
            let (_o1, _guard1) = ensure_x_server_for_session(&mgr, true).expect("session acquired");
            let (_o2, _guard2) = ensure_x_server_for_session(&mgr, true).expect("session acquired");

            let status = current_status(&mgr);
            assert_eq!(status.state, XServerState::Running);
            assert_eq!(status.session_count, 2, "live count surfaced in status");
        }

        #[test]
        fn session_lease_releases_on_drop() {
            // The lease returned by the connect path releases exactly one
            // session when dropped, preserving the manager's refcount.
            let mgr = std::sync::Arc::new(manager(vec![], true));

            let lease = XServerManager::acquire_session_lease(&mgr).expect("session lease");
            assert_eq!(mgr.session_count(), 1);
            drop(lease);
            assert_eq!(mgr.session_count(), 0, "lease drop releases the session");
        }
    }
}
