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
