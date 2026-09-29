//! Cross-platform "is the process that wrote this file still alive?" probe.
//!
//! Used to garbage-collect the per-process `--stdio` update auth token files
//! (`<config>/instance-auth/<pid>.token`, #3744) that a crashed agent leaves
//! behind. The probe is deliberately **conservative**: it only reports a file's
//! owner as gone when it can tell — the pid does not exist, belongs to another
//! user, or was started *after* the file was written (pid reuse). Anything it
//! cannot interpret counts as "maybe alive", so a live agent's token is never
//! removed.

use std::time::{Duration, SystemTime};

/// Tolerance when comparing a process's start time with a file's mtime. Start
/// times are coarse on some platforms (Linux derives them from a whole-second
/// boot time), so a process is only treated as a *reused* pid when it started
/// clearly after the file was last written.
const START_TIME_SLACK: Duration = Duration::from_secs(5);

/// What the platform could tell about a pid.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProcessProbe {
    /// No such process (or a zombie awaiting reaping).
    Gone,
    /// The pid is alive but runs as another user — it cannot be this user's agent.
    NotOurs,
    /// A process of this user runs under the pid; its start time when known.
    Running { started: Option<SystemTime> },
    /// The probe failed in a way it cannot interpret.
    Unknown,
}

/// Whether the process that wrote a token file named after `pid` may still be
/// alive. `written` is the file's last-modified time, when known.
///
/// Returns `false` only when the owner is provably gone: the pid does not
/// exist, belongs to another user, or started after `written` (so it is a
/// different process that reused the pid). Every other case returns `true`.
pub(crate) fn owner_may_be_live(pid: u32, written: Option<SystemTime>) -> bool {
    match probe(pid) {
        ProcessProbe::Gone | ProcessProbe::NotOurs => false,
        ProcessProbe::Unknown => true,
        ProcessProbe::Running { started } => match (started, written) {
            (Some(started), Some(written)) => started <= written + START_TIME_SLACK,
            _ => true,
        },
    }
}

/// Probe `pid` on this platform.
pub(crate) fn probe(pid: u32) -> ProcessProbe {
    imp::probe(pid)
}

#[cfg(unix)]
mod imp {
    use super::ProcessProbe;

