//! Following a local shell's directory from the process it runs in (#5009).
//!
//! The local backend owns the shell's PTY, so the directory comes straight
//! from the operating system: the PTY's foreground process (the shell at its
//! prompt, or a nested shell) or, where that is unknown, the shell itself.
//! [`sysinfo`] reads it on Linux (`/proc/<pid>/cwd`), macOS
//! (`proc_pidinfo`) and Windows (the process parameters). The
//! [`CwdFollower`] decides when; this module runs it on the session's output.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::connection::OutputSender;
use crate::session::cwd_follow::CwdFollower;

/// A local read is cheap (one syscall), so it may run this often.
const MIN_INTERVAL: Duration = Duration::from_millis(250);

/// Reads the shell's current directory (`None`: unknown).
pub(crate) type CwdProbe = Box<dyn Fn() -> Option<String> + Send + Sync>;

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

/// One process, as [`innermost_same_program`] sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessEntry {
    pub pid: u32,
    pub parent: Option<u32>,
    /// The executable's file name (`bash.exe`).
    pub name: String,
    /// Start time in seconds; the newer child wins.
    pub start: u64,
}

/// The process whose directory stands for the shell's when the terminal's
/// foreground process is unknown (Windows ConPTY, #5014): starting at the
/// spawned `root`, follow the newest child running the same program for as
/// long as there is one.
///
/// Git for Windows' `bin\bash.exe` is a launcher that runs the real
/// `usr\bin\bash.exe` as its child and never changes directory itself, so
/// the shell is the launcher's child; a `bash` started inside it is followed
/// the same way, like a nested shell is through the foreground process on
/// Unix. Any other child (`vim`, `git`) leaves the shell where it is.
pub(crate) fn innermost_same_program(root: u32, processes: &[ProcessEntry]) -> u32 {
    let Some(name) = processes
        .iter()
        .find(|p| p.pid == root)
        .map(|p| p.name.to_ascii_lowercase())
    else {
        return root;
    };
    let mut current = root;
    // A process table can carry a pid-reuse cycle; never walk more steps
    // than there are processes.
    for _ in 0..processes.len() {
        let next = processes
            .iter()
            .filter(|p| {
                p.parent == Some(current) && p.pid != current && p.name.eq_ignore_ascii_case(&name)
            })
            .max_by_key(|p| (p.start, p.pid));
        match next {
            Some(child) => current = child.pid,
            None => break,
        }
    }
    current
}

/// The working directory of the shell spawned as `root`, through
/// [`innermost_same_program`] (Windows: Git Bash's launcher, #5014).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn innermost_shell_cwd(root: u32) -> Option<String> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let processes: Vec<ProcessEntry> = system
        .processes()
        .values()
        .map(|p| ProcessEntry {
            pid: p.pid().as_u32(),
            parent: p.parent().map(|pp| pp.as_u32()),
            name: p.name().to_string_lossy().into_owned(),
            start: p.start_time(),
        })
        .collect();
    usable_cwd(process_cwd(innermost_same_program(root, &processes)))
}

/// `cwd` when it is a directory a file browser can show. MSYS reports a
/// virtual directory (`cd /proc`) as the pipe namespace `\\?\PIPE\`
/// (#5014), which Windows also calls a directory; that is left unreported,
/// so the last real directory stays.
fn usable_cwd(cwd: Option<String>) -> Option<String> {
    cwd.filter(|c| {
        let upper = c.to_ascii_uppercase();
        !upper.starts_with(r"\\?\PIPE") && !upper.starts_with(r"\\.\PIPE")
    })
    .filter(|c| std::path::Path::new(c).is_dir())
}

struct Shared {
    follower: Mutex<CwdFollower>,
    wake: Condvar,
}

/// One session's cwd following: the reader thread reports output through
/// [`send`](Self::send), a timer thread reads the directory when due.
#[derive(Clone)]
pub(crate) struct LocalCwdFollow {
    shared: Arc<Shared>,
}

impl LocalCwdFollow {
    /// Start following with `probe`; reports go to the sender in
    /// `output_tx`. The timer thread ends when `alive` is cleared.
    pub(crate) fn start(
        probe: CwdProbe,
        output_tx: Arc<Mutex<Option<OutputSender>>>,
        alive: Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        let shared = Arc::new(Shared {
            follower: Mutex::new(CwdFollower::new(MIN_INTERVAL)),
            wake: Condvar::new(),
        });
        let timer = shared.clone();
        std::thread::spawn(move || run_timer(&timer, &probe, &output_tx, &alive));
        Self { shared }
    }

