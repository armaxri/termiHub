//! The host's write half of a runner channel, shared by every sender: session
//! requests, the bridge service's replies (some carrying a passed socket) and
//! the proxied-stream pumps (#4183). On Windows it also holds the runner's
//! process handle, which bridge sockets are duplicated into (#4219).
//!
//! Each frame goes out in one write under one lock, so frames from concurrent
//! senders never interleave, and a frame carrying a descriptor is ordered with
//! respect to every other frame — which is what lets the runner match passed
//! descriptors to replies in FIFO order.
//!
//! The lock is handed over in arrival order ([`FairMutex`]): with a plain
//! mutex a session writing in a loop barged back in ahead of the others, and
//! 40 concurrent echo sessions saw a 2.3x (Linux) to 21x (Windows) spread in
//! throughput (#4233).

use std::io::{self, Write};

use termihub_plugin_runner::ipc::FairMutex;

/// A mutex-guarded writer over the channel.
pub(super) struct ChannelWriter {
    inner: FairMutex<Box<dyn Write + Send>>,
    /// A second handle on the same socket for `sendmsg` with `SCM_RIGHTS`;
    /// only ever used while `inner` is locked. `None` in unit tests.
    #[cfg(unix)]
    fd_stream: Option<std::os::unix::net::UnixStream>,
    /// The runner process, which bridge sockets are duplicated into
    /// (`DuplicateHandle`). `None` until [`passing_into`](Self::passing_into)
    /// and in unit tests.
    #[cfg(windows)]
    runner: Option<std::os::windows::io::OwnedHandle>,
}

impl ChannelWriter {
    /// A writer that cannot pass descriptors (unit tests, Windows).
    #[cfg(any(test, not(unix)))]
    pub(super) fn new(inner: Box<dyn Write + Send>) -> Self {
        Self {
            inner: FairMutex::new(inner),
            #[cfg(unix)]
            fd_stream: None,
            #[cfg(windows)]
            runner: None,
        }
    }

    /// A writer over a Unix channel that can also pass descriptors.
    #[cfg(unix)]
    pub(super) fn for_channel(stream: super::spawn::HostChannel) -> io::Result<Self> {
        let fd_stream = stream.try_clone()?;
        Ok(Self {
            inner: FairMutex::new(Box::new(stream)),
            fd_stream: Some(fd_stream),
        })
    }

    /// A writer over the Windows pipe channel. It passes bridge sockets only
    /// once it knows the runner process ([`passing_into`](Self::passing_into)).
    #[cfg(windows)]
    pub(super) fn for_channel(stream: super::spawn::HostChannel) -> io::Result<Self> {
        Ok(Self::new(Box::new(stream)))
    }

    /// Pass bridge sockets by duplicating them into `runner` (its process
    /// handle, which needs `PROCESS_DUP_HANDLE`).
    #[cfg(windows)]
    pub(super) fn passing_into(mut self, runner: std::os::windows::io::OwnedHandle) -> Self {
        self.runner = Some(runner);
        self
    }

    /// Write one already-encoded frame.
    pub(super) fn write_frame(&self, frame: &[u8]) -> io::Result<()> {
        self.inner.with(|writer| {
            writer.write_all(frame)?;
            writer.flush()
        })
    }

    /// Whether this writer can pass descriptors.
    pub(super) fn can_pass_handles(&self) -> bool {
        #[cfg(unix)]
        {
            self.fd_stream.is_some()
        }
        #[cfg(windows)]
        {
            self.runner.is_some()
        }
    }

    /// Duplicate `socket` into the runner (least access, see
    /// [`termihub_plugin_runner::ipc::handle::SOCKET_ACCESS`]) and return its
    /// value there.
    #[cfg(windows)]
    pub(super) fn duplicate_into_runner(&self, socket: &std::net::TcpStream) -> io::Result<u64> {
        use std::os::windows::io::{AsHandle, AsRawSocket, BorrowedHandle};
        let Some(runner) = self.runner.as_ref() else {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "this channel cannot pass handles",
            ));
        };
        // SAFETY: a base-provider socket is a kernel handle (the caller
        // checked `XP1_IFS_HANDLES`), valid while `socket` lives.
        let handle = unsafe { BorrowedHandle::borrow_raw(socket.as_raw_socket() as _) };
        termihub_plugin_runner::ipc::handle::duplicate_into(runner.as_handle(), handle)
    }

    /// Close a duplicate whose reply never reached the runner.
    #[cfg(windows)]
    pub(super) fn close_in_runner(&self, value: u64) {
        use std::os::windows::io::AsHandle;
        if let Some(runner) = self.runner.as_ref() {
            termihub_plugin_runner::ipc::handle::close_in(runner.as_handle(), value);
        }
    }

    /// Write one frame with `fd` attached (`SCM_RIGHTS`).
    #[cfg(unix)]
    pub(super) fn write_frame_with_fd(
        &self,
        frame: &[u8],
        fd: std::os::fd::BorrowedFd<'_>,
    ) -> io::Result<()> {
        let Some(stream) = self.fd_stream.as_ref() else {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "this channel cannot pass descriptors",
            ));
        };
        // Hold the frame lock so nothing interleaves with the descriptor frame.
        self.inner.with(|writer| {
            writer.flush()?;
            termihub_plugin_runner::ipc::fd::send_with_fd(stream, frame, fd)
        })
    }
}
