//! Following a local shell's directory from the process it runs in (#5009).
//!
//! The local backend owns the shell's PTY, so the directory comes straight
//! from the operating system: the PTY's foreground process (the shell at its
//! prompt, or a nested shell) or, where that is unknown, the shell itself.
//! [`sysinfo`] reads it on Linux (`/proc/<pid>/cwd`), macOS
//! (`proc_pidinfo`) and Windows (the process parameters). The
//! [`CwdFollower`](crate::session::cwd_follow::CwdFollower) decides when;
//! [`CwdFollowThread`](super::cwd_follow_thread::CwdFollowThread) runs it on
//! the session's output.

use std::time::Duration;

/// A local read is cheap (one syscall), so it may run this often.
pub(crate) const MIN_INTERVAL: Duration = Duration::from_millis(250);

/// The working directory of process `pid`, from the operating system.
pub(crate) fn process_cwd(pid: u32) -> Option<String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        false,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );
    let cwd = system.process(pid)?.cwd()?;
    Some(cwd.to_string_lossy().into_owned()).filter(|c| !c.is_empty())
}
