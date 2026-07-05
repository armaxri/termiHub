//! Single shared X server process lifecycle: spawn, supervise, reuse, shut down.
//!
//! `XServerManager` is registered as Tauri managed state. It keeps at most one
//! managed X server alive for the whole termiHub instance and hands the same
//! display out to every X11 session (reference counted). If an external X server
//! is already reachable on `:0` it is adopted instead of spawning a duplicate.
//!
//! Testability: process spawning, port probing and binary resolution are all
//! injected behind small traits, so the reuse / adopt / idle-shutdown logic is
//! exercised by unit tests on every platform without a real `vcxsrv.exe`.
//!
//! Part of the X-server provisioning epic (#1047). This issue (#1049) builds the
//! lifecycle core; the session-facing API (`ensure_running`, `acquire_session`,
//! `release_session`, `status`, `set_auth_file`, [`DisplayInfo`], [`XServerStatus`])
//! is exercised by the unit tests here and wired into the orchestrator, auth and
//! UI in sibling issues (#1050, #1052, #1053). Until then those entry points are
//! reachable only from tests, so dead-code analysis is relaxed for this module.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Result;
use termihub_core::backends::ssh::x11::ManagedXServer;
use tracing::warn;

use super::auth::XAuthProvider;

/// TCP base port for X11: display `:N` listens on `6000 + N`.
pub const X11_BASE_PORT: u16 = 6000;

/// Highest display number the manager will try when allocating a free display.
const MAX_DISPLAY: u32 = 32;

/// TCP port for a given X11 display number.
pub fn port_for_display(display: u32) -> u16 {
    X11_BASE_PORT + display as u16
}

/// Build the `vcxsrv.exe` command-line arguments for a managed launch.
///
/// Mirrors the concept: `vcxsrv.exe :N -multiwindow -clipboard [-auth <file> | -ac]`.
/// When no auth file is supplied (cookie auth lands in #1050) access control is
/// disabled with `-ac` so forwarded clients can connect.
pub fn build_launch_args(display: u32, auth_file: Option<&Path>) -> Vec<String> {
    let mut args = vec![
        format!(":{display}"),
        "-multiwindow".to_string(),
        "-clipboard".to_string(),
    ];
    match auth_file {
        Some(path) => {
            args.push("-auth".to_string());
            args.push(path.to_string_lossy().into_owned());
        }
        None => args.push("-ac".to_string()),
    }
    args
}

/// Find the lowest display number in `0..=max` whose TCP port is free (closed).
///
/// Returns `None` if every candidate port is already in use.
pub fn first_free_display(max: u32, is_open: impl Fn(u16) -> bool) -> Option<u32> {
    (0..=max).find(|&display| !is_open(port_for_display(display)))
}

/// Abstraction over "is this local TCP port accepting connections?".
pub trait PortProbe: Send + Sync {
    /// Returns `true` if a connection to `127.0.0.1:port` succeeds.
    fn is_open(&self, port: u16) -> bool;
}

/// A spawned, supervised X server process.
pub trait ManagedProcess: Send {
    /// Returns `true` while the process is still running.
    fn is_alive(&mut self) -> bool;
    /// Terminate the process and reap it. Idempotent.
    fn terminate(&mut self);
}

/// Spawns an X server process from a resolved binary path.
pub trait XServerLauncher: Send + Sync {
    /// Launch `exe` on `display`, optionally with an `-auth` cookie file.
    fn launch(
        &self,
        exe: &Path,
        display: u32,
        auth_file: Option<&Path>,
    ) -> Result<Box<dyn ManagedProcess>>;
}

/// Public status of the local X server as seen by callers / the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum XServerStatus {
    /// No managed or adopted server.
    Stopped,
    /// An external server (not spawned by us) is being used on `display`.
    Adopted { display: u32 },
    /// A server we spawned and supervise is running on `display`.
    Running { display: u32 },
    /// The last spawn attempt failed.
    Failed { message: String },
}

impl XServerStatus {
    /// The display number of an active (adopted or running) server, if any.
    fn display(&self) -> Option<u32> {
        match self {
            XServerStatus::Adopted { display } | XServerStatus::Running { display } => {
                Some(*display)
            }
            XServerStatus::Stopped | XServerStatus::Failed { .. } => None,
        }
    }
}

/// Where an X11 session should connect, returned by [`XServerManager::ensure_running`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayInfo {
    /// X11 display number (`:display`).
    pub display: u32,
    /// TCP port the server listens on (`6000 + display`).
    pub port: u16,
    /// `true` if termiHub spawned and manages this server; `false` if adopted.
    pub managed: bool,
}

