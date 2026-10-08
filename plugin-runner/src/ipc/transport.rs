//! The byte stream a runner channel rides on, as one trait over both
//! platforms' transports (#4201): a `socketpair` end ([`UnixStream`]) on Unix,
//! a private overlapped named pipe ([`super::pipe::PipeStream`]) on Windows.
//!
//! The host's handshake, reader thread and writer, and the runner's session
//! server, only ever use this surface, so they are the same code on every
//! platform.
//!
//! [`UnixStream`]: std::os::unix::net::UnixStream

use std::io::{self, Read, Write};
use std::time::Duration;

/// A duplex channel stream: frames are written and read through
/// [`Read`] / [`Write`]; a clone shares the same underlying channel (one side
/// reads on its own thread while others write).
pub trait ChannelStream: Read + Write + Send + Sync + Sized + 'static {
    /// Another handle on the same channel.
    fn try_clone(&self) -> io::Result<Self>;

    /// Bound every following read (`None`: block). An expired read fails with
    /// [`io::ErrorKind::WouldBlock`] or [`io::ErrorKind::TimedOut`].
    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()>;

    /// Bound every following write (`None`: block). An expired write fails
    /// with [`io::ErrorKind::WouldBlock`] or [`io::ErrorKind::TimedOut`].
    fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()>;
}

#[cfg(unix)]
impl ChannelStream for std::os::unix::net::UnixStream {
    fn try_clone(&self) -> io::Result<Self> {
        std::os::unix::net::UnixStream::try_clone(self)
    }

    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        std::os::unix::net::UnixStream::set_read_timeout(self, timeout)
    }

    fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        std::os::unix::net::UnixStream::set_write_timeout(self, timeout)
    }
}
