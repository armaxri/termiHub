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

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Result;

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
    let _ = (display, auth_file);
    unimplemented!("build_launch_args")
}

/// Find the lowest display number in `0..=max` whose TCP port is free (closed).
///
/// Returns `None` if every candidate port is already in use.
pub fn first_free_display(max: u32, is_open: impl Fn(u16) -> bool) -> Option<u32> {
    let _ = (max, is_open);
    unimplemented!("first_free_display")
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
    display: Option<u32>,
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
    /// `true` on platforms that provide a managed server (Windows); `false`
    /// elsewhere, where the manager only adopts/report an existing server.
    provides_managed: bool,
    /// Optional `-auth` cookie file (wired by #1050); `None` uses `-ac`.
    auth_file: Mutex<Option<PathBuf>>,
    max_display: u32,
}

impl XServerManager {
    /// Construct a manager from injected collaborators (used by tests and by the
    /// real platform wiring in `lib.rs`).
    pub fn new(
        probe: Box<dyn PortProbe>,
        launcher: Box<dyn XServerLauncher>,
        resolver: Box<dyn Fn() -> Result<PathBuf> + Send + Sync>,
        provides_managed: bool,
        stop_when_idle: bool,
    ) -> Self {
        Self {
            inner: Mutex::new(Inner {
                status: XServerStatus::Stopped,
                child: None,
                display: None,
                refcount: 0,
                stop_when_idle,
            }),
            probe,
            launcher,
            resolver,
            provides_managed,
            auth_file: Mutex::new(None),
            max_display: MAX_DISPLAY,
        }
    }

    /// Set the `-auth` cookie file used for future launches (issue #1050).
    pub fn set_auth_file(&self, path: Option<PathBuf>) {
        if let Ok(mut guard) = self.auth_file.lock() {
            *guard = path;
        }
    }

    /// Current server status.
    pub fn status(&self) -> XServerStatus {
        unimplemented!("status")
    }

    /// Ensure a usable X server exists, spawning or adopting one as needed.
    ///
    /// Order: reuse our live managed process → adopt an external server on `:0`
    /// → (managed platforms only) spawn a new server on the first free display.
    pub fn ensure_running(&self) -> Result<DisplayInfo> {
        unimplemented!("ensure_running")
    }

    /// Ensure a server exists and register a session against it (refcount + 1).
    pub fn acquire_session(&self) -> Result<DisplayInfo> {
        unimplemented!("acquire_session")
    }

    /// Release a previously acquired session (refcount - 1). When the count
    /// reaches zero and idle-shutdown is enabled, the managed server is stopped.
    /// Adopted external servers are never terminated.
    pub fn release_session(&self) {
        unimplemented!("release_session")
    }

    /// Stop the managed server (if any) and reset state. Adopted external
    /// servers are left running.
    pub fn stop(&self) {
        unimplemented!("stop")
    }
}

impl Drop for XServerManager {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(child) = inner.child.as_mut() {
                child.terminate();
            }
            inner.child = None;
        }
    }
}

// ---------------------------------------------------------------------------
// Real collaborator implementations (used by the platform wiring in lib.rs).
// ---------------------------------------------------------------------------

/// Real TCP probe against `127.0.0.1`.
pub struct TcpPortProbe;

impl PortProbe for TcpPortProbe {
    fn is_open(&self, port: u16) -> bool {
        let _ = port;
        unimplemented!("TcpPortProbe::is_open")
    }
}

/// A live OS process wrapping [`std::process::Child`].
pub struct ChildProcess(pub std::process::Child);

impl ManagedProcess for ChildProcess {
    fn is_alive(&mut self) -> bool {
        unimplemented!("ChildProcess::is_alive")
    }

    fn terminate(&mut self) {
        unimplemented!("ChildProcess::terminate")
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
        let _ = (exe, display, auth_file);
        unimplemented!("CommandLauncher::launch")
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

    fn manager_with(
        open_ports: &[u16],
        launcher: Arc<FakeLauncher>,
        provides_managed: bool,
        stop_when_idle: bool,
    ) -> XServerManager {
        XServerManager::new(
            Box::new(FakeProbe::with_open(open_ports)),
            Box::new(launcher),
            resolver_ok(),
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
        assert!(!info.managed, "external server should be adopted, not managed");
        assert_eq!(info.display, 0);
        assert_eq!(launcher.count(), 0, "must not spawn when adopting");
        assert_eq!(mgr.status(), XServerStatus::Adopted { display: 0 });
    }

    #[test]
    fn spawns_managed_server_when_none_present() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[], launcher.clone(), true, true);

        let info = mgr.ensure_running().unwrap();
        assert!(info.managed);
        assert_eq!(info.display, 0);
        assert_eq!(info.port, 6000);
        assert_eq!(launcher.count(), 1);
        assert_eq!(mgr.status(), XServerStatus::Running { display: 0 });
        // launched with -ac (no auth file configured yet)
        assert!(launcher.last_args.lock().unwrap().iter().any(|a| a == "-ac"));
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
        assert!(state.lock().unwrap().terminated, "managed server must stop when idle");
        assert_eq!(mgr.status(), XServerStatus::Stopped);
    }

    #[test]
    fn idle_stop_disabled_keeps_process_running() {
        let launcher = FakeLauncher::new();
        let mgr = manager_with(&[], launcher.clone(), true, false);

        mgr.acquire_session().unwrap();
        mgr.release_session();

        let state = launcher.spawned.lock().unwrap()[0].clone();
        assert!(!state.lock().unwrap().terminated, "must stay up when idle-stop is off");
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
        assert!(state.lock().unwrap().terminated, "Drop must reap the process");
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

        assert!(mgr.ensure_running().is_err(), "no server + no managed provisioning → error");
        assert_eq!(launcher.count(), 0);
    }
}
