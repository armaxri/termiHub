//! Host-side spawn of a `termihub-plugin-runner` process (#4182).
//!
//! * **Transport (Unix):** `UnixStream::pair()`; the runner's end is inherited
//!   as descriptor 3 and nothing else is passed. Std opens descriptors
//!   close-on-exec, but a library linked into the host may not, so
//!   the forked child marks every descriptor above 3 close-on-exec before the
//!   `exec` (#4203): the runner starts holding exactly 0–3. There is no
//!   filesystem rendezvous path, so nothing can squat it.
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
        // Plugin stdout goes to the host's stdout. Stderr is
        // forwarded there line by line by the host (#4184), which watches it
        // for a plugin's allocation failure under the memory limit.
        .stdout(Stdio::inherit())
        .stderr(Stdio::piped());
    // SAFETY: the closure runs in the forked child before `exec` and only makes
    // async-signal-safe system calls (`dup2`, `fcntl`, `getrlimit`,
    // `close_range`) on descriptors of its own process; it allocates nothing.
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
            cloexec_above(IPC_FD);
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

/// Mark every descriptor above `last_kept` close-on-exec, in the forked child
/// before `exec` (#4203): whatever the host process holds without
/// close-on-exec — a library's descriptor, a racing `fork` elsewhere — never
/// reaches the runner.
///
/// Marking instead of closing keeps the descriptors `exec` itself still needs:
/// std's close-on-exec error pipe, and on Linux the pinned runner image that
/// is executed as `/proc/self/fd/<n>` ([`super::locate`]). `exec` then closes
/// them all.
///
/// Linux uses `close_range(CLOSE_RANGE_CLOEXEC)` (5.11+), else walks
/// `/proc/self/fd`; macOS lists the open descriptors with `proc_pidinfo`.
/// Either falls back to a loop up to the descriptor limit (slow when that
/// limit is high, hence last).
///
/// # Safety
///
/// Async-signal-safe: system calls only, no allocation (buffers are on the
/// stack); callable between `fork` and `exec`.
#[cfg(unix)]
unsafe fn cloexec_above(last_kept: libc::c_int) {
    let first = last_kept.saturating_add(1);
    // SAFETY: forwarded caller contract.
    if unsafe { cloexec_listed(first) } {
        return;
    }
    // SAFETY: `fcntl` on a descriptor that is not open fails with `EBADF`,
    // which is ignored.
    unsafe {
        for fd in first..descriptor_ceiling() {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
}

/// Linux: `close_range(first, ~0, CLOSE_RANGE_CLOEXEC)`, or else every
/// descriptor listed in `/proc/self/fd` (read with raw `getdents64` into a
/// stack buffer, [`cloexec_proc_fd`]). `false` when neither is available.
///
/// # Safety
///
/// As [`cloexec_above`].
#[cfg(target_os = "linux")]
unsafe fn cloexec_listed(first: libc::c_int) -> bool {
    // SAFETY: a plain system call on this process's descriptor table.
    let ranged = unsafe {
        libc::syscall(
            libc::SYS_close_range,
            libc::c_uint::try_from(first).unwrap_or(libc::c_uint::MAX),
            libc::c_uint::MAX,
            libc::CLOSE_RANGE_CLOEXEC,
        )
    };
    // SAFETY: forwarded caller contract.
    ranged == 0 || unsafe { cloexec_proc_fd(first) }
}

/// Linux without `close_range`: mark every descriptor listed in
/// `/proc/self/fd` from `first` on. `false` when `/proc` cannot be read.
///
/// # Safety
///
/// As [`cloexec_above`].
#[cfg(target_os = "linux")]
unsafe fn cloexec_proc_fd(first: libc::c_int) -> bool {
    // SAFETY: the path is a NUL-terminated literal.
    let dir = unsafe {
        libc::open(
            c"/proc/self/fd".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if dir < 0 {
        return false;
    }
    let mut buf = [0u8; 4096];
    let mut complete = false;
    loop {
        // SAFETY: `buf` is writable for its whole length.
        let read = unsafe { libc::syscall(libc::SYS_getdents64, dir, buf.as_mut_ptr(), buf.len()) };
        let Ok(read) = usize::try_from(read) else {
            break;
        };
        if read == 0 {
            complete = true;
            break;
        }
        // `struct linux_dirent64`: d_ino (8), d_off (8), d_reclen (2),
        // d_type (1), then the NUL-terminated name.
        let mut at = 0;
        while at + 19 < read {
            let reclen = usize::from(u16::from_ne_bytes([buf[at + 16], buf[at + 17]]));
            if reclen == 0 {
                break;
            }
            let fd = parse_fd(&buf[at + 19..(at + reclen).min(read)]);
            if let Some(fd) = fd.filter(|&fd| fd >= first && fd != dir) {
                // SAFETY: `fcntl` on one of this process's descriptors.
                unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
            }
            at += reclen;
        }
    }
    // SAFETY: `dir` is the descriptor opened above.
    unsafe { libc::close(dir) };
    complete
}

/// The descriptor number a `/proc/self/fd` entry name spells (up to its NUL).
#[cfg(target_os = "linux")]
fn parse_fd(name: &[u8]) -> Option<libc::c_int> {
    let mut fd: libc::c_int = 0;
    let mut digits = 0;
    for &b in name.iter().take_while(|&&b| b != 0) {
        if !b.is_ascii_digit() {
            return None;
        }
        fd = fd
            .checked_mul(10)?
            .checked_add(libc::c_int::from(b - b'0'))?;
        digits += 1;
    }
    (digits > 0).then_some(fd)
}

/// macOS: every open descriptor, listed by `proc_pidinfo(PROC_PIDLISTFDS)`
/// into a stack buffer. `false` when the list does not fit (or fails).
///
/// # Safety
///
/// As [`cloexec_above`].
#[cfg(target_os = "macos")]
unsafe fn cloexec_listed(first: libc::c_int) -> bool {
    const SLOTS: usize = 2048;
    let mut fds = [libc::proc_fdinfo {
        proc_fd: 0,
        proc_fdtype: 0,
    }; SLOTS];
    let size = std::mem::size_of_val(&fds);
    // SAFETY: `fds` is writable for `size` bytes; `getpid` is the child's.
    let listed = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDLISTFDS,
            0,
            fds.as_mut_ptr().cast(),
            libc::c_int::try_from(size).unwrap_or(libc::c_int::MAX),
        )
    };
    let Ok(listed) = usize::try_from(listed) else {
        return false;
    };
    // A full buffer may have been truncated: let the caller loop instead.
    if listed == 0 || listed >= size {
        return false;
    }
    for info in &fds[..listed / std::mem::size_of::<libc::proc_fdinfo>()] {
        if info.proc_fd >= first {
            // SAFETY: `fcntl` on one of this process's descriptors.
            unsafe { libc::fcntl(info.proc_fd, libc::F_SETFD, libc::FD_CLOEXEC) };
        }
    }
    true
}

/// No listing on other Unixes: the caller loops.
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
unsafe fn cloexec_listed(_first: libc::c_int) -> bool {
    false
}

/// Upper bound (exclusive) of the fallback loop: the soft `RLIMIT_NOFILE`,
/// capped so an unlimited limit cannot make the child spin.
#[cfg(unix)]
fn descriptor_ceiling() -> libc::c_int {
    const CAP: libc::rlim_t = 1 << 20;
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `limit` is a valid, writable `rlimit`.
    let soft = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == 0 {
        limit.rlim_cur.min(CAP)
    } else {
        CAP
    };
    libc::c_int::try_from(soft).unwrap_or(libc::c_int::MAX)
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

    /// Whether a shell started with `pre_exec` still holds descriptor `fd`
    /// (a high number the shell never uses itself).
    #[cfg(unix)]
    fn child_sees(fd: libc::c_int, pre_exec: Option<unsafe fn(libc::c_int)>) -> bool {
        use std::os::unix::process::CommandExt;
        let mut command = std::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(format!("[ -e /dev/fd/{fd} ] && echo SEEN || echo GONE"));
        if let Some(sweep) = pre_exec {
            // SAFETY: `sweep` is async-signal-safe (see `cloexec_above`).
            unsafe {
                command.pre_exec(move || {
                    sweep(IPC_FD);
                    Ok(())
                });
            }
        }
        let out = command.output().expect("sh runs");
        match String::from_utf8_lossy(&out.stdout).trim() {
            "SEEN" => true,
            "GONE" => false,
            other => panic!("unexpected probe output {other:?}"),
        }
    }

    /// A descriptor the host holds without close-on-exec, at a number no
    /// shell uses for itself.
    #[cfg(unix)]
    fn stray_descriptor() -> std::os::fd::OwnedFd {
        use std::os::fd::{AsRawFd, FromRawFd};
        let file = tempfile::tempfile().unwrap();
        // SAFETY: `F_DUPFD` returns a new descriptor (close-on-exec clear)
        // that the `OwnedFd` takes ownership of.
        unsafe {
            let fd = libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 400);
            assert!(fd >= 400, "F_DUPFD failed");
            std::os::fd::OwnedFd::from_raw_fd(fd)
        }
    }

    #[cfg(unix)]
    use termihub_plugin_runner::ipc::IPC_FD;

    #[cfg(unix)]
    #[test]
    fn the_descriptor_sweep_hides_stray_descriptors_from_the_child() {
        use std::os::fd::AsRawFd;
        let stray = stray_descriptor();
        let fd = stray.as_raw_fd();
        // Control: without the sweep the child inherits it.
        assert!(child_sees(fd, None), "the probe cannot see the stray fd");
        assert!(!child_sees(fd, Some(cloexec_above)));
        #[cfg(target_os = "linux")]
        {
            // The pre-5.11 path, exercised directly.
            unsafe fn proc_walk(first: libc::c_int) {
                // SAFETY: forwarded caller contract.
                assert!(unsafe { cloexec_proc_fd(first + 1) });
            }
            assert!(!child_sees(fd, Some(proc_walk)));
            assert_eq!(parse_fd(b"123\0"), Some(123));
            assert_eq!(parse_fd(b".\0"), None);
            assert_eq!(parse_fd(b"99999999999999\0"), None);
        }
        #[cfg(target_os = "macos")]
        {
            unsafe fn listed(first: libc::c_int) {
                // SAFETY: forwarded caller contract.
                assert!(unsafe { cloexec_listed(first + 1) });
            }
            assert!(!child_sees(fd, Some(listed)));
        }
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
