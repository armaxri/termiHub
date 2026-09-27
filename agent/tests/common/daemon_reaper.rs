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

#![allow(dead_code)]

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
        if pid_alive(self.pid) && server_pid(&self.endpoint) == Some(self.pid) {
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

/// PID of the process serving the unix socket at `endpoint`.
#[cfg(unix)]
fn server_pid(endpoint: &str) -> Option<u32> {
    use std::os::unix::io::AsRawFd;
    let stream = std::os::unix::net::UnixStream::connect(endpoint).ok()?;
    peer_pid(stream.as_raw_fd())
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
fn pid_alive(pid: u32) -> bool {
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
fn kill_pid(pid: u32) {
    // Safety: SIGKILL to a pid just verified to be serving our own endpoint.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

/// PID of the process serving the named pipe `endpoint`.
#[cfg(windows)]
fn server_pid(endpoint: &str) -> Option<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    let pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(endpoint)
        .ok()?;
    let mut pid: u32 = 0;
    // Safety: `pipe` is an open client handle to a named pipe; `pid` is a valid
    // out-param.
    let ok = unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as _, &mut pid) };
    (ok != 0 && pid != 0).then_some(pid)
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
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
fn kill_pid(pid: u32) {
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
