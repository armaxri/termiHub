//! The exit status of a local shell that ended on its own (#5742).
//!
//! The child-exit watcher records the status the moment `wait_for_exit`
//! returns, before it closes the output channel. On Unix the output reader
//! usually sees EOF first (the slave fd closes as the child exits), so the
//! reader waits — briefly, see [`ExitStatusSlot::wait_settled`] — for the
//! watcher before it closes the channel itself. Either way the status is
//! known by the time the session owner sees the output end, which is when it
//! reads [`exit_code`](crate::connection::ConnectionType::exit_code).

use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// How long the output reader waits, after EOF, for the watcher to reap the
/// child. A shell whose PTY closed is gone within microseconds; the bound only
/// keeps a child that closed its terminal but kept running from holding the
/// session open.
pub(super) const SETTLE_TIMEOUT: Duration = Duration::from_secs(1);

/// What the watcher learned when the child went away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Exit {
    /// The child is still running (or nobody reaped it yet).
    Running,
    /// The child is gone; its status, when it could be read.
    Reaped(Option<i32>),
}

/// One shell's exit status, shared by its watcher, its reader and the backend.
#[derive(Debug)]
pub(super) struct ExitStatusSlot {
    exit: Mutex<Exit>,
    settled: Condvar,
}

impl Default for ExitStatusSlot {
    fn default() -> Self {
        Self {
            exit: Mutex::new(Exit::Running),
            settled: Condvar::new(),
        }
    }
}

impl ExitStatusSlot {
    /// Record that the child is gone, with its status when it could be read.
    pub(super) fn record(&self, code: Option<i32>) {
        let mut exit = self.exit.lock().unwrap_or_else(|e| e.into_inner());
        *exit = Exit::Reaped(code);
        self.settled.notify_all();
    }

    /// The recorded status: `None` while the child runs, or when it could not
    /// be read.
    pub(super) fn get(&self) -> Option<i32> {
        match *self.exit.lock().unwrap_or_else(|e| e.into_inner()) {
            Exit::Reaped(code) => code,
            Exit::Running => None,
        }
    }

    /// Block until the child has been reaped, or `timeout` passes.
    pub(super) fn wait_settled(&self, timeout: Duration) {
        let exit = self.exit.lock().unwrap_or_else(|e| e.into_inner());
        let _ = self
            .settled
            .wait_timeout_while(exit, timeout, |exit| *exit == Exit::Running);
    }
}

/// How long the child-exit watcher, on Unix, lets the output reader drain the
/// PTY before it ends the output itself (#5955). The PTY can still hold the
/// shell's last lines when the child is reaped; ending the output first lost
/// them, or let them arrive after the exit line. A reader that reaches EOF ends
/// the wait at once; the bound only covers a child that left a background job
/// holding the terminal open.
#[cfg(all(unix, feature = "local-shell"))]
pub(super) const DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

/// Set once the output reader has forwarded everything it read and stopped.
#[cfg(any(feature = "local-shell", test))]
#[derive(Debug, Default)]
pub(super) struct ReaderDone {
    done: Mutex<bool>,
    finished: Condvar,
}

#[cfg(any(feature = "local-shell", test))]
impl ReaderDone {
    /// The reader has stopped: wake a watcher waiting in [`Self::wait`].
    pub(super) fn finish(&self) {
        let mut done = self.done.lock().unwrap_or_else(|e| e.into_inner());
        *done = true;
        self.finished.notify_all();
    }

    /// Block until the reader has stopped, or `timeout` passes.
    #[cfg(any(unix, test))]
    pub(super) fn wait(&self, timeout: Duration) {
        let done = self.done.lock().unwrap_or_else(|e| e.into_inner());
        let _ = self
            .finished
            .wait_timeout_while(done, timeout, |done| !*done);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn a_running_child_has_no_status() {
        assert_eq!(ExitStatusSlot::default().get(), None);
    }

    #[test]
    fn the_recorded_status_is_read_back() {
        let slot = ExitStatusSlot::default();
        slot.record(Some(3));
        assert_eq!(slot.get(), Some(3));
        let slot = ExitStatusSlot::default();
        slot.record(None);
        assert_eq!(slot.get(), None);
    }

    #[test]
    fn wait_settled_returns_once_the_watcher_records() {
        let slot = Arc::new(ExitStatusSlot::default());
        let watcher = slot.clone();
        let started = Instant::now();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            watcher.record(Some(0));
        });
        slot.wait_settled(Duration::from_secs(10));
        assert_eq!(slot.get(), Some(0));
        assert!(started.elapsed() < Duration::from_secs(5));
        handle.join().unwrap();
    }

    #[test]
    fn reader_done_wakes_a_waiting_watcher() {
        let done = Arc::new(ReaderDone::default());
        let reader = done.clone();
        let started = Instant::now();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            reader.finish();
        });
        done.wait(Duration::from_secs(10));
        assert!(started.elapsed() < Duration::from_secs(5));
        handle.join().unwrap();
    }

    #[test]
    fn reader_done_wait_gives_up_after_the_timeout() {
        let started = Instant::now();
        ReaderDone::default().wait(Duration::from_millis(30));
        assert!(started.elapsed() >= Duration::from_millis(30));
    }

    #[test]
    fn wait_settled_gives_up_after_the_timeout() {
        let slot = ExitStatusSlot::default();
        let started = Instant::now();
        slot.wait_settled(Duration::from_millis(30));
        assert!(started.elapsed() >= Duration::from_millis(30));
        assert_eq!(slot.get(), None);
    }
}