impl DisplayInfo {
    fn managed(display: u32) -> Self {
        Self {
            display,
            port: port_for_display(display),
            managed: true,
        }
    }

    fn adopted(display: u32) -> Self {
        Self {
            display,
            port: port_for_display(display),
            managed: false,
        }
    }
}

/// Mutable interior state guarded by a single lock.
struct Inner {
    status: XServerStatus,
    child: Option<Box<dyn ManagedProcess>>,
    /// Hex MIT-MAGIC-COOKIE-1 the running managed server was launched with, or
    /// `None` when it runs in `-ac` mode.
    cookie: Option<String>,
    /// `.Xauthority` file backing the current managed server, removed on stop.
    auth_file: Option<PathBuf>,
    /// Number of live X11 sessions using the server.
    refcount: usize,
    /// Stop the managed server when the last session closes.
    stop_when_idle: bool,
}

/// Manages the shared local X server for one termiHub instance.
pub struct XServerManager {
    inner: Mutex<Inner>,
    probe: Box<dyn PortProbe>,
    launcher: Box<dyn XServerLauncher>,
    resolver: Box<dyn Fn() -> Result<PathBuf> + Send + Sync>,
    auth: Box<dyn XAuthProvider>,
    /// `true` on platforms that provide a managed server (Windows); `false`
    /// elsewhere, where the manager only adopts/report an existing server.
    provides_managed: bool,
}

impl XServerManager {
    /// Construct a manager from injected collaborators (used by tests and by the
    /// real platform wiring in `lib.rs`).
    pub fn new(
        probe: Box<dyn PortProbe>,
        launcher: Box<dyn XServerLauncher>,
        resolver: Box<dyn Fn() -> Result<PathBuf> + Send + Sync>,
        auth: Box<dyn XAuthProvider>,
        provides_managed: bool,
        stop_when_idle: bool,
    ) -> Self {
        Self {
            inner: Mutex::new(Inner {
                status: XServerStatus::Stopped,
                child: None,
                cookie: None,
                auth_file: None,
                refcount: 0,
                stop_when_idle,
            }),
            probe,
            launcher,
            resolver,
            auth,
            provides_managed,
        }
    }

    /// Current server status.
    pub fn status(&self) -> XServerStatus {
        self.inner.lock().expect("xserver lock").status.clone()
    }

    /// Ensure a usable X server exists, spawning or adopting one as needed.
    ///
    /// Order: reuse our live managed process → adopt an external server on `:0`
    /// → (managed platforms only) spawn a new server on the first free display.
    pub fn ensure_running(&self) -> Result<DisplayInfo> {
        let mut inner = self.inner.lock().expect("xserver lock");
        self.ensure_running_locked(&mut inner)
    }

    /// Ensure a server exists and register a session against it (refcount + 1).
    pub fn acquire_session(&self) -> Result<DisplayInfo> {
        let mut inner = self.inner.lock().expect("xserver lock");
        let info = self.ensure_running_locked(&mut inner)?;
        inner.refcount += 1;
        Ok(info)
    }

    /// Release a previously acquired session (refcount - 1). When the count
    /// reaches zero and idle-shutdown is enabled, the managed server is stopped.
    /// Adopted external servers are never terminated.
    pub fn release_session(&self) {
        let mut inner = self.inner.lock().expect("xserver lock");
        inner.refcount = inner.refcount.saturating_sub(1);
        if inner.refcount == 0 && inner.stop_when_idle {
            // Only stop a server we manage; an adopted external server (no child
            // held) must keep running.
            if inner.child.is_some() {
                self.stop_locked(&mut inner);
            }
        }
    }

    /// Stop the managed server (if any) and reset state. Adopted external
    /// servers are left running.
    pub fn stop(&self) {
        let mut inner = self.inner.lock().expect("xserver lock");
        self.stop_locked(&mut inner);
    }

