//! Non-blocking, interruptible I/O on a Unix PTY master (#4394).
//!
//! A blocking `write` to the master parks in the kernel once the slave's input
//! queue is full, i.e. when the foreground program has stopped reading stdin.
//! Killing that program does **not** reliably wake the write on Linux: when
//! the session leader dies, the kernel hangs up the slave and marks it with an
//! I/O error, and the slave's later close then returns early (`pty_close`
//! skips a slave already in error) without waking the master's write queue.
//! The write stays parked even though every later write would fail with `EIO`.
//!
//! So the master's open file description is switched to `O_NONBLOCK`, and the
//! reader and writer handed out by `portable-pty` (both `dup`s of the master,
//! sharing that description) are wrapped:
//!
//! - [`InterruptibleWriter`] turns `EAGAIN` into a bounded `poll` for room and
//!   a retry, and gives up with an error once [`PtyInterrupt::interrupt`] has
//!   run. A retry after the slave is gone fails with `EIO` by itself, so the
//!   flag only shortens the wait.
//! - [`PollingReader`] turns `EAGAIN` into a `poll` for input and a retry, so
//!   the reader thread keeps its blocking semantics.
//!
//! Every `poll` has a timeout, so a wake-up the kernel never sends (the case
//! above) delays a retry by at most that long instead of parking forever.
//! The poll targets a private `dup` of the master, never the master's own fd,
//! so the descriptor stays valid after `close_pty` drops the master.

use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Longest a parked write waits before re-checking the interrupt flag and
/// retrying.
const WRITE_POLL_MS: libc::c_int = 50;

/// Longest the reader waits before retrying a read; only matters if the
/// kernel never signals readiness (output and hang-ups normally wake it).
const READ_POLL_MS: libc::c_int = 500;

/// Shared "stop writing" switch for one PTY.
#[derive(Clone, Default)]
pub(crate) struct PtyInterrupt(Arc<AtomicBool>);

impl PtyInterrupt {
    /// Make a parked or later write fail instead of waiting for room.
    pub(crate) fn interrupt(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    fn is_set(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Switch the master's file description to non-blocking and return a private
/// `dup` of it to poll on.
pub(crate) fn nonblocking_poll_fd(master: RawFd) -> io::Result<Arc<OwnedFd>> {
    // SAFETY: `dup` on a valid open fd; the result is checked and then owned.
    let fd = unsafe { libc::fcntl(master, libc::F_DUPFD_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `fd` is a fresh descriptor this function exclusively owns.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    // SAFETY: plain `fcntl` flag reads/writes on the owned descriptor.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Arc::new(fd))
}

/// Wait up to `timeout_ms` for `events` on `fd`. Errors (other than `EINTR`)
/// are returned; readiness, hang-up and timeout all just return `Ok`.
fn poll_for(fd: &OwnedFd, events: libc::c_short, timeout_ms: libc::c_int) -> io::Result<()> {
    let mut pfd = libc::pollfd {
        fd: fd.as_raw_fd(),
        events,
        revents: 0,
    };
    // SAFETY: one valid `pollfd` on an fd owned for the call's duration.
    if unsafe { libc::poll(&mut pfd, 1, timeout_ms) } < 0 {
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
    Ok(())
}

/// A PTY master writer that never parks indefinitely (see the module docs).
pub(crate) struct InterruptibleWriter {
    pub(crate) inner: Box<dyn Write + Send>,
    pub(crate) poll_fd: Arc<OwnedFd>,
    pub(crate) interrupt: PtyInterrupt,
}

impl Write for InterruptibleWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        loop {
            match self.inner.write(buf) {
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    if self.interrupt.is_set() {
                        return Err(io::Error::new(
                            io::ErrorKind::BrokenPipe,
                            "PTY write interrupted: the session is closing",
                        ));
                    }
                    poll_for(&self.poll_fd, libc::POLLOUT, WRITE_POLL_MS)?;
                }
                other => return other,
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// A PTY master reader with blocking semantics over a non-blocking fd.
pub(crate) struct PollingReader {
    pub(crate) inner: Box<dyn Read + Send>,
    pub(crate) poll_fd: Arc<OwnedFd>,
}

impl Read for PollingReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            match self.inner.read(buf) {
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    poll_for(&self.poll_fd, libc::POLLIN, READ_POLL_MS)?;
                }
                other => return other,
            }
        }
    }
}
