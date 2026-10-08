//! Why a plugin runner ended, and the crash budget that decides what happens
//! next (#4184, concept "Crash isolation and restart policy").
//!
//! * [`RunnerExitCause`] — the cause the host records for every runner exit:
//!   a host-initiated stop, or one of the failure kinds the UI phase turns into
//!   the matching overlay (crash, not responding, out of memory, invalid data).
//! * [`CrashBudget`] — the existing [`RestartTracker`] plus the concept's
//!   10-minute reset window: three crashes are restarted, the fourth within the
//!   window auto-disables the plugin.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::plugin::security::{RecoveryAction, RestartTracker, MAX_RESTART_ATTEMPTS};

/// Default window after which a crash-free plugin's budget resets.
pub const DEFAULT_CRASH_WINDOW: Duration = Duration::from_secs(10 * 60);

/// Why a runner process ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunnerExitCause {
    /// The host stopped it (unload, idle reap, quit). Not a failure.
    Stopped,
    /// It exited on its own or was killed by a signal it did not get from the
    /// host (segfault, abort, `exit`, an external kill).
    #[serde(rename_all = "camelCase")]
    Crashed {
        /// The terminating signal (Unix).
        signal: Option<i32>,
        /// The exit code, when it exited normally.
        exit_code: Option<i32>,
    },
    /// It stopped answering pings or missed a call deadline and was killed.
    NotResponding,
    /// It exceeded its memory limit (the host's resident-size watchdog, or an
    /// allocation failure under `RLIMIT_AS`).
    OutOfMemory,
    /// It sent malformed or protocol-violating data and was killed.
    #[serde(rename_all = "camelCase")]
    InvalidData {
        /// What was wrong with it (diagnostics).
        detail: String,
    },
}

impl RunnerExitCause {
    /// Whether this exit counts against the plugin's crash budget (everything
    /// except a host-initiated stop).
    #[must_use]
    pub fn is_failure(&self) -> bool {
        !matches!(self, RunnerExitCause::Stopped)
    }

    /// One line for the log and the crash overlay's detail box.
    #[must_use]
    pub fn describe(&self) -> String {
        match self {
            RunnerExitCause::Stopped => "the plugin process was stopped".to_owned(),
            RunnerExitCause::Crashed {
                signal: Some(signal),
                ..
            } => match signal_name(*signal) {
                Some(name) => format!("plugin process exited: signal {name}"),
                None => format!("plugin process exited: signal {signal}"),
            },
            RunnerExitCause::Crashed {
                exit_code: Some(code),
                ..
            } => format!("plugin process exited with code {code}"),
            RunnerExitCause::Crashed { .. } => "plugin process exited".to_owned(),
            RunnerExitCause::NotResponding => "the plugin stopped responding".to_owned(),
            RunnerExitCause::OutOfMemory => "the plugin used too much memory".to_owned(),
            RunnerExitCause::InvalidData { detail } => {
                format!("the plugin sent invalid data: {detail}")
            }
        }
    }

    /// Classify an exit the host did not cause from the process status.
    /// `out_of_memory` is set when the runner reported a failed allocation
    /// before it died (a plugin aborting under `RLIMIT_AS`).
    #[must_use]
    pub(super) fn from_status(
        status: Option<std::process::ExitStatus>,
        out_of_memory: bool,
    ) -> Self {
        if out_of_memory {
            return RunnerExitCause::OutOfMemory;
        }
        let Some(status) = status else {
            return RunnerExitCause::Crashed {
                signal: None,
                exit_code: None,
            };
        };
        #[cfg(unix)]
        let signal = std::os::unix::process::ExitStatusExt::signal(&status);
        #[cfg(not(unix))]
        let signal = None;
        RunnerExitCause::Crashed {
            signal,
            exit_code: status.code(),
        }
    }
}

/// The conventional name of a terminating signal, for the overlay text.
#[must_use]
fn signal_name(signal: i32) -> Option<&'static str> {
    #[cfg(unix)]
    {
        let name = match signal {
            libc::SIGSEGV => "SIGSEGV (segmentation fault)",
            libc::SIGABRT => "SIGABRT (abort)",
            libc::SIGBUS => "SIGBUS (bus error)",
            libc::SIGILL => "SIGILL (illegal instruction)",
            libc::SIGFPE => "SIGFPE (arithmetic error)",
            libc::SIGKILL => "SIGKILL (killed)",
            libc::SIGTERM => "SIGTERM (terminated)",
            libc::SIGTRAP => "SIGTRAP (trap)",
            _ => return None,
        };
        Some(name)
    }
    #[cfg(not(unix))]
    {
        let _ = signal;
        None
    }
}

/// The reason persisted and shown when the budget is spent.
#[must_use]
pub fn auto_disable_reason() -> String {
    format!("Disabled after {MAX_RESTART_ATTEMPTS} crashes")
}

/// A plugin's crash budget: [`RestartTracker`] plus a reset after a
/// crash-free window.
#[derive(Debug, Clone)]
pub struct CrashBudget {
    tracker: RestartTracker,
    window: Duration,
    last_crash: Option<Instant>,
}

impl CrashBudget {
    /// A full budget of [`MAX_RESTART_ATTEMPTS`] that resets after `window`
    /// without a crash.
    #[must_use]
    pub fn new(window: Duration) -> Self {
        Self {
            tracker: RestartTracker::new(),
            window,
            last_crash: None,
        }
    }