    /// Core adopt/reuse/spawn decision, run under the held lock.
    fn ensure_running_locked(&self, inner: &mut Inner) -> Result<DisplayInfo> {
        // 1. Reuse our own managed process if it is still alive.
        if let Some(child) = inner.child.as_mut() {
            if child.is_alive() {
                let display = inner.status.display().unwrap_or(0);
                return Ok(DisplayInfo::managed(display));
            }
            // It died underneath us — drop the handle and fall through to respawn.
            inner.child = None;
            inner.status = XServerStatus::Stopped;
        }

        // 2. Adopt an external server already listening on :0.
        //
        // A bare TCP probe cannot distinguish an X server from an unrelated
        // service on 6000; per the concept we treat a reachable port as an X
        // server to adopt. Disambiguating a non-X listener (and then allocating
        // the next display) would require a real X11 handshake and is left to a
        // follow-up.
        if self.probe.is_open(port_for_display(0)) {
            inner.status = XServerStatus::Adopted { display: 0 };
            return Ok(DisplayInfo::adopted(0));
        }

        // 3. On platforms without managed provisioning (Unix) we never spawn.
        if !self.provides_managed {
            inner.status = XServerStatus::Stopped;
            anyhow::bail!(
                "no X server reachable on :0 and managed provisioning is unavailable on this platform"
            );
        }

        // 4. Spawn a new managed server on the first free display.
        let display = first_free_display(MAX_DISPLAY, |p| self.probe.is_open(p))
            .ok_or_else(|| anyhow::anyhow!("no free X display in 0..={MAX_DISPLAY}"))?;

        let exe = (self.resolver)().map_err(|e| {
            let msg = format!("failed to resolve X server binary: {e}");
            inner.status = XServerStatus::Failed {
                message: msg.clone(),
            };
            anyhow::anyhow!(msg)
        })?;

        // Provision MIT-MAGIC-COOKIE-1 auth. On failure, fall back to `-ac`
        // (loopback-only, no auth) so forwarding still works, with a warning.
        let auth = match self.auth.provision(display) {
            Ok(auth) => Some(auth),
            Err(e) => {
                warn!("X server: cookie provisioning failed, launching with -ac: {e}");
                None
            }
        };
        let auth_path = auth.as_ref().map(|a| a.auth_file.clone());

        match self.launcher.launch(&exe, display, auth_path.as_deref()) {
            Ok(child) => {
                inner.child = Some(child);
                inner.cookie = auth.as_ref().map(|a| a.cookie_hex.clone());
                inner.auth_file = auth_path;
                inner.status = XServerStatus::Running { display };
                Ok(DisplayInfo::managed(display))
            }
            Err(e) => {
                // Do not leak the cookie file if the process never started.
                remove_auth_file(&auth_path);
                let msg = format!("failed to spawn X server: {e}");
                inner.status = XServerStatus::Failed {
                    message: msg.clone(),
                };
                Err(anyhow::anyhow!(msg))
            }
        }
    }

    /// Terminate the managed child (if any) and reset to `Stopped`.
    fn stop_locked(&self, inner: &mut Inner) {
        if let Some(child) = inner.child.as_mut() {
            child.terminate();
        }
        remove_auth_file(&inner.auth_file);
        inner.child = None;
        inner.cookie = None;
        inner.auth_file = None;
        inner.refcount = 0;
        inner.status = XServerStatus::Stopped;
    }
}

/// Best-effort removal of a written `.Xauthority` file.
fn remove_auth_file(path: &Option<PathBuf>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

impl XServerManager {
    /// Report the server termiHub itself started, so the orchestrator can resolve
    /// it (display + cookie) for the connect path without any filesystem/`xauth`
    /// probing (#1050). Adopted external servers are intentionally excluded — they
    /// are discovered by the normal TCP probe and are not termiHub-managed.
    ///
    /// The cookie is the MIT-MAGIC-COOKIE-1 the managed server was launched with,
    /// or `None` when it fell back to `-ac` mode.
    pub fn managed_server(&self) -> Option<ManagedXServer> {
        let inner = self.inner.lock().expect("xserver lock");
        match inner.status {
            XServerStatus::Running { display } => Some(ManagedXServer {
                display_number: display,
                cookie: inner.cookie.clone(),
            }),
            _ => None,
        }
    }
}

impl Drop for XServerManager {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            self.stop_locked(&mut inner);
        }
    }
}

// ---------------------------------------------------------------------------
// Real collaborator implementations (used by the platform wiring in lib.rs).
// ---------------------------------------------------------------------------

/// Timeout for the TCP reachability probe (matches core X11 detection).
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(300);

/// Real TCP probe against `127.0.0.1`, reusing core's X11 reachability check so
/// the adopt-probe and core detection agree on "an X server is reachable here".
pub struct TcpPortProbe;

