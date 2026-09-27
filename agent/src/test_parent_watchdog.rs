//! Test-only parent-death watchdog (#3641).
//!
//! The integration-test harnesses spawn real agent processes (`--listen`
//! workers, and through them session and registry daemons). When the test
//! binary is killed — Ctrl-C, a CI timeout, an IDE "stop" — its drop guards
//! never run, and those processes are re-parented to init/launchd and keep
//! running (one leaked worker kept a registry daemon alive for 13 days).
//!
//! A harness opts a spawned agent in by setting [`PARENT_PID_ENV`] to its own
//! PID. The agent then watches that process from a background thread and exits
//! as soon as it is gone. The variable is inherited, so a session or registry
//! daemon the agent spawns watches the same test process and goes down with it
//! too.
//!
//! **Inert in production:** nothing but the test harnesses ever sets the
//! variable, and with it absent (or unparseable) [`start_from_env`] returns
//! without spawning anything, so the agent behaves exactly as before.
//!
//! Why a PID watch rather than Linux `PR_SET_PDEATHSIG`: the death signal fires
//! when the *thread* that spawned the child exits, not the process — and each
//! libtest test runs on its own thread, so an agent spawned by one test and
//! outliving that thread would be killed early. It also only covers the direct
//! child, not the daemons the agent spawns, and has no macOS equivalent. The
//! PID watch is process-level, covers the whole spawned tree, and works the
//! same on every platform. (On Windows the harness additionally puts spawned
//! agents into a kill-on-close Job Object.)

#[cfg(unix)]
use std::time::Duration;

/// Env var carrying the PID of the test process whose death should take this
/// agent down. Set only by the integration-test harnesses.
pub const PARENT_PID_ENV: &str = "TERMIHUB_TEST_PARENT_PID";

/// How often the Unix watchdog re-checks the watched process.
#[cfg(unix)]
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Parse the [`PARENT_PID_ENV`] value. Anything but a positive PID — absent,
/// empty, non-numeric, zero — yields `None`: no watchdog.
fn parse_parent_pid(raw: Option<String>) -> Option<u32> {
    raw.and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|pid| *pid > 0)
}

/// Start the watchdog if [`PARENT_PID_ENV`] names a process; otherwise do
/// nothing (the production path).
pub fn start_from_env() {
    let Some(pid) = parse_parent_pid(std::env::var(PARENT_PID_ENV).ok()) else {
        return;
    };
    let spawned = std::thread::Builder::new()
        .name("test-parent-watchdog".to_string())
        .spawn(move || {
            wait_for_exit(pid);
            eprintln!("termihub-agent: test parent process {pid} exited; shutting down (#3641)");
            std::process::exit(1);
        });
    if let Err(e) = spawned {
        eprintln!("termihub-agent: could not start the test parent watchdog: {e}");
    }
}

/// Block until process `pid` has exited.
#[cfg(unix)]
fn wait_for_exit(pid: u32) {
    // When the watched process is our direct parent (a `--listen` worker the
    // test spawned), its exit re-parents us immediately — before anyone reaps
    // it — so `getppid` changing is the earliest, zombie-proof signal. Daemons
    // the agent spawned are not its children, so for them fall back to probing
    // the PID itself.
    // Safety: `getppid` has no preconditions and cannot fail.
    let direct_child = unsafe { libc::getppid() } as u32 == pid;
    loop {
        if direct_child {
            // Safety: as above.
            if unsafe { libc::getppid() } as u32 != pid {
                return;
            }
        } else if !pid_alive(pid) {
            return;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let Ok(raw) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // Safety: signal 0 only checks that the pid exists and may be signalled.
    if unsafe { libc::kill(raw, 0) } == 0 {
        return !is_zombie(pid);
    }
    // EPERM: the pid exists but belongs to someone else — treat as alive
    // rather than exit on a probe we cannot interpret. ESRCH: gone.
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// A killed test binary is a zombie until its own parent (cargo, a shell)
/// reaps it; for our purposes it is already dead.
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

/// Block until process `pid` has exited.
#[cfg(windows)]
fn wait_for_exit(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE,
    };
    // Safety: plain open/wait/close on a process handle. A null handle means
    // the process is already gone (a same-user test process is never
    // inaccessible), so return and let the caller exit.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return;
        }
        WaitForSingleObject(handle, INFINITE);
        CloseHandle(handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_or_invalid_values_start_no_watchdog() {
        assert_eq!(parse_parent_pid(None), None);
        assert_eq!(parse_parent_pid(Some(String::new())), None);
        assert_eq!(parse_parent_pid(Some("abc".into())), None);
        assert_eq!(parse_parent_pid(Some("0".into())), None);
        assert_eq!(parse_parent_pid(Some("-5".into())), None);
    }

    #[test]
    fn a_positive_pid_is_watched() {
        assert_eq!(parse_parent_pid(Some("4242".into())), Some(4242));
        assert_eq!(parse_parent_pid(Some(" 17\n".into())), Some(17));
    }

    #[cfg(unix)]
    #[test]
    fn this_process_is_alive() {
        assert!(pid_alive(std::process::id()));
    }
}
