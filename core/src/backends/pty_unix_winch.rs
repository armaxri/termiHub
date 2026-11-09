//! Re-send a resize to the shell when a command got it instead (#5096).
//!
//! The kernel sends `SIGWINCH` to the PTY's foreground process group only. A
//! resize made while a command runs reaches that command, not the shell, and
//! readline catches `SIGWINCH` only while it reads a line. bash 5 re-reads the
//! size after each command (`checkwinsize` is on by default), but bash 3.2
//! (macOS's `/bin/bash`) does so only when `checkwinsize` is set, which a
//! plain `/bin/bash` without `--login` never reads from `/etc/bashrc`. Its
//! next prompt then keeps the old width, and a long command line wraps at the
//! wrong column.
//!
//! [`ResizeCatchUp`] fixes that without typing anything into the shell: when
//! a resize finds the PTY owned by something other than the shell's line
//! editor, it waits until the shell is the foreground process group again and
//! its line editor reads ([`line_editor_reading`]), then sends one `SIGWINCH`
//! to the shell's process group. Several resizes during one command collapse
//! into that one signal, which carries the size as it is then. A full-screen
//! program never gets the extra signal: it goes out only while the shell
//! itself owns the terminal, and the program already got the kernel's own.

use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::pty_unix_io::{foreground_pgid, line_editor_reading};

/// How often a pending catch-up checks whether the shell reads again.
const POLL: Duration = Duration::from_millis(50);

/// Re-sends a resize to the shell once it is back at its prompt.
pub(crate) struct ResizeCatchUp {
    /// A `dup` of the PTY master, for `tcgetpgrp` / `tcgetattr`.
    fd: Arc<OwnedFd>,
    /// The shell's process group: the shell is the session leader, so its
    /// pid.
    shell_pgid: u32,
    /// A watcher thread is waiting for the prompt.
    pending: AtomicBool,
    /// The session is ending; a waiting watcher gives up.
    closed: Arc<AtomicBool>,
}

impl ResizeCatchUp {
    pub(crate) fn new(fd: Arc<OwnedFd>, shell_pgid: u32, closed: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self {
            fd,
            shell_pgid,
            pending: AtomicBool::new(false),
            closed,
        })
    }

    /// The shell owns the terminal and its line editor reads a line, so a
    /// `SIGWINCH` reaches readline.
    fn shell_reads(&self) -> bool {
        foreground_pgid(&self.fd) == Some(self.shell_pgid) && line_editor_reading(&self.fd)
    }

    /// Call right after the PTY was resized. If the kernel's `SIGWINCH` went
    /// to anything but the shell's line editor, re-send it to the shell once
    /// the line editor reads again.
    pub(crate) fn after_resize(self: &Arc<Self>) {
        if self.closed.load(Ordering::SeqCst) || self.shell_reads() {
            return;
        }
        if self.pending.swap(true, Ordering::SeqCst) {
            // A watcher already waits; it sends the size as it is then.
            return;
        }
        let me = self.clone();
        let spawned = std::thread::Builder::new()
            .name("pty-resize-catch-up".to_string())
            .spawn(move || me.watch());
        if spawned.is_err() {
            self.pending.store(false, Ordering::SeqCst);
        }
    }

    fn watch(&self) {
        loop {
            std::thread::sleep(POLL);
            if self.closed.load(Ordering::SeqCst) || foreground_pgid(&self.fd).is_none() {
                self.pending.store(false, Ordering::SeqCst);
                return;
            }
            if !self.shell_reads() {
                continue;
            }
            // Clear first: a resize from here on that misses the line editor
            // starts its own watcher instead of relying on this one.
            self.pending.store(false, Ordering::SeqCst);
            if self.shell_reads() {
                self.signal_shell();
                return;
            }
            // A new command took the terminal in between; keep waiting
            // unless a newer watcher already does.
            if self.pending.swap(true, Ordering::SeqCst) {
                return;
            }
        }
    }

    fn signal_shell(&self) {
        let Ok(pgid) = libc::pid_t::try_from(self.shell_pgid) else {
            return;
        };
        // SAFETY: `killpg` only sends a signal; `pgid` is positive and is the
        // PTY's foreground process group, checked just before.
        unsafe {
            libc::killpg(pgid, libc::SIGWINCH);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::FromRawFd;

    /// A descriptor that is not a terminal: `tcgetpgrp` fails on it.
    fn not_a_tty() -> Arc<OwnedFd> {
        let mut fds = [0; 2];
        // SAFETY: `pipe` fills two fresh descriptors on success.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        // SAFETY: both descriptors are fresh and owned here.
        unsafe {
            drop(OwnedFd::from_raw_fd(fds[1]));
            Arc::new(OwnedFd::from_raw_fd(fds[0]))
        }
    }

    #[test]
    fn a_closed_session_starts_no_watcher() {
        let closed = Arc::new(AtomicBool::new(true));
        let catch_up = ResizeCatchUp::new(not_a_tty(), u32::MAX, closed);
        catch_up.after_resize();
        assert!(!catch_up.pending.load(Ordering::SeqCst));
    }

    #[test]
    fn a_watcher_without_a_terminal_gives_up() {
        let closed = Arc::new(AtomicBool::new(false));
        // `u32::MAX` is no valid process group, so nothing is ever signalled.
        let catch_up = ResizeCatchUp::new(not_a_tty(), u32::MAX, closed);
        catch_up.after_resize();
        assert!(catch_up.pending.load(Ordering::SeqCst));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while catch_up.pending.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline, "watcher never ended");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
