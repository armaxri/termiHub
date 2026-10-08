//! The host's write half of a runner channel, shared by every sender: session
//! requests, the bridge service's replies (some carrying a passed socket) and
//! the proxied-stream pumps (#4183).
//!
//! Each frame goes out in one write under one lock, so frames from concurrent
//! senders never interleave, and a frame carrying a descriptor is ordered with
//! respect to every other frame — which is what lets the runner match passed
//! descriptors to replies in FIFO order.

use std::io::{self, Write};
use std::sync::Mutex;

/// A mutex-guarded writer over the channel.
pub(super) struct ChannelWriter {
    inner: Mutex<Box<dyn Write + Send>>,
    /// A second handle on the same socket for `sendmsg` with `SCM_RIGHTS`;
    /// only ever used while `inner` is locked. `None` in unit tests.
    #[cfg(unix)]
    fd_stream: Option<std::os::unix::net::UnixStream>,
}

impl ChannelWriter {
    /// A writer that cannot pass descriptors (unit tests, non-Unix).
    #[cfg(any(test, not(unix)))]
    pub(super) fn new(inner: Box<dyn Write + Send>) -> Self {
        Self {
            inner: Mutex::new(inner),
            #[cfg(unix)]
            fd_stream: None,
        }
    }

    /// A writer over a Unix channel that can also pass descriptors.
    #[cfg(unix)]
    pub(super) fn unix(stream: std::os::unix::net::UnixStream) -> io::Result<Self> {
        let fd_stream = stream.try_clone()?;
        Ok(Self {
            inner: Mutex::new(Box::new(stream)),
            fd_stream: Some(fd_stream),
        })
    }

    /// Write one already-encoded frame.
    pub(super) fn write_frame(&self, frame: &[u8]) -> io::Result<()> {
        let mut writer = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        writer.write_all(frame)?;
        writer.flush()
    }

    /// Whether this writer can pass descriptors.
    pub(super) fn can_pass_handles(&self) -> bool {
        #[cfg(unix)]
        {
            self.fd_stream.is_some()
        }
        #[cfg(not(unix))]
        {
            false
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
        let mut writer = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        writer.flush()?;
        termihub_plugin_runner::ipc::fd::send_with_fd(stream, frame, fd)
    }
}