    /// Record a crash at `now`: [`RecoveryAction::Restart`] while the budget
    /// lasts, [`RecoveryAction::Disable`] for the crash that exceeds it.
    pub fn record_crash(&mut self, now: Instant) -> RecoveryAction {
        if self
            .last_crash
            .is_some_and(|last| now.saturating_duration_since(last) >= self.window)
            && !self.tracker.is_disabled()
        {
            self.tracker.record_success();
        }
        self.last_crash = Some(now);
        self.tracker.record_failure()
    }

    /// Crashes counted in the current window (0 when healthy).
    #[must_use]
    pub fn crashes(&self) -> u32 {
        match self.tracker.state() {
            crate::plugin::security::RecoveryState::Healthy => 0,
            crate::plugin::security::RecoveryState::Recovering { attempts } => attempts,
            crate::plugin::security::RecoveryState::Disabled => MAX_RESTART_ATTEMPTS + 1,
        }
    }

    /// Whether the budget is spent.
    #[must_use]
    pub fn is_exhausted(&self) -> bool {
        self.tracker.is_disabled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_crashes_restart_and_the_fourth_disables() {
        let mut budget = CrashBudget::new(DEFAULT_CRASH_WINDOW);
        let t0 = Instant::now();
        for n in 1..=MAX_RESTART_ATTEMPTS {
            let at = t0 + Duration::from_secs(u64::from(n));
            assert_eq!(budget.record_crash(at), RecoveryAction::Restart);
            assert_eq!(budget.crashes(), n);
        }
        assert_eq!(
            budget.record_crash(t0 + Duration::from_secs(60)),
            RecoveryAction::Disable
        );
        assert!(budget.is_exhausted());
        // A spent budget stays spent, even after the window.
        assert_eq!(
            budget.record_crash(t0 + Duration::from_secs(3600)),
            RecoveryAction::Disable
        );
    }

    #[test]
    fn the_budget_resets_after_a_crash_free_window() {
        let window = Duration::from_secs(600);
        let mut budget = CrashBudget::new(window);
        let t0 = Instant::now();
        for n in 0..MAX_RESTART_ATTEMPTS {
            assert_eq!(
                budget.record_crash(t0 + Duration::from_secs(u64::from(n))),
                RecoveryAction::Restart
            );
        }
        // Ten minutes after the last crash the count starts over.
        let later = t0 + Duration::from_secs(2) + window;
        assert_eq!(budget.record_crash(later), RecoveryAction::Restart);
        assert_eq!(budget.crashes(), 1);
    }

    #[test]
    fn only_a_host_stop_is_not_a_failure() {
        assert!(!RunnerExitCause::Stopped.is_failure());
        assert!(RunnerExitCause::NotResponding.is_failure());
        assert!(RunnerExitCause::OutOfMemory.is_failure());
        assert!(RunnerExitCause::InvalidData { detail: "x".into() }.is_failure());
        assert!(RunnerExitCause::Crashed {
            signal: Some(11),
            exit_code: None
        }
        .is_failure());
    }

    #[cfg(unix)]
    #[test]
    fn exit_statuses_are_classified() {
        use std::os::unix::process::ExitStatusExt;
        let segv = std::process::ExitStatus::from_raw(libc::SIGSEGV);
        let cause = RunnerExitCause::from_status(Some(segv), false);
        assert_eq!(
            cause,
            RunnerExitCause::Crashed {
                signal: Some(libc::SIGSEGV),
                exit_code: None
            }
        );
        assert_eq!(
            cause.describe(),
            "plugin process exited: signal SIGSEGV (segmentation fault)"
        );
        let code7 = std::process::ExitStatus::from_raw(7 << 8);
        assert_eq!(
            RunnerExitCause::from_status(Some(code7), false).describe(),
            "plugin process exited with code 7"
        );
        let abort = std::process::ExitStatus::from_raw(libc::SIGABRT);
        assert_eq!(
            RunnerExitCause::from_status(Some(abort), true),
            RunnerExitCause::OutOfMemory
        );
    }

    /// Windows: no signals; an exception or a kill shows as the exit code.
    #[cfg(windows)]
    #[test]
    fn exit_statuses_are_classified() {
        use std::os::windows::process::ExitStatusExt;
        let killed = std::process::ExitStatus::from_raw(1);
        assert_eq!(
            RunnerExitCause::from_status(Some(killed), false),
            RunnerExitCause::Crashed {
                signal: None,
                exit_code: Some(1)
            }
        );
        assert_eq!(
            RunnerExitCause::from_status(Some(killed), false).describe(),
            "plugin process exited with code 1"
        );
        let abort = std::process::ExitStatus::from_raw(0xC000_0409);
        assert_eq!(
            RunnerExitCause::from_status(Some(abort), true),
            RunnerExitCause::OutOfMemory
        );
    }

    #[test]
    fn causes_serialize_with_a_kind_tag() {
        let json = serde_json::to_value(RunnerExitCause::Crashed {
            signal: Some(6),
            exit_code: None,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "crashed", "signal": 6, "exitCode": null })
        );
        assert_eq!(
            serde_json::to_value(RunnerExitCause::NotResponding).unwrap(),
            serde_json::json!({ "kind": "notResponding" })
        );
        assert_eq!(auto_disable_reason(), "Disabled after 3 crashes");
    }
}
