//! Parent-death guard for agent processes a suite spawns (#3641).
//!
//! If the test binary is killed (Ctrl-C, CI timeout, IDE stop) its drop guards
//! never run, and a spawned `--listen` worker — plus the session and registry
//! daemons it spawned — would be re-parented to init/launchd and live on. Every
//! suite that spawns an agent calls [`GuardedSpawn::spawn_guarded`] instead of
//! `spawn()`, which applies [`guard`] before spawning and [`adopt`] right after:
//!
//! - **All platforms:** [`guard`] sets `TERMIHUB_TEST_PARENT_PID` to this test
//!   process's PID. The agent (see `agent/src/test_parent_watchdog.rs`) then
//!   watches that PID and exits once it is gone; daemons it spawns inherit the
//!   variable and do the same. The agent ignores the variable when unset, so
//!   production is unaffected.
//! - **Windows, additionally:** [`adopt`] assigns the child to a process-wide
//!   Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The job handle is
//!   only closed when this process exits, however it exits, and the kernel then
//!   kills every process in the job — including the detached daemons the agent
//!   spawned afterwards, which inherit the job.
//!
//! Linux `PR_SET_PDEATHSIG` is deliberately not used: it fires when the
//! spawning *thread* exits, and libtest runs each test on its own thread, so it
//! would kill an agent as soon as the test that spawned it returned rather than
//! when the process dies. The PID watch is process-level.

#![allow(dead_code)]

use std::process::{Child, Command};

/// Env var the agent's test-only watchdog reads; mirrors
/// `test_parent_watchdog::PARENT_PID_ENV` in the agent binary.
pub const PARENT_PID_ENV: &str = "TERMIHUB_TEST_PARENT_PID";

/// Tell the agent `cmd` will spawn to exit when this test process dies.
pub fn guard(cmd: &mut Command) -> &mut Command {
    cmd.env(PARENT_PID_ENV, std::process::id().to_string())
}

/// `Command::spawn` with [`guard`] applied before and [`adopt`] after — the one
/// call a suite makes in place of `spawn()` for every agent it starts.
pub trait GuardedSpawn {
    fn spawn_guarded(&mut self) -> std::io::Result<Child>;
}

impl GuardedSpawn for Command {
    fn spawn_guarded(&mut self) -> std::io::Result<Child> {
        let child = guard(self).spawn()?;
        adopt(&child);
        Ok(child)
    }
}

/// Put a freshly spawned agent into this process's kill-on-close Job Object
/// (Windows). A no-op elsewhere, where [`guard`]'s PID watch is the mechanism.
#[cfg(not(windows))]
pub fn adopt(_child: &Child) {}

#[cfg(windows)]
pub fn adopt(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

    let Some(job) = kill_on_close_job() else {
        return;
    };
    // Safety: `job` is a live job handle owned by this process for its whole
    // lifetime; the child's handle is valid while `child` is borrowed. Failure
    // (e.g. the child already exited) leaves the PID watch as the guard.
    unsafe {
        AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
    }
}

/// The process-wide Job Object, created on first use. Its handle is never
/// closed explicitly: it closes when this process exits, which is exactly the
/// event that should kill the job's processes. Stored as `usize` because a raw
/// `HANDLE` is not `Sync`.
#[cfg(windows)]
fn kill_on_close_job() -> Option<usize> {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    static JOB: OnceLock<Option<usize>> = OnceLock::new();
    *JOB.get_or_init(|| {
        // Safety: an anonymous job with default security; `info` is a
        // zero-initialised plain-old-data struct of the size we pass.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(job);
                return None;
            }
            Some(job as usize)
        }
    })
}
