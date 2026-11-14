//! The remote shell's exit status on an interactive SSH session (#5801).
//!
//! When the remote shell exits, the server sends an `exit-status` channel
//! request (RFC 4254 §6.10), or `exit-signal` when a signal killed it. The
//! shell channel task records it in a [`ShellExitSlot`] before the reader sees
//! the end, so [`exit_code`](crate::connection::ConnectionType::exit_code)
//! reports it once the session owner sees the output end: `exit 5` on an SSH
//! tab reads "[Process exited with code 5]" and is never reconnected.
//!
//! OpenSSH sends the shell's EOF **before** its `exit-status`, and the channel
//! close after it. So once the channel reports EOF, the task keeps reading for
//! up to [`EXIT_STATUS_GRACE`] until the close (or the status) arrives.
//!
//! A transport loss carries no status: the channel just goes away. The slot
//! stays empty, the end cause reads `IoError`, and a resilient tab still
//! reconnects. A signal that a host shutting down or hanging up delivers
//! ([`signal_reports_no_status`]) reports no status either, for the same
//! reason: the user did not end that shell.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use russh::ChannelMsg;

use super::exec::{exit_status_to_i32, russh_signal_name, signal_exit_status};

/// How long after the shell channel's EOF the task waits for its exit status
/// or its close. OpenSSH sends both right after the EOF; the wait only has to
/// absorb network latency. A link that dies in between ends it sooner.
pub(crate) const EXIT_STATUS_GRACE: Duration = Duration::from_secs(2);

/// The remote shell's exit status, shared by the shell channel task (which
/// records it) and the backend (which reports it). The first status wins.
#[derive(Clone, Debug, Default)]
pub struct ShellExitSlot(Arc<Mutex<Option<i32>>>);

impl ShellExitSlot {
    /// An empty slot.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record `status` unless a status is already recorded.
    pub fn record(&self, status: i32) {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.is_none() {
            *slot = Some(status);
        }
    }

    /// The recorded status, if any.
    pub fn get(&self) -> Option<i32> {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// What a channel message says about the shell's exit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShellExit {
    /// Not about the shell's exit.
    Unrelated,
    /// The shell exited with this status (`exit-status`, or a signal's
    /// conventional `128 + signum`).
    Status(i32),
    /// The shell was killed by a signal that reports no status
    /// ([`signal_reports_no_status`]).
    NoStatus,
}

/// Classify a channel message: an `exit-status` is the shell's status, an
/// `exit-signal` its conventional `128 + signum` (`KILL` → 137) unless the
/// signal [reports no status](signal_reports_no_status).
pub(crate) fn shell_exit_of(msg: &ChannelMsg) -> ShellExit {
    match msg {
        ChannelMsg::ExitStatus { exit_status } => {
            ShellExit::Status(exit_status_to_i32(*exit_status))
        }
        ChannelMsg::ExitSignal { signal_name, .. } => {
            let name = russh_signal_name(signal_name);
            if signal_reports_no_status(&name) {
                ShellExit::NoStatus
            } else {
                ShellExit::Status(signal_exit_status(&name))
            }
        }
        _ => ShellExit::Unrelated,
    }
}

/// Whether a shell killed by `signal_name` reports no exit status.
///
/// `HUP` and `TERM` are what a host that shuts down, reboots or hangs up the
/// session delivers. Reporting `129` / `143` would read as the user ending the
/// shell and keep a resilient tab from reconnecting once the host is back, so
/// those report none and the end cause decides. Any other signal (a crash such
/// as `SEGV`, or `KILL`) is the shell's own death and reports `128 + signum`.
pub(crate) fn signal_reports_no_status(signal_name: &str) -> bool {
    matches!(signal_name, "HUP" | "TERM")
}

/// Whether the channel task, which has seen the channel's EOF, has read
/// everything it waits for: the close, the channel going away, or the status.
pub(crate) fn ends_the_exit_wait(msg: Option<&ChannelMsg>) -> bool {
    match msg {
        None | Some(ChannelMsg::Close) => true,
        Some(msg) => shell_exit_of(msg) != ShellExit::Unrelated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal(sig: russh::Sig) -> ChannelMsg {
        ChannelMsg::ExitSignal {
            signal_name: sig,
            core_dumped: false,
            error_message: String::new(),
            lang_tag: String::new(),
        }
    }

    #[test]
    fn exit_status_is_the_shells_status() {
        assert_eq!(
            shell_exit_of(&ChannelMsg::ExitStatus { exit_status: 5 }),
            ShellExit::Status(5)
        );
        assert_eq!(
            shell_exit_of(&ChannelMsg::ExitStatus { exit_status: 0 }),
            ShellExit::Status(0)
        );
    }

    #[test]
    fn an_out_of_range_status_saturates_and_stays_non_zero() {
        assert_eq!(
            shell_exit_of(&ChannelMsg::ExitStatus {
                exit_status: u32::MAX
            }),
            ShellExit::Status(i32::MAX)
        );
    }

    #[test]
    fn a_crash_signal_is_128_plus_signum() {
        assert_eq!(
            shell_exit_of(&signal(russh::Sig::KILL)),
            ShellExit::Status(137)
        );
        assert_eq!(
            shell_exit_of(&signal(russh::Sig::SEGV)),
            ShellExit::Status(139)
        );
        assert_eq!(
            shell_exit_of(&signal(russh::Sig::INT)),
            ShellExit::Status(130)
        );
        assert_eq!(
            shell_exit_of(&signal(russh::Sig::Custom("WINCH".into()))),
            ShellExit::Status(128)
        );
    }

    #[test]
    fn a_hangup_or_terminate_signal_reports_no_status() {
        assert_eq!(shell_exit_of(&signal(russh::Sig::HUP)), ShellExit::NoStatus);
        assert_eq!(
            shell_exit_of(&signal(russh::Sig::TERM)),
            ShellExit::NoStatus
        );
    }

    #[test]
    fn other_messages_say_nothing_about_the_exit() {
        assert_eq!(shell_exit_of(&ChannelMsg::Eof), ShellExit::Unrelated);
        assert_eq!(shell_exit_of(&ChannelMsg::Close), ShellExit::Unrelated);
        assert_eq!(
            shell_exit_of(&ChannelMsg::Data {
                data: b"exit 5".to_vec().into()
            }),
            ShellExit::Unrelated
        );
    }

    #[test]
    fn the_exit_wait_ends_on_close_status_or_a_lost_channel() {
        assert!(ends_the_exit_wait(None));
        assert!(ends_the_exit_wait(Some(&ChannelMsg::Close)));
        assert!(ends_the_exit_wait(Some(&ChannelMsg::ExitStatus {
            exit_status: 3
        })));
        assert!(ends_the_exit_wait(Some(&signal(russh::Sig::HUP))));
        assert!(!ends_the_exit_wait(Some(&ChannelMsg::Eof)));
        assert!(!ends_the_exit_wait(Some(&ChannelMsg::WindowAdjusted {
            new_size: 1
        })));
    }

    #[test]
    fn the_first_recorded_status_wins() {
        let slot = ShellExitSlot::new();
        assert_eq!(slot.get(), None);
        slot.record(5);
        slot.record(0);
        assert_eq!(slot.get(), Some(5));
        assert_eq!(slot.clone().get(), Some(5), "clones share the slot");
    }
}
