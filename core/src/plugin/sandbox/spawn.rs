//! Host-side spawn of a `termihub-plugin-runner` process (#4182).
//!
//! * **Transport (Unix):** `UnixStream::pair()`; the runner's end is inherited
//!   as descriptor 3 and nothing else is passed — every other descriptor the
//!   host opens is close-on-exec (std's default). There is no filesystem
//!   rendezvous path, so nothing can squat it.
//! * **Environment:** scrubbed to `LANG`, `TZ`, `HOME` and `TMPDIR` — no
//!   `SSH_AUTH_SOCK`, no `TERMIHUB_*`, nothing else of the host's.
//! * **Integrity (#4202):** the bundled runner is hashed through a retained
//!   handle and spawned through it before anything is sent to it
//!   ([`super::locate`]).
//! * **Windows:** the private named pipe + handle list + job object transport
//!   is the next slice of #4182; until then spawning reports
//!   [`HostError::RunnerUnavailable`].

use std::path::Path;
use std::process::Child;

use super::locate::check_runner;
#[cfg(unix)]
use super::locate::confirm_runner;

use crate::plugin::HostError;

/// The only host environment variables a runner inherits.
pub(super) const PASSED_ENV: [&str; 4] = ["LANG", "TZ", "HOME", "TMPDIR"];

/// A freshly spawned runner and the host's end of its channel.
pub(super) struct Spawned {
    pub(super) child: Child,
    #[cfg(unix)]
    pub(super) stream: std::os::unix::net::UnixStream,
}

/// The scrubbed environment handed to a runner: [`PASSED_ENV`] entries the
/// host has set, nothing else.
pub(super) fn scrubbed_env() -> Vec<(String, std::ffi::OsString)> {
    PASSED_ENV
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|v| ((*name).to_owned(), v)))
        .collect()
}

/// Spawn `runner` with its channel end as descriptor 3, after the bundled
/// runner passed its integrity check.
#[cfg(unix)]
pub(super) fn spawn_runner(runner: &Path) -> Result<Spawned, HostError> {
    spawn_checked(runner, check_runner(runner)?)
}

/// Spawn `runner`; through `pinned` (and re-verified after the spawn) when it
/// was integrity-checked, by path otherwise.
#[cfg(unix)]
fn spawn_checked(
    runner: &Path,
    pinned: Option<termihub_plugin_runner::loader::PinnedLibrary>,
) -> Result<Spawned, HostError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    use termihub_plugin_runner::ipc::{IPC_FD, PROTOCOL_ARG, PROTOCOL_VERSION};

    let unavailable = |detail: String| HostError::RunnerUnavailable {
        path: runner.to_owned(),
        detail,
    };
    // `exec` names the pinned handle (Linux: `/proc/self/fd/<n>`) or a path
    // re-checked to still be the hashed file.
    let exec_path = match &pinned {
        Some(pinned) => pinned.load_path().map_err(|e| unavailable(e.to_string()))?,
        None => runner.to_owned(),
    };
    let (host_end, runner_end) =
        UnixStream::pair().map_err(|e| unavailable(format!("socketpair failed: {e}")))?;
    let runner_fd = runner_end.as_raw_fd();
    // Larger socket buffers than the AF_UNIX defaults (8 KiB on macOS) let a
    // whole 64 KiB output burst cross in one write; best effort.
    for fd in [host_end.as_raw_fd(), runner_fd] {
        set_socket_buffers(fd, SOCKET_BUFFER);
    }

    let mut command = Command::new(&exec_path);
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
    let mut child = spawn_command(command).map_err(|e| unavailable(e.to_string()))?;
    // The runner owns its end now; the host must not keep a copy, or the
    // runner's death would never surface as end-of-stream.
    drop(runner_end);
    // `spawn` returns once `exec` succeeded: re-hash the pinned file before the
    // runner is sent anything, and kill it if the file changed underneath.
    if let Some(pinned) = &pinned {
        if let Err(e) = confirm_runner(runner, pinned) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    }
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
fn spawn_command(command: std::process::Command) -> std::io::Result<Child> {
    use std::sync::mpsc::{channel, sync_channel, Sender, SyncSender};
    use std::sync::OnceLock;

    type Request = (std::process::Command, SyncSender<std::io::Result<Child>>);
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
fn spawn_command(mut command: std::process::Command) -> std::io::Result<Child> {
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

/// No runner transport on this platform yet (Windows: next slice of #4182).
#[cfg(not(unix))]
pub(super) fn spawn_runner(runner: &Path) -> Result<Spawned, HostError> {
    // A missing or tampered bundled runner still reports as such.
    check_runner(runner)?;
    Err(HostError::RunnerUnavailable {
        path: runner.to_owned(),
        detail: "out-of-process plugins are not available on this platform yet".to_owned(),
    })
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
        match spawn_runner(&missing) {
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
            match spawn_checked(path, Some(pinned)) {
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
        match spawn_checked(&path, Some(pinned)) {
            Err(HostError::RunnerUnavailable { .. }) => {}
            Err(other) => panic!("expected RunnerUnavailable, got {other:?}"),
            Ok(_) => panic!("a swapped runner was spawned"),
        }
    }
}
