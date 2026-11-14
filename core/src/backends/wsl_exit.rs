//! The exit status of a WSL shell that ended on its own (#5796).
//!
//! `wsl.exe` exits with the status of the Linux shell it ran, so `exit 3` in a
//! WSL tab ends `wsl.exe` with `3`. The backend's child-exit watcher
//! ([`run_exit_watcher`]) records that status the moment the child is reaped
//! and only then closes the output channel — the same order as the local
//! shell (#5742) — so the session owner reads it from
//! [`exit_code`](crate::connection::ConnectionType::exit_code) when it sees
//! the output end. The watcher is also what ends the session at all on
//! Windows: ConPTY does not reliably EOF the output reader when the child
//! exits (#2704).
//!
//! A kill termiHub made itself (disconnect, tab close, the drop guard) is not
//! a status of the shell: [`WslExit::mark_deliberate`] runs before the kill,
//! and the status of the killed child then reads `None`.
//!
//! Pure and platform-independent: the WSL backend is Windows-only, so this is
//! compiled on every platform under `test` and its rules are exercised by the
//! macOS/Linux CI legs too.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use super::local_shell_exit::{ExitStatusSlot, SETTLE_TIMEOUT};
use crate::connection::OutputSender;

/// One WSL session's exit status, shared by its watcher, reader and backend.
#[derive(Debug, Default)]
pub(crate) struct WslExit {
    slot: ExitStatusSlot,
    /// Set before termiHub kills the child itself.
    deliberate: AtomicBool,
}

impl WslExit {
    /// The child is about to be killed by termiHub: its status is not the
    /// shell's and must never be reported.
    pub(crate) fn mark_deliberate(&self) {
        self.deliberate.store(true, Ordering::SeqCst);
    }

    /// Record that the child is gone, with its status when it could be read.
    pub(crate) fn child_exited(&self, code: Option<i32>) {
        let code = if self.deliberate.load(Ordering::SeqCst) {
            None
        } else {
            code
        };
        self.slot.record(code);
    }

    /// The output reader reached the end of the PTY: give the watcher a moment
    /// to reap the child, so the status is known before the output ends.
    pub(crate) fn output_ended(&self) {
        self.slot.wait_settled(SETTLE_TIMEOUT);
    }

    /// The shell's own exit status: `None` while it runs, when the status could
    /// not be read, and after a kill termiHub made itself.
    pub(crate) fn code(&self) -> Option<i32> {
        if self.deliberate.load(Ordering::SeqCst) {
            return None;
        }
        self.slot.get()
    }
}

/// The `wsl.exe` status as the `i32` the session reports. Windows codes above
/// `i32::MAX` (NTSTATUS) keep their bits, like the local shell's.
pub(crate) fn status_code(raw: u32) -> i32 {
    raw as i32
}

/// The child-exit watcher's body: block in `wait` until the child is gone,
/// record its status, then end the session — mark it dead and drop the output
/// sender, so subscribers see the channel close. Idempotent with the reader's
/// own end-of-output cleanup.
pub(crate) fn run_exit_watcher(
    wait: impl FnOnce() -> Option<i32>,
    exit: &WslExit,
    alive: &AtomicBool,
    output_tx: &Mutex<Option<OutputSender>>,
) {
    let code = wait();
    // Before the output ends, so the session owner reads it.
    exit.child_exited(code);
    alive.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = output_tx.lock() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// What a watcher shares with its session, plus the subscriber's end.
    type Session = (
        Arc<WslExit>,
        Arc<AtomicBool>,
        Arc<Mutex<Option<OutputSender>>>,
        crate::connection::OutputReceiver,
    );

    fn session() -> Session {
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        (
            Arc::new(WslExit::default()),
            Arc::new(AtomicBool::new(true)),
            Arc::new(Mutex::new(Some(tx))),
            rx,
        )
    }

    #[test]
    fn a_running_shell_has_no_status() {
        assert_eq!(WslExit::default().code(), None);
    }

    /// `exit 3` in the shell: the status is recorded before the channel
    /// closes, and the session is marked dead.
    #[test]
    fn the_shell_status_is_recorded_before_the_output_ends() {
        let (exit, alive, output_tx, mut rx) = session();
        run_exit_watcher(|| Some(3), &exit, &alive, &output_tx);
        // The channel is closed …
        assert!(rx.blocking_recv().is_none());
        // … and the status is already there when the owner looks.
        assert_eq!(exit.code(), Some(3));
        assert!(!alive.load(Ordering::SeqCst));
    }

    #[test]
    fn a_clean_exit_reads_zero_and_an_unreadable_status_none() {
        let (exit, alive, output_tx, _rx) = session();
        run_exit_watcher(|| Some(0), &exit, &alive, &output_tx);
        assert_eq!(exit.code(), Some(0));

        let (exit, alive, output_tx, _rx) = session();
        run_exit_watcher(|| None, &exit, &alive, &output_tx);
        assert_eq!(exit.code(), None);
    }

    /// A kill termiHub made (disconnect, tab close) is not the shell's status.
    #[test]
    fn a_deliberate_kill_reports_no_status() {
        let (exit, alive, output_tx, _rx) = session();
        exit.mark_deliberate();
        run_exit_watcher(|| Some(1), &exit, &alive, &output_tx);
        assert_eq!(exit.code(), None);
    }

    /// A deliberate kill after the shell already exited on its own hides the
    /// status too: the session owner only reads it for a self-ended session.
    #[test]
    fn marking_deliberate_after_the_exit_hides_the_status() {
        let exit = WslExit::default();
        exit.child_exited(Some(3));
        exit.mark_deliberate();
        assert_eq!(exit.code(), None);
    }

    /// The reader that saw EOF first waits for the watcher, so the status is
    /// known when the reader closes the channel.
    #[test]
    fn output_ended_waits_for_the_watcher() {
        let exit = Arc::new(WslExit::default());
        let watcher = exit.clone();
        let started = Instant::now();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            watcher.child_exited(Some(7));
        });
        exit.output_ended();
        assert_eq!(exit.code(), Some(7));
        assert!(started.elapsed() < Duration::from_secs(5));
        handle.join().unwrap();
    }

    #[test]
    fn status_codes_keep_their_bits() {
        assert_eq!(status_code(0), 0);
        assert_eq!(status_code(3), 3);
        assert_eq!(status_code(255), 255);
        // An NTSTATUS such as STATUS_CONTROL_C_EXIT (0xC000013A).
        assert_eq!(status_code(0xC000_013A), 0xC000_013A_u32 as i32);
    }
}
