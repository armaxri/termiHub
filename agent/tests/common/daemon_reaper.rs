//! Find, watch and reap a daemon by the **exact PID** serving an endpoint
//! (#3636).
//!
//! A registry daemon is spawned detached by an agent, not by the test, so the
//! test holds no `Child` for it. The endpoint is unique to the test, though, and
//! the OS can say which process is on the other end of a connection to it: that
//! PID is the daemon, with no name matching involved (a name pattern could hit
//! a parallel checkout's daemon). [`DaemonGuard`] records it and, on drop,
//! kills it only if the endpoint is *still* served by that same PID — so a PID
//! recycled after the daemon exited on its own is never touched.

#![allow(
    dead_code,
    reason = "shared test-support module: each test binary uses a different subset"
)]

use std::time::{Duration, Instant};

/// Reaps the daemon serving an endpoint when dropped (see the module docs).
pub struct DaemonGuard {
    endpoint: String,
    pid: u32,
}

impl DaemonGuard {
    /// Record the process currently serving `endpoint`, or `None` when nothing
    /// is (or its PID cannot be read).
    pub fn discover(endpoint: &str) -> Option<Self> {
        Self::try_discover(endpoint).ok()
    }

    /// [`discover`](Self::discover), keeping the reason a lookup failed so a
    /// test that *requires* the daemon can report it.
    pub fn try_discover(endpoint: &str) -> std::io::Result<Self> {
        server_pid(endpoint).map(|pid| Self {
            endpoint: endpoint.to_string(),
            pid,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Wait up to `timeout` for the daemon process to exit on its own.
    pub fn wait_for_exit(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if !pid_alive(self.pid) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        // Verify before killing: only if the endpoint is still served by the
        // very PID we recorded. Gone (exited on its own) → nothing to do.
        if pid_alive(self.pid) && server_pid(&self.endpoint).ok() == Some(self.pid) {
            kill_pid(self.pid);
        }
    }
}

/// The default endpoint of session `session_id`'s daemon — mirrors the agent's
/// `daemon::transport::session_endpoint` (the agent is a binary crate, so the
/// suites cannot call it).
#[cfg(unix)]
pub fn session_endpoint(session_id: &str) -> String {
    // Safety: `getuid` has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    format!("/tmp/termihub/uid-{uid}/session-{session_id}.sock")
}

#[cfg(windows)]
pub fn session_endpoint(session_id: &str) -> String {
    format!(r"\\.\pipe\termihub-session-{session_id}")
}

/// How long a PID lookup keeps retrying an endpoint that is up but
/// momentarily busy (see [`retry_while_busy`]).
const BUSY_RETRY_BUDGET: Duration = Duration::from_secs(10);

/// Run `attempt` until it stops reporting a *busy* endpoint or `budget` runs
/// out, calling `wait` between tries.
///
/// A windows named pipe serves exactly one client per instance, and the
/// listener stages the next instance only after it has accepted the previous
/// client — so a connect landing just after the worker's (or a readiness
/// probe's) connect sees `ERROR_PIPE_BUSY` even though the daemon is up
/// (#3636). That is the one transient outcome worth retrying; everything else
/// (success, "no such endpoint", any other error) is final. Unix sockets have a
/// listen backlog and never report busy, so there the first attempt decides.
fn retry_while_busy<T>(
    budget: Duration,
    mut attempt: impl FnMut() -> std::io::Result<T>,
    is_busy: impl Fn(&std::io::Error) -> bool,
    mut wait: impl FnMut(),
) -> std::io::Result<T> {
    let deadline = Instant::now() + budget;
    loop {
        match attempt() {
            Err(e) if is_busy(&e) && Instant::now() < deadline => wait(),
            other => return other,
        }
    }
}

/// PID of the process serving the unix socket at `endpoint`.
#[cfg(unix)]
fn server_pid(endpoint: &str) -> std::io::Result<u32> {
    use std::os::unix::io::AsRawFd;
    let stream = std::os::unix::net::UnixStream::connect(endpoint)?;
    peer_pid(stream.as_raw_fd())
        .ok_or_else(|| std::io::Error::other(format!("could not read the peer PID of {endpoint}")))
}

#[cfg(target_os = "linux")]
fn peer_pid(fd: std::os::unix::io::RawFd) -> Option<u32> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // Safety: `cred`/`len` are valid out-params sized for SO_PEERCRED.
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    (rc == 0 && cred.pid > 0).then_some(cred.pid as u32)
}

#[cfg(target_os = "macos")]
fn peer_pid(fd: std::os::unix::io::RawFd) -> Option<u32> {
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // Safety: `pid`/`len` are valid out-params sized for LOCAL_PEERPID.
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut len,
        )
    };
    (rc == 0 && pid > 0).then_some(pid as u32)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn peer_pid(_fd: std::os::unix::io::RawFd) -> Option<u32> {
    None
}

#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    // Safety: signal 0 only checks that the pid exists and may be signalled.
    let exists = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
    exists && !is_zombie(pid)
}

