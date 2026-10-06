//! Host-side spawn of a `termihub-plugin-runner` process (#4182).
//!
//! * **Transport (Unix):** `UnixStream::pair()`; the runner's end is inherited
//!   as descriptor 3 and nothing else is passed — every other descriptor the
//!   host opens is close-on-exec (std's default). There is no filesystem
//!   rendezvous path, so nothing can squat it.
//! * **Environment:** scrubbed to `LANG`, `TZ`, `HOME` and `TMPDIR` — no
//!   `SSH_AUTH_SOCK`, no `TERMIHUB_*`, nothing else of the host's.
//! * **Windows:** the private named pipe + handle list + job object transport
//!   is the next slice of #4182; until then spawning reports
//!   [`HostError::RunnerUnavailable`].

use std::path::{Path, PathBuf};
use std::process::Child;

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

/// Spawn `runner` with its channel end as descriptor 3.
#[cfg(unix)]
pub(super) fn spawn_runner(runner: &Path) -> Result<Spawned, HostError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    use termihub_plugin_runner::ipc::{IPC_FD, PROTOCOL_ARG, PROTOCOL_VERSION};

    let unavailable = |detail: String| HostError::RunnerUnavailable {
        path: runner.to_owned(),
        detail,
    };
    let (host_end, runner_end) =
        UnixStream::pair().map_err(|e| unavailable(format!("socketpair failed: {e}")))?;
    let runner_fd = runner_end.as_raw_fd();
    // Larger socket buffers than the AF_UNIX defaults (8 KiB on macOS) let a
    // whole 64 KiB output burst cross in one write; best effort.
    for fd in [host_end.as_raw_fd(), runner_fd] {
        set_socket_buffers(fd, SOCKET_BUFFER);
    }

    let mut command = Command::new(runner);
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
    let child = command.spawn().map_err(|e| unavailable(e.to_string()))?;
    // The runner owns its end now; the host must not keep a copy, or the
    // runner's death would never surface as end-of-stream.
    drop(runner_end);
    Ok(Spawned {
        child,
        stream: host_end,
    })
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
    Err(HostError::RunnerUnavailable {
        path: runner.to_owned(),
        detail: "out-of-process plugins are not available on this platform yet".to_owned(),
    })
}

/// Where the bundled runner lives: next to the running executable (Tauri
/// `externalBin` sidecars are installed beside the main binary).
#[must_use]
pub fn default_runner_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = format!("termihub-plugin-runner{}", std::env::consts::EXE_SUFFIX);
    Some(exe.parent()?.join(name))
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

    #[test]
    fn the_default_runner_sits_next_to_the_executable() {
        let path = default_runner_path().expect("current exe has a parent");
        let exe = std::env::current_exe().unwrap();
        assert_eq!(path.parent(), exe.parent());
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("termihub-plugin-runner"));
    }
}
