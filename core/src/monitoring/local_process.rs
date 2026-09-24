//! Local-machine process listing + termination via `sysinfo` (PROD-0028).
//!
//! [`LocalProcessManager`] implements [`ProcessManager`] for the machine the
//! process runs on. It is used by the desktop's local-shell backend and by the
//! agent for its own host, mirroring how [`LocalCollector`](super::LocalCollector)
//! backs local monitoring.
//!
//! Cross-platform: `sysinfo` lists processes uniformly on every platform. Kill
//! is the one place platforms diverge — Unix delivers the real signal
//! (SIGTERM/SIGKILL) via [`sysinfo::Process::kill_with`]; Windows has no POSIX
//! signals, so both [`KillSignal`] variants terminate the process
//! ([`sysinfo::Process::kill`], which calls `TerminateProcess`). The mapping is
//! isolated in small, unit-tested functions so the "right signal to the right
//! pid" contract is verifiable without spawning a victim process.

use std::time::Duration;

use sysinfo::{Pid, ProcessesToUpdate, System, Users};

use crate::monitoring::process::{KillSignal, ProcessError, ProcessInfo, ProcessManager};

/// Time to wait between the two CPU snapshots `sysinfo` needs to derive a
/// per-process CPU percentage. `sysinfo::MINIMUM_CPU_UPDATE_INTERVAL` is the
/// documented floor below which the second refresh reports 0.
fn cpu_settle_interval() -> Duration {
    // A hair above the documented minimum so the second refresh is always valid.
    sysinfo::MINIMUM_CPU_UPDATE_INTERVAL + Duration::from_millis(20)
}

/// [`ProcessManager`] for the local machine.
///
/// Stateless — each call builds a fresh `sysinfo::System` on a blocking thread,
/// so concurrent list/kill calls never share mutable refresh state.
#[derive(Debug, Clone, Default)]
pub struct LocalProcessManager;

impl LocalProcessManager {
    /// Create a local process manager.
    pub fn new() -> Self {
        Self
    }
}

/// Collect the local process list (blocking `sysinfo` work).
///
/// Refreshes twice, `cpu_settle_interval()` apart, so `cpu_usage()` reports a
/// real percentage rather than 0. Resolves each pid's owning user name. The
/// caller (an async `ProcessManager`) runs this on a blocking thread.
fn collect_local_processes() -> Vec<ProcessInfo> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    std::thread::sleep(cpu_settle_interval());
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let users = Users::new_with_refreshed_list();
    let total_memory = sys.total_memory(); // bytes

    let mut processes: Vec<ProcessInfo> = sys
        .processes()
        .values()
        .map(|proc_| {
            let memory_bytes = proc_.memory();
            let memory_percent = if total_memory > 0 {
                memory_bytes as f64 / total_memory as f64 * 100.0
            } else {
                0.0
            };
            let user = proc_
                .user_id()
                .and_then(|uid| users.get_user_by_id(uid))
                .map(|u| u.name().to_string())
                .unwrap_or_default();
            ProcessInfo {
                pid: proc_.pid().as_u32(),
                name: proc_.name().to_string_lossy().to_string(),
                user,
                cpu_percent: proc_.cpu_usage() as f64,
                memory_percent,
                memory_kb: Some(memory_bytes / 1024),
            }
        })
        .collect();

    // Not pre-sorted by the OS, so apply the shared sort + cap.
    processes = crate::monitoring::process::sort_and_cap(processes);
    processes
}

/// Map a [`KillSignal`] to the `sysinfo` signal used on Unix.
///
/// Isolated + unit-tested so the "SIGTERM vs SIGKILL" choice is verifiable
/// without terminating a real process.
#[cfg(unix)]
fn to_sysinfo_signal(signal: KillSignal) -> sysinfo::Signal {
    match signal {
        KillSignal::Term => sysinfo::Signal::Term,
        KillSignal::Kill => sysinfo::Signal::Kill,
    }
}

/// Terminate `pid` with `signal` on the local machine (blocking `sysinfo` work).
///
/// Unix delivers the exact signal via `kill_with`; if the running kernel does
/// not support that signal (`kill_with` returns `None`) it falls back to the
/// default terminate. Windows has no POSIX signals, so both variants terminate.
/// Targets the exact numeric pid only — never a name match.
fn kill_local_process(pid: u32, signal: KillSignal) -> Result<(), ProcessError> {
    let mut sys = System::new();
    let sys_pid = Pid::from_u32(pid);
    sys.refresh_processes(ProcessesToUpdate::Some(&[sys_pid]), true);

    let Some(proc_) = sys.process(sys_pid) else {
        return Err(ProcessError::NotFound(pid));
    };

    #[cfg(unix)]
    {
        // `kill_with` returns `None` only if the platform/kernel does not know
        // the signal; SIGTERM/SIGKILL are universal on Unix, but fall back to
        // the default terminate defensively rather than silently doing nothing.
        let delivered = match proc_.kill_with(to_sysinfo_signal(signal)) {
            Some(ok) => ok,
            None => proc_.kill(),
        };
        if delivered {
            Ok(())
        } else {
            Err(ProcessError::KillFailed {
                pid,
                message: format!("failed to deliver {} to process", signal.as_name()),
            })
        }
    }

    #[cfg(not(unix))]
    {
        // Windows: no POSIX signals — both TERM and KILL terminate the process.
        let _ = signal;
        if proc_.kill() {
            Ok(())
        } else {
            Err(ProcessError::KillFailed {
                pid,
                message: "failed to terminate process".to_string(),
            })
        }
    }
}

#[async_trait::async_trait]
impl ProcessManager for LocalProcessManager {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, ProcessError> {
        tokio::task::spawn_blocking(collect_local_processes)
            .await
            .map_err(|e| ProcessError::ListFailed(format!("process listing task failed: {e}")))
    }

    async fn kill_process(&self, pid: u32, signal: KillSignal) -> Result<(), ProcessError> {
        tokio::task::spawn_blocking(move || kill_local_process(pid, signal))
            .await
            .map_err(|e| ProcessError::KillFailed {
                pid,
                message: format!("kill task failed: {e}"),
            })?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn signal_mapping_is_exact() {
        assert_eq!(to_sysinfo_signal(KillSignal::Term), sysinfo::Signal::Term);
        assert_eq!(to_sysinfo_signal(KillSignal::Kill), sysinfo::Signal::Kill);
    }

    #[tokio::test]
    async fn list_processes_returns_capped_nonempty_list() {
        let mgr = LocalProcessManager::new();
        let procs = mgr
            .list_processes()
            .await
            .expect("local list should succeed");
        // The running test process itself guarantees at least one entry.
        assert!(!procs.is_empty(), "expected at least this test process");
        assert!(
            procs.len() <= crate::monitoring::process::MAX_PROCESSES,
            "list must be capped at MAX_PROCESSES"
        );
        // Sorted by descending CPU.
        for pair in procs.windows(2) {
            assert!(
                pair[0].cpu_percent >= pair[1].cpu_percent,
                "list must be sorted by descending CPU"
            );
        }
        // Every entry has a real pid and name.
        assert!(procs.iter().all(|p| p.pid > 0));
        assert!(procs.iter().all(|p| !p.name.is_empty()));
    }

    #[tokio::test]
    async fn kill_nonexistent_pid_is_not_found() {
        let mgr = LocalProcessManager::new();
        // A pid that is astronomically unlikely to exist.
        let err = mgr
            .kill_process(4_000_000_000, KillSignal::Term)
            .await
            .expect_err("killing a nonexistent pid must error");
        assert_eq!(err, ProcessError::NotFound(4_000_000_000));
    }
}