/// An exited daemon reparented to init is a zombie until init reaps it; it is
/// already dead for our purposes.
#[cfg(target_os = "linux")]
fn is_zombie(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| {
            let after_comm = stat.rsplit_once(')')?.1;
            after_comm.split_whitespace().next().map(|s| s == "Z")
        })
        .unwrap_or(false)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn is_zombie(_pid: u32) -> bool {
    false
}

#[cfg(unix)]
pub fn kill_pid(pid: u32) {
    // Safety: SIGKILL to a pid just verified to be serving our own endpoint.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

/// PID of the process serving the named pipe `endpoint`.
///
/// Opens a client handle to the pipe and asks the OS for the server end's
/// process. While every instance is momentarily taken (`ERROR_PIPE_BUSY`, the
/// listener has not staged its next instance yet) it waits on
/// `WaitNamedPipeW` and retries — see [`retry_while_busy`].
#[cfg(windows)]
fn server_pid(endpoint: &str) -> std::io::Result<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;
    use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};

    let wide: Vec<u16> = endpoint.encode_utf16().chain(std::iter::once(0)).collect();
    let pipe = retry_while_busy(
        BUSY_RETRY_BUDGET,
        || {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(endpoint)
        },
        |e| e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32),
        || {
            // Safety: `wide` is a valid NUL-terminated UTF-16 string. Returns
            // as soon as an instance is free (or after 250 ms); the outcome is
            // re-checked by the next open, so the result is not needed.
            unsafe {
                WaitNamedPipeW(wide.as_ptr(), 250);
            }
        },
    )?;
    let mut pid: u32 = 0;
    // Safety: `pipe` is an open client handle to a named pipe; `pid` is a valid
    // out-param.
    let ok = unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as _, &mut pid) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    if pid == 0 {
        return Err(std::io::Error::other(format!(
            "no server PID reported for {endpoint}"
        )));
    }
    Ok(pid)
}

#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    // Safety: plain handle open/wait/close on a pid; a null handle means the
    // process is gone (or inaccessible, which a same-user daemon never is).
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let alive = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
        CloseHandle(handle);
        alive
    }
}