impl PortProbe for TcpPortProbe {
    fn is_open(&self, port: u16) -> bool {
        use std::net::{Ipv4Addr, SocketAddr};
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        termihub_core::backends::ssh::x11::probe_tcp_x_server_at(addr, PROBE_TIMEOUT)
    }
}

/// A live OS process wrapping [`std::process::Child`].
pub struct ChildProcess(pub std::process::Child);

impl ManagedProcess for ChildProcess {
    fn is_alive(&mut self) -> bool {
        // `try_wait` returns `Ok(None)` while the process is still running.
        matches!(self.0.try_wait(), Ok(None))
    }

    fn terminate(&mut self) {
        // Best-effort: the process may already have exited.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Real launcher that spawns `vcxsrv.exe` via [`std::process::Command`].
pub struct CommandLauncher;

impl XServerLauncher for CommandLauncher {
    fn launch(
        &self,
        exe: &Path,
        display: u32,
        auth_file: Option<&Path>,
    ) -> Result<Box<dyn ManagedProcess>> {
        use anyhow::Context;

        let mut command = std::process::Command::new(exe);
        command.args(build_launch_args(display, auth_file));

        // Do not pop up a console window for the detached server on Windows.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let child = command
            .spawn()
            .with_context(|| format!("failed to spawn X server: {}", exe.display()))?;
        Ok(Box::new(ChildProcess(child)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Probe backed by a fixed set of "open" ports.
    struct FakeProbe {
        open: Mutex<HashSet<u16>>,
    }

    impl FakeProbe {
        fn with_open(ports: &[u16]) -> Self {
            Self {
                open: Mutex::new(ports.iter().copied().collect()),
            }
        }
    }

    impl PortProbe for FakeProbe {
        fn is_open(&self, port: u16) -> bool {
            self.open.lock().unwrap().contains(&port)
        }
    }

    /// Shared, inspectable state for a fake spawned process.
    #[derive(Default)]
    struct ProcState {
        alive: bool,
        terminated: bool,
    }

    struct FakeProcess {
        state: Arc<Mutex<ProcState>>,
    }

    impl ManagedProcess for FakeProcess {
        fn is_alive(&mut self) -> bool {
            self.state.lock().unwrap().alive
        }

        fn terminate(&mut self) {
            let mut s = self.state.lock().unwrap();
            s.alive = false;
            s.terminated = true;
        }
    }

    /// Launcher that records each spawn and exposes the created process state.
    struct FakeLauncher {
        launches: AtomicUsize,
        last_args: Mutex<Vec<String>>,
        spawned: Mutex<Vec<Arc<Mutex<ProcState>>>>,
    }

    impl FakeLauncher {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                launches: AtomicUsize::new(0),
                last_args: Mutex::new(Vec::new()),
                spawned: Mutex::new(Vec::new()),
            })
        }

        fn count(&self) -> usize {
            self.launches.load(Ordering::SeqCst)
        }
    }

    impl XServerLauncher for Arc<FakeLauncher> {
        fn launch(
            &self,
            _exe: &Path,
            display: u32,
            auth_file: Option<&Path>,
        ) -> Result<Box<dyn ManagedProcess>> {
            self.launches.fetch_add(1, Ordering::SeqCst);
            *self.last_args.lock().unwrap() = build_launch_args(display, auth_file);
            let state = Arc::new(Mutex::new(ProcState {
                alive: true,
                terminated: false,
            }));
            self.spawned.lock().unwrap().push(state.clone());
            Ok(Box::new(FakeProcess { state }))
        }
    }

    fn resolver_ok() -> Box<dyn Fn() -> Result<PathBuf> + Send + Sync> {
        Box::new(|| Ok(PathBuf::from("vcxsrv.exe")))
    }

    /// Fixed cookie the success-path fake provider hands out.
    const FAKE_COOKIE: &str = "0011223344556677889900aabbccddee";

    /// Auth provider fake: `Some(cookie)` → success (no disk I/O); `None` →
    /// provisioning failure, exercising the `-ac` fallback.
    struct FakeAuth {
        cookie: Option<String>,
    }

    impl XAuthProvider for FakeAuth {
        fn provision(&self, _display: u32) -> Result<super::super::auth::XAuth> {
            match &self.cookie {
                Some(cookie) => Ok(super::super::auth::XAuth {
                    auth_file: PathBuf::from("C:/tmp/.Xauthority-fake"),
                    cookie_hex: cookie.clone(),
                }),
                None => anyhow::bail!("fake provisioning failure"),
            }
        }
    }

    fn manager_with(
        open_ports: &[u16],
        launcher: Arc<FakeLauncher>,
        provides_managed: bool,
        stop_when_idle: bool,
    ) -> XServerManager {
        manager_with_auth(
            open_ports,
            launcher,
            Box::new(FakeAuth {
                cookie: Some(FAKE_COOKIE.to_string()),
            }),
            provides_managed,
            stop_when_idle,
        )
    }

    fn manager_with_auth(
        open_ports: &[u16],
        launcher: Arc<FakeLauncher>,
        auth: Box<dyn XAuthProvider>,
        provides_managed: bool,
        stop_when_idle: bool,
    ) -> XServerManager {
        XServerManager::new(
            Box::new(FakeProbe::with_open(open_ports)),
            Box::new(launcher),
            resolver_ok(),
            auth,
            provides_managed,
            stop_when_idle,
        )
    }

    // -- pure helpers -------------------------------------------------------

    #[test]
    fn port_for_display_maps_to_base_plus_display() {
        assert_eq!(port_for_display(0), 6000);
        assert_eq!(port_for_display(1), 6001);
        assert_eq!(port_for_display(10), 6010);
    }

    #[test]
    fn build_launch_args_uses_ac_without_auth() {
        let args = build_launch_args(0, None);
        assert_eq!(args[0], ":0");
        assert!(args.iter().any(|a| a == "-multiwindow"));
        assert!(args.iter().any(|a| a == "-clipboard"));
        assert!(args.iter().any(|a| a == "-ac"));
        assert!(!args.iter().any(|a| a == "-auth"));
    }

    #[test]
    fn build_launch_args_uses_auth_file_when_present() {
        let auth = PathBuf::from("C:/tmp/.Xauthority");
        let args = build_launch_args(2, Some(&auth));
        assert_eq!(args[0], ":2");
        assert!(args.iter().any(|a| a == "-auth"));
        assert!(args.iter().any(|a| a.contains(".Xauthority")));
        assert!(!args.iter().any(|a| a == "-ac"));
    }

    #[test]
    fn first_free_display_returns_zero_when_all_closed() {
        assert_eq!(first_free_display(32, |_| false), Some(0));
    }

    #[test]
    fn first_free_display_skips_used_ports() {
        // 6000 and 6001 taken → first free display is 2.
        let open: HashSet<u16> = [6000, 6001].into_iter().collect();
        assert_eq!(first_free_display(32, |p| open.contains(&p)), Some(2));
    }

    #[test]
    fn first_free_display_none_when_all_used() {
        assert_eq!(first_free_display(2, |_| true), None);
    }

    // -- adopt vs spawn -----------------------------------------------------

    #[test]
    fn adopts_external_server_without_spawning() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[6000], launcher.clone(), true, true);

        let info = mgr.ensure_running().unwrap();
        assert!(
            !info.managed,
            "external server should be adopted, not managed"
        );
        assert_eq!(info.display, 0);
        assert_eq!(launcher.count(), 0, "must not spawn when adopting");
        assert_eq!(mgr.status(), XServerStatus::Adopted { display: 0 });
    }

