//! Host-side spawn of a `termihub-plugin-runner` process (#4182).
//!
//! * **Transport (Unix):** `UnixStream::pair()`; the runner's end is inherited
//!   as descriptor 3 and nothing else is passed — every other descriptor the
//!   host opens is close-on-exec (std's default). There is no filesystem
//!   rendezvous path, so nothing can squat it.
//! * **Transport (Windows, #4201):** a private single-instance named pipe
//!   (`termihub_plugin_runner::ipc::pipe::PipeStream`); the
//!   runner's end is the only handle it inherits besides its standard handles
//!   (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), its value passed as
//!   `--ipc-handle`. The runner starts suspended inside a kill-on-close job
//!   object carrying the [`ResourceLimits`], so it never outlives the host
//!   (`termihub_plugin_runner::process`).
//! * **Confinement (Windows, #4187):** a runner with a sandbox policy starts in
//!   its plugin's Less-Privileged AppContainer (`super::appcontainer`), and the
//!   pipe's DACL also admits that AppContainer's SID. On Unix the runner
//!   confines itself after the handshake.
//! * **Environment:** scrubbed to [`PASSED_ENV`] — no `SSH_AUTH_SOCK`, no
//!   `TERMIHUB_*`, nothing else of the host's.
//! * **Integrity (#4202):** the bundled runner is hashed through a retained
//!   handle and spawned through it before anything is sent to it
//!   ([`super::locate`]).

use std::path::Path;

use termihub_plugin_runner::ipc::ResourceLimits;
use termihub_plugin_runner::sandbox::SandboxPolicy;

use super::locate::{check_runner, confirm_runner};

use crate::plugin::HostError;

/// The only host environment variables a runner inherits.
#[cfg(unix)]
pub(super) const PASSED_ENV: &[&str] = &["LANG", "TZ", "HOME", "TMPDIR"];
/// The only host environment variables a runner inherits: the Unix set plus
/// the Windows minimum (system DLLs need `SystemRoot`; `TEMP` / `TMP` are the
/// temporary directory).
#[cfg(windows)]
pub(super) const PASSED_ENV: &[&str] = &["LANG", "TZ", "HOME", "SystemRoot", "TEMP", "TMP"];

/// The runner process: `std`'s child on Unix, the job-object-bound child on
/// Windows (same `id` / `kill` / `try_wait` / `wait` / `stderr` surface).
#[cfg(unix)]
pub(super) type RunnerChild = std::process::Child;
/// The runner process: `std`'s child on Unix, the job-object-bound child on
/// Windows (same `id` / `kill` / `try_wait` / `wait` / `stderr` surface).
#[cfg(windows)]
pub(super) type RunnerChild = termihub_plugin_runner::process::JobChild;

/// The host's end of a runner channel.
#[cfg(unix)]
pub(super) type HostChannel = std::os::unix::net::UnixStream;
/// The host's end of a runner channel.
#[cfg(windows)]
pub(super) type HostChannel = termihub_plugin_runner::ipc::pipe::PipeStream;

/// The plugin a runner is confined for, when its configuration requests the
/// OS sandbox.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(
    not(windows),
    allow(dead_code, reason = "read by the Windows spawn only")
)]
pub(super) struct RunnerSandbox<'a> {
    /// The plugin id (names its Windows AppContainer).
    pub(super) plugin_id: &'a str,
    /// What the runner may access.
    pub(super) policy: &'a SandboxPolicy,
}

/// What the host confines a runner with at spawn: the plugin's AppContainer
/// on Windows; nothing on Unix, where the runner confines itself.
#[cfg(windows)]
type Confinement = termihub_plugin_runner::appcontainer::AppContainer;
/// What the host confines a runner with at spawn: the plugin's AppContainer
/// on Windows; nothing on Unix, where the runner confines itself.
#[cfg(unix)]
type Confinement = ();

/// A freshly spawned runner and the host's end of its channel.
pub(super) struct Spawned {
    pub(super) child: RunnerChild,
    pub(super) stream: HostChannel,
}

/// The scrubbed environment handed to a runner: [`PASSED_ENV`] entries the
/// host has set, nothing else.
pub(super) fn scrubbed_env() -> Vec<(String, std::ffi::OsString)> {
    PASSED_ENV
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|v| ((*name).to_owned(), v)))
        .collect()
}

/// Spawn `runner` with its channel end, after the bundled runner passed its
/// integrity check. `limits` bind the runner's job object on Windows; on Unix
/// the runner applies them itself after the handshake. With a `sandbox`, a
/// Windows runner starts in the plugin's AppContainer.
pub(super) fn spawn_runner(
    runner: &Path,
    limits: &ResourceLimits,
    sandbox: Option<RunnerSandbox<'_>>,
) -> Result<Spawned, HostError> {
    spawn_checked(runner, check_runner(runner)?, limits, sandbox)
}

