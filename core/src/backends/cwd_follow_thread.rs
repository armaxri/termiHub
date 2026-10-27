//! The thread that runs a [`CwdFollower`] for a PTY session (#5009, #5013).
//!
//! The session's reader thread hands each output chunk to
//! [`CwdFollowThread::send`]; a timer thread reads the shell's directory with
//! the backend's probe when the follower says so, and adds the OSC 7. Used by
//! the local shell (a `sysinfo` read) and WSL (a short `wsl.exe` probe).

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::connection::OutputSender;
use crate::session::cwd_follow::CwdFollower;

/// Reads the shell's current directory (`None`: unknown).
pub(crate) type CwdProbe = Box<dyn Fn() -> Option<String> + Send + Sync>;

struct Shared {
    follower: Mutex<CwdFollower>,
    wake: Condvar,
}

/// One session's cwd following: the reader thread reports output through
/// [`send`](Self::send), a timer thread reads the directory when due.
#[derive(Clone)]
pub(crate) struct CwdFollowThread {
    shared: Arc<Shared>,
}

impl CwdFollowThread {
    /// Start following with `probe`, read at most once per
    /// `min_interval`; reports go to the sender in `output_tx`. The timer
    /// thread ends when `alive` is cleared.
    pub(crate) fn start(
        probe: CwdProbe,
        min_interval: Duration,
        output_tx: Arc<Mutex<Option<OutputSender>>>,
        alive: Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        let shared = Arc::new(Shared {
            follower: Mutex::new(CwdFollower::new(min_interval)),
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
                    // Read without the lock: a WSL probe spawns `wsl.exe`,
                    // and the reader must keep forwarding output meanwhile.
                    // `finish_read` holds the report back while that output
                    // is inside an escape sequence.
                    drop(follower);
                    let cwd = probe();
                    follower = match shared.follower.lock() {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
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