#[cfg(windows)]
pub fn kill_pid(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // Safety: terminate a pid just verified to be serving our own endpoint.
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

/// How long [`reap_spawned_daemon`] lets a daemon that is already shutting down
/// finish exiting before it falls back to SIGKILL. A clean exit takes
/// milliseconds; the bound only matters when something is wrong.
#[cfg(unix)]
pub const DAEMON_EXIT_GRACE: Duration = Duration::from_secs(10);

/// Stop a session daemon the test spawned itself (a `Child` serving the unix
/// socket at `socket_path`) without SIGKILLing one that is already exiting
/// (#3742).
///
/// Tests often end by closing the session (`connection.close`, `MSG_KILL`, the
/// shell exiting), which makes the daemon exit on its own — and then drop a
/// guard that SIGKILLs it. Under `cargo llvm-cov` the daemon writes its
/// `.profraw` coverage profile in an `atexit` handler, and a SIGKILL that lands
/// during that write leaves a truncated file: `llvm-profdata merge` then
/// rejects the whole coverage run with "file header is corrupt".
///
/// The daemon drops its listener when its run loop returns, before the process
/// exits, so a socket that refuses connections means "on its way out": wait for
/// it (bounded by [`DAEMON_EXIT_GRACE`]). A daemon still serving is idle, not
/// exiting, so it is killed at once, as before.
#[cfg(unix)]
pub fn reap_spawned_daemon(child: &mut std::process::Child, socket_path: &std::path::Path) {
    reap_spawned_daemon_within(child, socket_path, DAEMON_EXIT_GRACE);
}

#[cfg(unix)]
fn reap_spawned_daemon_within(
    child: &mut std::process::Child,
    socket_path: &std::path::Path,
    grace: Duration,
) {
    let running = matches!(child.try_wait(), Ok(None));
    if running && std::os::unix::net::UnixStream::connect(socket_path).is_err() {
        let deadline = Instant::now() + grace;
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    /// A daemon that stopped serving its socket is left to exit on its own.
    #[cfg(unix)]
    #[test]
    fn an_exiting_daemon_is_left_to_finish() {
        use std::os::unix::process::ExitStatusExt;
        let dir = tempfile::TempDir::new().expect("temp dir");
        // No listener at this path: the "daemon" is past its run loop.
        let socket = dir.path().join("gone.sock");
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 0.3; exit 7"])
            .spawn()
            .expect("spawn stand-in daemon");
        reap_spawned_daemon_within(&mut child, &socket, Duration::from_secs(10));
        let status = child.wait().expect("reaped status");
        assert_eq!(
            status.code(),
            Some(7),
            "must exit on its own, not be killed"
        );
        assert_eq!(status.signal(), None);
    }

    /// A daemon still serving its socket is idle, so it is killed at once.
    #[cfg(unix)]
    #[test]
    fn a_serving_daemon_is_killed_at_once() {
        use std::os::unix::process::ExitStatusExt;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("live.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind");
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn stand-in daemon");
        let started = Instant::now();
        reap_spawned_daemon_within(&mut child, &socket, Duration::from_secs(10));
        assert!(started.elapsed() < Duration::from_secs(5), "no grace wait");
        let status = child.wait().expect("reaped status");
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }

    fn busy(e: &Error) -> bool {
        e.kind() == ErrorKind::WouldBlock
    }

    #[test]
    fn a_busy_endpoint_is_retried_until_it_answers() {
        let mut attempts = 0;
        let mut waits = 0;
        let got = retry_while_busy(
            Duration::from_secs(5),
            || {
                attempts += 1;
                if attempts < 3 {
                    Err(Error::from(ErrorKind::WouldBlock))
                } else {
                    Ok(42)
                }
            },
            busy,
            || waits += 1,
        );
        assert_eq!(got.unwrap(), 42);
        assert_eq!((attempts, waits), (3, 2));
    }

    #[test]
    fn a_missing_endpoint_fails_at_once() {
        let mut attempts = 0;
        let got: std::io::Result<u32> = retry_while_busy(
            Duration::from_secs(5),
            || {
                attempts += 1;
                Err(Error::from(ErrorKind::NotFound))
            },
            busy,
            || {},
        );
        assert_eq!(got.unwrap_err().kind(), ErrorKind::NotFound);
        assert_eq!(attempts, 1);
    }

    #[test]
    fn an_endpoint_busy_past_the_budget_reports_busy() {
        let got: std::io::Result<u32> = retry_while_busy(
            Duration::from_millis(30),
            || Err(Error::from(ErrorKind::WouldBlock)),
            busy,
            || std::thread::sleep(Duration::from_millis(5)),
        );
        assert_eq!(got.unwrap_err().kind(), ErrorKind::WouldBlock);
    }
}