    pub(super) fn probe(pid: u32) -> ProcessProbe {
        // pid 0 / negative values address process groups in kill(2); no agent
        // ever has such a pid, so a file named after one is not a live agent's.
        let raw = match libc::pid_t::try_from(pid) {
            Ok(raw) if raw > 0 => raw,
            _ => return ProcessProbe::Gone,
        };
        // Safety: signal 0 only checks that the pid exists and may be signalled.
        if unsafe { libc::kill(raw, 0) } != 0 {
            return match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::ESRCH) => ProcessProbe::Gone,
                // Exists, but we may not signal it: another user's process.
                Some(libc::EPERM) => ProcessProbe::NotOurs,
                _ => ProcessProbe::Unknown,
            };
        }
        platform::inspect(raw)
    }

    #[cfg(target_os = "linux")]
    mod platform {
        use super::ProcessProbe;
        use std::os::unix::fs::MetadataExt;
        use std::time::{Duration, SystemTime, UNIX_EPOCH};

        pub(super) fn inspect(pid: libc::pid_t) -> ProcessProbe {
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
                return ProcessProbe::Running { started: None };
            };
            // Fields after the parenthesised comm start at field 3 (state).
            let fields: Vec<&str> = match stat.rsplit_once(')') {
                Some((_, rest)) => rest.split_whitespace().collect(),
                None => return ProcessProbe::Running { started: None },
            };
            if fields.first() == Some(&"Z") {
                return ProcessProbe::Gone;
            }
            if let Ok(meta) = std::fs::metadata(format!("/proc/{pid}")) {
                // Safety: geteuid has no preconditions and cannot fail.
                if meta.uid() != unsafe { libc::geteuid() } {
                    return ProcessProbe::NotOurs;
                }
            }
            // Field 22 (starttime, clock ticks since boot) → index 19 here.
            let started = fields
                .get(19)
                .and_then(|t| t.parse::<u64>().ok())
                .and_then(|ticks| {
                    let boot = boot_time()?;
                    // Safety: sysconf has no preconditions.
                    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
                    let hz = u64::try_from(hz).ok().filter(|&hz| hz > 0)?;
                    let since_boot = Duration::from_secs(ticks / hz)
                        + Duration::from_nanos((ticks % hz) * 1_000_000_000 / hz);
                    Some(boot + since_boot)
                });
            ProcessProbe::Running { started }
        }

        /// System boot time from the `btime` line of `/proc/stat`.
        fn boot_time() -> Option<SystemTime> {
            let stat = std::fs::read_to_string("/proc/stat").ok()?;
            let secs = stat
                .lines()
                .find_map(|l| l.strip_prefix("btime "))?
                .trim()
                .parse::<u64>()
                .ok()?;
            Some(UNIX_EPOCH + Duration::from_secs(secs))
        }
    }

    #[cfg(target_os = "macos")]
    mod platform {
        use super::ProcessProbe;
        use std::time::{Duration, UNIX_EPOCH};

        /// `SZOMB` from `<sys/proc.h>`.
        const SZOMB: u32 = 5;

        pub(super) fn inspect(pid: libc::pid_t) -> ProcessProbe {
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
            // Safety: `info` is a properly sized, writable proc_bsdinfo buffer.
            let n = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    size,
                )
            };
            if n != size {
                return ProcessProbe::Running { started: None };
            }
            if info.pbi_status == SZOMB {
                return ProcessProbe::Gone;
            }
            // Safety: geteuid has no preconditions and cannot fail.
            if info.pbi_uid != unsafe { libc::geteuid() } {
                return ProcessProbe::NotOurs;
            }
            let started = UNIX_EPOCH
                + Duration::from_secs(info.pbi_start_tvsec)
                + Duration::from_micros(info.pbi_start_tvusec);
            ProcessProbe::Running {
                started: Some(started),
            }
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    mod platform {
        use super::ProcessProbe;

        /// No portable start-time / owner query: liveness only.
        pub(super) fn inspect(_pid: libc::pid_t) -> ProcessProbe {
            ProcessProbe::Running { started: None }
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::ProcessProbe;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME,
        STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// 100 ns intervals between 1601-01-01 (FILETIME epoch) and 1970-01-01.
    const FILETIME_UNIX_OFFSET: u64 = 116_444_736_000_000_000;

    pub(super) fn probe(pid: u32) -> ProcessProbe {
        if pid == 0 {
            return ProcessProbe::Gone;
        }
        // Safety: plain open/query/close on a process handle; every out
        // pointer refers to a live local.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return match GetLastError() {
                    ERROR_INVALID_PARAMETER => ProcessProbe::Gone,
                    // A same-user process is always queryable; denial means
                    // another user's (or a protected) process.
                    ERROR_ACCESS_DENIED => ProcessProbe::NotOurs,
                    _ => ProcessProbe::Unknown,
                };
            }
            let mut code = 0u32;
            let exited = GetExitCodeProcess(handle, &mut code) != 0 && code != STILL_ACTIVE as u32;
            let zero = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let (mut created, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
            let times_ok =
                GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) != 0;
            CloseHandle(handle);
            if exited {
                return ProcessProbe::Gone;
            }
            let started = if times_ok {
                filetime_to_system_time(created)
            } else {
                None
            };
            ProcessProbe::Running { started }
        }
    }

    fn filetime_to_system_time(ft: FILETIME) -> Option<SystemTime> {
        let ticks = (u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime);
        let since_unix = ticks.checked_sub(FILETIME_UNIX_OFFSET)?;
        Some(UNIX_EPOCH + Duration::from_nanos(since_unix.saturating_mul(100)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    #[test]
    fn own_process_is_running() {
        assert!(matches!(
            probe(std::process::id()),
            ProcessProbe::Running { .. }
        ));
        assert!(owner_may_be_live(
            std::process::id(),
            Some(SystemTime::now())
        ));
        assert!(owner_may_be_live(std::process::id(), None));
    }

    #[test]
    fn pid_zero_is_never_a_live_agent() {
        assert_eq!(probe(0), ProcessProbe::Gone);
        assert!(!owner_may_be_live(0, None));
    }

    #[test]
    fn exited_child_is_gone() {
        #[cfg(unix)]
        let mut child = std::process::Command::new("true").spawn().unwrap();
        #[cfg(windows)]
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit"])
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        let probed = probe(pid);
        // The pid could in theory be reused by a brand-new process between
        // wait() and the probe; then it is running, not unknown.
        assert!(
            matches!(probed, ProcessProbe::Gone | ProcessProbe::Running { .. }),
            "unexpected probe result {probed:?}"
        );
        if probed == ProcessProbe::Gone {
            assert!(!owner_may_be_live(pid, Some(SystemTime::now())));
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn own_start_time_is_known_and_in_the_past() {
        let ProcessProbe::Running {
            started: Some(started),
        } = probe(std::process::id())
        else {
            panic!("start time must be known on this platform");
        };
        assert!(started <= SystemTime::now() + START_TIME_SLACK);
        assert!(started > UNIX_EPOCH);
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn reused_pid_started_after_the_file_was_written_is_not_the_owner() {
        // A token file last written in 1970 cannot belong to this process,
        // even though the pid is alive: the pid was reused.
        assert!(!owner_may_be_live(std::process::id(), Some(UNIX_EPOCH)));
    }
}