    #[test]
    fn spawns_managed_server_with_cookie_auth() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[], launcher.clone(), true, true);

        let info = mgr.ensure_running().unwrap();
        assert!(info.managed);
        assert_eq!(info.display, 0);
        assert_eq!(info.port, 6000);
        assert_eq!(launcher.count(), 1);
        assert_eq!(mgr.status(), XServerStatus::Running { display: 0 });
        // Default is cookie auth: launched with -auth, not -ac.
        let args = launcher.last_args.lock().unwrap();
        assert!(args.iter().any(|a| a == "-auth"));
        assert!(!args.iter().any(|a| a == "-ac"));
    }

    #[test]
    fn falls_back_to_ac_when_cookie_provisioning_fails() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with_auth(
            &[],
            launcher.clone(),
            Box::new(FakeAuth { cookie: None }),
            true,
            true,
        );

        mgr.ensure_running().unwrap();
        let args = launcher.last_args.lock().unwrap();
        assert!(args.iter().any(|a| a == "-ac"), "must fall back to -ac");
        assert!(!args.iter().any(|a| a == "-auth"));
        assert!(
            mgr.managed_server().unwrap().cookie.is_none(),
            "-ac mode reports no cookie"
        );
    }

    // -- reuse across sessions ---------------------------------------------

    #[test]
    fn two_sessions_share_one_process() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[], launcher.clone(), true, true);

        let a = mgr.acquire_session().unwrap();
        let b = mgr.acquire_session().unwrap();
        assert_eq!(a, b);
        assert_eq!(launcher.count(), 1, "second session must reuse the process");
    }

    #[test]
    fn respawns_after_process_dies() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[], launcher.clone(), true, false);

        mgr.ensure_running().unwrap();
        assert_eq!(launcher.count(), 1);

        // Simulate the process dying underneath us.
        launcher.spawned.lock().unwrap()[0].lock().unwrap().alive = false;

        mgr.ensure_running().unwrap();
        assert_eq!(launcher.count(), 2, "dead process must be respawned");
    }

    // -- idle policy --------------------------------------------------------

    #[test]
    fn idle_stop_terminates_managed_when_last_session_closes() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[], launcher.clone(), true, true);

        mgr.acquire_session().unwrap();
        mgr.release_session();

        let state = launcher.spawned.lock().unwrap()[0].clone();
        assert!(
            state.lock().unwrap().terminated,
            "managed server must stop when idle"
        );
        assert_eq!(mgr.status(), XServerStatus::Stopped);
    }

    #[test]
    fn idle_stop_disabled_keeps_process_running() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[], launcher.clone(), true, false);

        mgr.acquire_session().unwrap();
        mgr.release_session();

        let state = launcher.spawned.lock().unwrap()[0].clone();
        assert!(
            !state.lock().unwrap().terminated,
            "must stay up when idle-stop is off"
        );
        assert_eq!(mgr.status(), XServerStatus::Running { display: 0 });
    }

    #[test]
    fn adopted_server_not_terminated_on_idle() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[6000], launcher.clone(), true, true);

        mgr.acquire_session().unwrap();
        mgr.release_session();

        assert_eq!(launcher.count(), 0);
        // External server keeps running; we simply report Adopted/idle.
        assert_eq!(mgr.status(), XServerStatus::Adopted { display: 0 });
    }

    // -- explicit stop / shutdown ------------------------------------------

    #[test]
    fn stop_terminates_managed_process() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[], launcher.clone(), true, false);

        mgr.ensure_running().unwrap();
        let state = launcher.spawned.lock().unwrap()[0].clone();
        mgr.stop();

        assert!(state.lock().unwrap().terminated);
        assert_eq!(mgr.status(), XServerStatus::Stopped);
    }

    #[test]
    fn drop_terminates_managed_process_no_orphan() {
        let launcher = FakeLauncher::new();
        let state = {
            let mgr = manager_with(&[], launcher.clone(), true, false);
            mgr.ensure_running().unwrap();
            let s = launcher.spawned.lock().unwrap()[0].clone();
            assert!(!s.lock().unwrap().terminated);
            s
            // mgr dropped here
        };
        assert!(
            state.lock().unwrap().terminated,
            "Drop must reap the process"
        );
    }

    // -- unix no-op ---------------------------------------------------------

    #[test]
    fn non_managed_platform_adopts_external() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[6000], launcher.clone(), false, true);

        let info = mgr.ensure_running().unwrap();
        assert!(!info.managed);
        assert_eq!(launcher.count(), 0);
    }

    #[test]
    fn non_managed_platform_never_spawns() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[], launcher.clone(), false, true);

        assert!(
            mgr.ensure_running().is_err(),
            "no server + no managed provisioning → error"
        );
        assert_eq!(launcher.count(), 0);
    }

    // -- managed-server reporting (orchestrator resolution seam) ------------

    #[test]
    fn managed_server_reports_only_our_spawned_server() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[], launcher.clone(), true, false);

        // Nothing running yet.
        assert!(mgr.managed_server().is_none());

        // A server we spawned is reported with its MIT-MAGIC-COOKIE-1.
        mgr.ensure_running().unwrap();
        let managed = mgr
            .managed_server()
            .expect("managed server should be reported");
        assert_eq!(managed.display_number, 0);
        assert_eq!(managed.cookie.as_deref(), Some(FAKE_COOKIE));

        // After stopping, nothing is reported.
        mgr.stop();
        assert!(mgr.managed_server().is_none());
    }

    #[test]
    fn managed_server_excludes_adopted_external() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[6000], launcher.clone(), true, false);

        mgr.ensure_running().unwrap();
        // Adopted external servers are found by normal detection, not reported
        // here as termiHub-managed.
        assert!(mgr.managed_server().is_none());
    }
}