/// Spawn `runner`; through `pinned` (and re-verified after the spawn) when it
/// was integrity-checked, by path otherwise.
fn spawn_checked(
    runner: &Path,
    pinned: Option<termihub_plugin_runner::loader::PinnedLibrary>,
    limits: &ResourceLimits,
    sandbox: Option<RunnerSandbox<'_>>,
) -> Result<Spawned, HostError> {
    let unavailable = |detail: String| HostError::RunnerUnavailable {
        path: runner.to_owned(),
        detail,
    };
    // `exec` names the pinned handle (Linux: `/proc/self/fd/<n>`) or a path
    // re-checked to still be the hashed file (Windows: the held pin denies
    // writes to it until the spawn is done).
    let exec_path = match &pinned {
        Some(pinned) => pinned.load_path().map_err(|e| unavailable(e.to_string()))?,
        None => runner.to_owned(),
    };
    let confinement = confinement(&exec_path, sandbox)?;
    let Spawned { mut child, stream } =
        start(&exec_path, runner, limits, confinement.as_ref()).map_err(unavailable)?;
    // The spawn returned once the image was mapped: re-hash the pinned file
    // before the runner is sent anything, and kill it if the file changed.
    if let Some(pinned) = &pinned {
        if let Err(e) = confirm_runner(runner, pinned) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    }
    Ok(Spawned { child, stream })
}

/// Windows: prepare the plugin's AppContainer for a sandboxed runner.
#[cfg(windows)]
fn confinement(
    exec_path: &Path,
    sandbox: Option<RunnerSandbox<'_>>,
) -> Result<Option<Confinement>, HostError> {
    sandbox
        .map(|sandbox| super::appcontainer::prepare(exec_path, sandbox.plugin_id, sandbox.policy))
        .transpose()
}

/// Unix: the runner confines itself after the handshake.
#[cfg(unix)]
#[allow(clippy::unnecessary_wraps, reason = "the Windows twin can fail")]
fn confinement(
    _exec_path: &Path,
    _sandbox: Option<RunnerSandbox<'_>>,
) -> Result<Option<Confinement>, HostError> {
    Ok(None)
}