    /// Hand `data` to the terminal through `send`, then note it. Both happen
    /// under the follower's lock, so a report is never put inside a chunk's
    /// escape sequence by the timer thread.
    pub(crate) fn send(&self, data: Vec<u8>, sender: &OutputSender, send: impl FnOnce(Vec<u8>)) {
        let Ok(mut follower) = self.shared.follower.lock() else {
            send(data);
            return;
        };
        follower.observe(&data, Instant::now());
        send(data);
        if let Some(report) = follower.take_pending() {
            let _ = sender.blocking_send(report);
        }
        drop(follower);
        self.shared.wake.notify_one();
    }

    /// Wake the timer so it notices the session ended.
    pub(crate) fn stop(&self) {
        self.shared.wake.notify_one();
    }
}

fn run_timer(
    shared: &Shared,
    probe: &CwdProbe,
    output_tx: &Arc<Mutex<Option<OutputSender>>>,
    alive: &std::sync::atomic::AtomicBool,
) {
    use std::sync::atomic::Ordering;
    let Ok(mut follower) = shared.follower.lock() else {
        return;
    };
    loop {
        if !alive.load(Ordering::SeqCst) || follower.shell_reports_cwd() {
            return;
        }
        let now = Instant::now();
        let wait = match follower.next_read() {
            Some(due) if due <= now => {
                if follower.start_read(now) {
                    // The read is one quick syscall; holding the lock keeps
                    // the report in order with the reader's chunks.
                    let cwd = probe();
                    if let Some(report) = follower.finish_read(cwd.as_deref()) {
                        let sender = output_tx.lock().ok().and_then(|g| g.clone());
                        match sender {
                            Some(sender) => {
                                let _ = sender.blocking_send(report);
                            }
                            None => return,
                        }
                    }
                }
                continue;
            }
            Some(due) => due - now,
            // Nothing to do until output arrives; re-check `alive` now and
            // then in case the session ends while idle.
            None => Duration::from_secs(1),
        };
        follower = match shared.wake.wait_timeout(follower, wait) {
            Ok((guard, _)) => guard,
            Err(_) => return,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: u32, name: &str, start: u64) -> ProcessEntry {
        ProcessEntry {
            pid,
            parent: Some(parent),
            name: name.to_string(),
            start,
        }
    }

    #[test]
    fn git_bash_launcher_is_followed_to_the_real_shell() {
        // bin\bash.exe (launcher) -> usr\bin\bash.exe (the shell).
        let table = [p(10, 1, "bash.exe", 5), p(11, 10, "bash.exe", 5)];
        assert_eq!(innermost_same_program(10, &table), 11);
    }

    #[test]
    fn a_nested_shell_is_followed_and_other_programs_are_not() {
        let table = [
            p(10, 1, "bash.exe", 5),
            p(11, 10, "bash.exe", 5),
            p(12, 11, "vim.exe", 6),
            p(13, 11, "BASH.EXE", 7),
            p(14, 13, "less.exe", 8),
        ];
        assert_eq!(innermost_same_program(10, &table), 13);
    }

    #[test]
    fn the_newest_same_named_child_wins() {
        let table = [
            p(10, 1, "bash.exe", 5),
            p(30, 10, "bash.exe", 6),
            p(20, 10, "bash.exe", 9),
        ];
        assert_eq!(innermost_same_program(10, &table), 20);
    }

    #[test]
    fn an_unknown_or_childless_root_is_itself() {
        assert_eq!(innermost_same_program(10, &[]), 10);
        assert_eq!(innermost_same_program(10, &[p(10, 1, "cmd.exe", 1)]), 10);
    }

    #[test]
    fn a_pid_cycle_does_not_hang() {
        let table = [p(10, 11, "bash.exe", 1), p(11, 10, "bash.exe", 1)];
        let found = innermost_same_program(10, &table);
        assert!(found == 10 || found == 11);
    }

    #[test]
    fn a_virtual_msys_directory_is_not_reported() {
        assert_eq!(usable_cwd(Some(r"\\?\PIPE\".to_string())), None);
        assert_eq!(usable_cwd(None), None);
        let here = std::env::temp_dir().to_string_lossy().into_owned();
        assert_eq!(usable_cwd(Some(here.clone())), Some(here));
    }

    /// The real process table: this test process has no same-named child,
    /// so its own directory comes back.
    #[test]
    fn innermost_shell_cwd_reads_a_real_process() {
        let me = std::process::id();
        let cwd = innermost_shell_cwd(me).expect("own cwd");
        let expected = std::env::current_dir().expect("cwd");
        assert_eq!(
            std::path::Path::new(&cwd).canonicalize().ok(),
            expected.canonicalize().ok()
        );
    }
}
