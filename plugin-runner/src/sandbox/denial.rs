//! Kernel denial reports (#4236): system calls the OS sandbox refused, as the
//! runner forwards them to the host.
//!
//! On Linux the seccomp filter answers the "soft" denials (`socket`,
//! `connect`, …) with `SECCOMP_RET_TRAP`; the runner's `SIGSYS` handler makes
//! the call fail with `EPERM` exactly as before and counts it. A reporter
//! thread drains the counts once per [`REPORT_INTERVAL`] into one
//! `Denied{syscall}` [`Log`] frame per system call, so a plugin calling
//! `socket` in a tight loop costs the host one frame per second, not one per
//! call (the rate limit). The host checks the name against
//! [`REPORTED_SYSCALLS`] and records the denial next to the capability-bridge
//! denials.
//!
//! Everything here is plain data shared by the host and the runner; the
//! signal handler itself lives in the Linux sandbox module.

use std::time::Duration;

use termihub_plugin_api::PluginLogLevel;

use crate::ipc::{Log, SyscallDenial};

/// The system calls whose denials are reported, by name. The Linux runner
/// traps exactly these (its `trapped` seccomp filter); the host refuses a
/// report naming anything else.
pub const REPORTED_SYSCALLS: &[&str] = &[
    "socket",
    "connect",
    "bind",
    "listen",
    "open_by_handle_at",
    "ioctl",
    "kill",
    "tgkill",
    "prlimit64",
];

/// How often the runner drains the denial counts. Each system call is
/// reported at most once per interval, with the number of refused calls.
pub const REPORT_INTERVAL: Duration = Duration::from_secs(1);

/// The static name for `name` if it is a [`REPORTED_SYSCALLS`] entry.
#[must_use]
pub fn reported_syscall(name: &str) -> Option<&'static str> {
    REPORTED_SYSCALLS.iter().copied().find(|s| *s == name)
}

/// The `Log` frame reporting `count` refused calls of `syscall`. The message
/// is what an older host (which ignores [`Log::denied`]) logs.
#[must_use]
pub fn denial_log(syscall: &str, count: u32) -> Log {
    let calls = if count == 1 { "call" } else { "calls" };
    Log {
        session_id: None,
        level: PluginLogLevel::Warn.as_wire(),
        message: format!(
            "Denied{{syscall: {syscall}}}: the OS sandbox refused {count} {calls} with EPERM"
        ),
        truncated: false,
        denied: Some(SyscallDenial {
            syscall: syscall.to_owned(),
            count,
        }),
    }
}

/// Turn one drained snapshot of `(syscall, count)` pairs into report frames:
/// one per system call that was refused at least once since the last drain.
#[must_use]
pub fn reports<'a>(snapshot: impl IntoIterator<Item = (&'a str, u32)>) -> Vec<Log> {
    snapshot
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .map(|(syscall, count)| denial_log(syscall, count))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reported_names_are_unique_and_resolvable() {
        for (i, name) in REPORTED_SYSCALLS.iter().enumerate() {
            assert!(!REPORTED_SYSCALLS[..i].contains(name), "duplicate {name}");
            assert_eq!(reported_syscall(name), Some(*name));
        }
        assert_eq!(reported_syscall("execve"), None);
        assert_eq!(reported_syscall(""), None);
    }

    #[test]
    fn a_snapshot_becomes_one_frame_per_denied_call() {
        let frames = reports([("socket", 3), ("connect", 0), ("bind", 1)]);
        assert_eq!(frames.len(), 2);
        let socket = frames[0].denied.as_ref().unwrap();
        assert_eq!((socket.syscall.as_str(), socket.count), ("socket", 3));
        assert!(frames[0].message.starts_with("Denied{syscall: socket}"));
        assert!(frames[0].message.contains("3 calls"));
        assert!(frames[1].message.contains("1 call with"));
        assert_eq!(frames[0].session_id, None);
        assert_eq!(frames[0].level, PluginLogLevel::Warn.as_wire());
        assert!(reports([("socket", 0)]).is_empty());
    }
}