/// Start `exec_path` (shown as `runner`) with its end of a fresh socketpair as
/// descriptor 3.
#[cfg(unix)]
fn start(
    exec_path: &Path,
    runner: &Path,
    _limits: &ResourceLimits,
    _confinement: Option<&Confinement>,
) -> Result<Spawned, String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    use termihub_plugin_runner::ipc::{IPC_FD, PROTOCOL_ARG, PROTOCOL_VERSION};

    let (host_end, runner_end) =
        UnixStream::pair().map_err(|e| format!("socketpair failed: {e}"))?;
    let runner_fd = runner_end.as_raw_fd();
    // Larger socket buffers than the AF_UNIX defaults (8 KiB on macOS) let a
    // whole 64 KiB output burst cross in one write; best effort.
    for fd in [host_end.as_raw_fd(), runner_fd] {
        set_socket_buffers(fd, SOCKET_BUFFER);
    }

    let mut command = Command::new(exec_path);
    // The process keeps its real name when exec'd through a descriptor.
    command.arg0(runner);
    command
        .arg(PROTOCOL_ARG)
        .arg(PROTOCOL_VERSION.to_string())
        .env_clear()
        .envs(scrubbed_env())
        .stdin(Stdio::null())
        // Plugin stdout goes where it went in-process: the host's. Stderr is
        // forwarded there line by line by the host (#4184), which watches it
        // for a plugin's allocation failure under the memory limit.
        .stdout(Stdio::inherit())
        .stderr(Stdio::piped());
    // SAFETY: the closure runs in the forked child before `exec` and only calls
    // the async-signal-safe `dup2` / `fcntl` on descriptors it was handed.
    unsafe {
        command.pre_exec(move || {
            if runner_fd == IPC_FD {
                // Already in place: just clear close-on-exec on it.
                if libc::fcntl(IPC_FD, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(runner_fd, IPC_FD) < 0 {
                // `dup2` leaves the new descriptor without close-on-exec.
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = spawn_command(command).map_err(|e| e.to_string())?;
    // The runner owns its end now; the host must not keep a copy, or the
    // runner's death would never surface as end-of-stream.
    drop(runner_end);
    Ok(Spawned {
        child,
        stream: host_end,
    })
}

/// Start `exec_path` inside a kill-on-close job object bounded by `limits`,
/// with its end of a fresh private pipe as its only inherited handle besides
/// its standard handles (#4201) — and inside `container`, when given (#4187),
/// whose SID the pipe's DACL then admits too.
#[cfg(windows)]
fn start(
    exec_path: &Path,
    _runner: &Path,
    limits: &ResourceLimits,
    container: Option<&Confinement>,
) -> Result<Spawned, String> {
    use std::os::windows::io::AsHandle;

    use termihub_plugin_runner::ipc::pipe::PipeStream;
    use termihub_plugin_runner::ipc::{PROTOCOL_ARG, PROTOCOL_VERSION};
    use termihub_plugin_runner::process::{ChildStdio, RunnerCommand};

    let sids: Vec<&str> = container.iter().map(|c| c.sid_string()).collect();
    let (host_end, runner_end) = PipeStream::pair_with_access(&sids)
        .map_err(|e| format!("creating the runner pipe failed: {e}"))?;
    let mut command = RunnerCommand::new(exec_path);
    command
        .arg(PROTOCOL_ARG)
        .arg(PROTOCOL_VERSION.to_string())
        .envs(scrubbed_env())
        // As on Unix: plugin stdout goes to the host's, stderr is forwarded.
        .stdout(ChildStdio::Inherit)
        .stderr(ChildStdio::Piped)
        .limits(*limits);
    if let Some(container) = container {
        command.app_container(container.clone());
        // A working directory the AppContainer may open: its own folder.
        if let Some(folder) = exec_path.parent() {
            command.current_dir(folder);
        }
    }
    let child = command
        .spawn(runner_end.as_handle())
        .map_err(|e| e.to_string())?;
    // The runner owns its end now; the host must not keep a copy, or the
    // runner's death would never surface as end-of-stream.
    drop(runner_end);
    Ok(Spawned {
        child,
        stream: host_end,
    })
}

/// Linux: the runner's `PR_SET_PDEATHSIG` fires when the *thread* that forked
/// it exits, not the host process. Every runner is therefore forked from one
/// long-lived spawner thread, so a runner started from a short-lived thread
/// (crash recovery, a blocking-pool worker) does not die with that thread.
#[cfg(target_os = "linux")]
fn spawn_command(command: std::process::Command) -> std::io::Result<std::process::Child> {
    use std::sync::mpsc::{channel, sync_channel, Sender, SyncSender};
    use std::sync::OnceLock;

    type Request = (
        std::process::Command,
        SyncSender<std::io::Result<std::process::Child>>,
    );
    static SPAWNER: OnceLock<Option<Sender<Request>>> = OnceLock::new();
    let spawner = SPAWNER.get_or_init(|| {
        let (tx, rx) = channel::<Request>();
        std::thread::Builder::new()
            .name("plugin-runner-spawner".to_owned())
            .spawn(move || {
                for (mut command, reply) in rx {
                    let _ = reply.send(command.spawn());
                }
            })
            .ok()
            .map(|_| tx)
    });
    let Some(spawner) = spawner else {
        return Err(std::io::Error::other("no plugin-runner spawner thread"));
    };
    let (reply, result) = sync_channel(1);
    spawner
        .send((command, reply))
        .map_err(|_| std::io::Error::other("the plugin-runner spawner thread is gone"))?;
    result
        .recv()
        .map_err(|_| std::io::Error::other("the plugin-runner spawner thread is gone"))?
}

#[cfg(all(unix, not(target_os = "linux")))]
fn spawn_command(mut command: std::process::Command) -> std::io::Result<std::process::Child> {
    command.spawn()
}

/// Send/receive buffer size requested for each end of the channel.
#[cfg(unix)]
const SOCKET_BUFFER: libc::c_int = 1024 * 1024;

/// Best-effort `SO_SNDBUF` / `SO_RCVBUF` on `fd` (the kernel may clamp it).
#[cfg(unix)]
fn set_socket_buffers(fd: std::os::fd::RawFd, size: libc::c_int) {
    for option in [libc::SO_SNDBUF, libc::SO_RCVBUF] {
        // SAFETY: `fd` is an open socket we own; `size` outlives the call and
        // its length is passed exactly.
        unsafe {
            libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                option,
                std::ptr::from_ref(&size).cast(),
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scrubbed_environment_only_carries_the_allow_list() {
        for (name, _) in scrubbed_env() {
            assert!(PASSED_ENV.contains(&name.as_str()), "{name} leaked");
        }
    }

    #[test]
    fn a_missing_runner_is_unavailable() {
        let tmp = tempfile::TempDir::new().unwrap();
        let missing = tmp.path().join("no-such-runner");
        match spawn_runner(&missing, &ResourceLimits::default(), None) {
            Err(HostError::RunnerUnavailable { path, .. }) => assert_eq!(path, missing),
            Err(other) => panic!("expected RunnerUnavailable, got {other:?}"),
            Ok(_) => panic!("spawning a missing runner succeeded"),
        }
    }

    /// A stand-in runner that exits 0 once started with any arguments. Linux
    /// execs the pinned descriptor, which needs a real ELF (a `#!` script's
    /// interpreter cannot reopen the close-on-exec `/proc/self/fd/<n>`); macOS
    /// kills copies of platform binaries, so there it is a script.
    #[cfg(unix)]
    fn stand_in_runner() -> (tempfile::TempDir, std::path::PathBuf, String) {
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join(super::super::RUNNER_BIN_NAME);
        if cfg!(any(target_os = "linux", target_os = "android")) {
            std::fs::copy("/bin/true", &path).unwrap();
        } else {
            std::fs::write(&path, b"#!/bin/sh\nexit 0\n").unwrap();
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let digest = format!(
            "sha256:{}",
            hex::encode(Sha256::digest(std::fs::read(&path).unwrap()))
        );
        (tmp, path, digest)
    }

    /// Spawn through the pinned handle, retrying the Linux `ETXTBSY` race a
    /// freshly written executable can hit while other test threads fork.
    #[cfg(unix)]
    fn spawn_pinned(path: &Path, digest: &str) -> Result<Spawned, HostError> {
        use termihub_plugin_runner::loader::PinnedLibrary;
        for _ in 0..50 {
            let pinned = PinnedLibrary::open_verified(path, digest).unwrap();
            match spawn_checked(path, Some(pinned), &ResourceLimits::default(), None) {
                Err(HostError::RunnerUnavailable { detail, .. })
                    if detail.contains("Text file busy") =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                other => return other,
            }
        }
        panic!("spawn kept failing with ETXTBSY");
    }

    #[cfg(unix)]
    #[test]
    fn a_verified_runner_is_spawned_through_its_pinned_handle() {
        let (_tmp, path, digest) = stand_in_runner();
        let Spawned { mut child, .. } = match spawn_pinned(&path, &digest) {
            Ok(spawned) => spawned,
            Err(e) => panic!("pinned spawn failed: {e}"),
        };
        assert!(child.wait().unwrap().success());
    }

    /// Windows: a copy of `where.exe` stands in for the runner (it refuses the
    /// runner's arguments and exits). It is spawned by its verified path while
    /// the pin is held, inside its job, and its channel end dies with it.
    #[cfg(windows)]
    #[test]
    fn a_verified_runner_is_spawned_by_its_pinned_path_on_windows() {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        use termihub_plugin_runner::loader::PinnedLibrary;
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join(super::super::RUNNER_BIN_NAME);
        let system = std::env::var_os("SystemRoot").expect("SystemRoot is set");
        let source = std::path::Path::new(&system)
            .join("System32")
            .join("where.exe");
        std::fs::copy(&source, &path).unwrap();
        let digest = format!(
            "sha256:{}",
            hex::encode(Sha256::digest(std::fs::read(&path).unwrap()))
        );
        let pinned = PinnedLibrary::open_verified(&path, &digest).unwrap();
        let Spawned { mut child, stream } = match spawn_checked(
            &path,
            Some(pinned),
            &ResourceLimits::plugin_defaults(),
            None,
        ) {
            Ok(spawned) => spawned,
            Err(e) => panic!("pinned spawn failed: {e}"),
        };
        child.wait().expect("the stand-in exits");
        assert_eq!((&stream).read(&mut [0u8; 1]).unwrap(), 0, "channel EOF");
    }

    /// macOS / other Unix spawn by path: a file swapped in after the check
    /// (same bytes, new inode) is refused before anything runs.
    #[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
    #[test]
    fn a_runner_swapped_after_its_check_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        use termihub_plugin_runner::loader::PinnedLibrary;
        let (tmp, path, digest) = stand_in_runner();
        let pinned = PinnedLibrary::open_verified(&path, &digest).unwrap();
        let swap = tmp.path().join("swap");
        std::fs::copy(&path, &swap).unwrap();
        std::fs::set_permissions(&swap, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::rename(&swap, &path).unwrap();
        match spawn_checked(&path, Some(pinned), &ResourceLimits::default(), None) {
            Err(HostError::RunnerUnavailable { .. }) => {}
            Err(other) => panic!("expected RunnerUnavailable, got {other:?}"),
            Ok(_) => panic!("a swapped runner was spawned"),
        }
    }
}
