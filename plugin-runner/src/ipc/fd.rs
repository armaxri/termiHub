//! Socket-handle passing over the Unix channel (#4183): `SCM_RIGHTS`.
//!
//! The host answers an approved `open_connection` by connecting the socket
//! itself and passing the connected descriptor to the runner along with the
//! `BridgeReply` frame ([`send_with_fd`]). The runner reads its channel through
//! a [`FdReader`], which collects every descriptor that arrives into a FIFO
//! [`FdQueue`]; the frame consumer pops one descriptor per
//! `StreamTransport::HandlePassed` reply, in order.
//!
//! Ordering holds because the channel is a stream socket written by one host
//! writer at a time: each descriptor rides on the first byte of the one frame
//! that announces it, and a frame is only decoded after all of its bytes (and
//! therefore its descriptor) were received.
//!
//! Received descriptors are close-on-exec (`MSG_CMSG_CLOEXEC` on Linux,
//! `FD_CLOEXEC` set right after receipt elsewhere), so they never leak into a
//! process a plugin starts.

use std::collections::VecDeque;
use std::io::{self, IoSlice, IoSliceMut, Read, Write};
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};

use nix::sys::socket::{recvmsg, sendmsg, ControlMessage, ControlMessageOwned, MsgFlags, UnixAddr};

/// Most descriptors one `recvmsg` accepts. The host passes one per frame and
/// the kernel never merges two descriptor-carrying writes into one read, so
/// this is generous; an overflow (`MSG_CTRUNC`) is reported as an error rather
/// than silently dropping descriptors.
const MAX_FDS_PER_READ: usize = 8;

/// Send one already-encoded frame with `fd` attached as `SCM_RIGHTS`
/// ancillary data. The descriptor travels with the frame's first byte; any
/// remainder a short `sendmsg` left is written normally. The caller keeps
/// ownership of `fd` (the kernel duplicates it into the receiver).
pub fn send_with_fd(stream: &UnixStream, frame: &[u8], fd: BorrowedFd<'_>) -> io::Result<()> {
    if frame.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a descriptor needs at least one byte to ride on",
        ));
    }
    let fds = [fd.as_raw_fd()];
    let cmsg = [ControlMessage::ScmRights(&fds)];
    let sent = loop {
        match sendmsg::<UnixAddr>(
            stream.as_raw_fd(),
            &[IoSlice::new(frame)],
            &cmsg,
            send_flags(),
            None,
        ) {
            Ok(n) => break n,
            Err(nix::errno::Errno::EINTR) => {}
            Err(e) => return Err(io::Error::from(e)),
        }
    };
    let mut writer = stream;
    writer.write_all(&frame[sent..])?;
    writer.flush()
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn send_flags() -> MsgFlags {
    MsgFlags::MSG_NOSIGNAL
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn send_flags() -> MsgFlags {
    MsgFlags::empty()
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn recv_flags() -> MsgFlags {
    MsgFlags::MSG_CMSG_CLOEXEC
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn recv_flags() -> MsgFlags {
    MsgFlags::empty()
}

/// FIFO of descriptors received on the channel, shared between the
/// [`FdReader`] that fills it and the frame consumer that drains it.
#[derive(Debug, Clone, Default)]
pub struct FdQueue(Arc<Mutex<VecDeque<OwnedFd>>>);

impl FdQueue {
    /// Take the oldest received descriptor, if any.
    #[must_use]
    pub fn pop(&self) -> Option<OwnedFd> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).pop_front()
    }

    /// Number of descriptors waiting.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Whether no descriptor is waiting.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn push(&self, fd: OwnedFd) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push_back(fd);
    }
}

/// A [`Read`] over a Unix stream socket that also collects `SCM_RIGHTS`
/// descriptors into an [`FdQueue`].
#[derive(Debug)]
pub struct FdReader {
    stream: UnixStream,
    fds: FdQueue,
}

impl FdReader {
    /// Read `stream`, collecting received descriptors into a fresh queue.
    #[must_use]
    pub fn new(stream: UnixStream) -> Self {
        Self {
            stream,
            fds: FdQueue::default(),
        }
    }

    /// The queue received descriptors land in.
    #[must_use]
    pub fn fds(&self) -> FdQueue {
        self.fds.clone()
    }
}

impl Read for FdReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut cmsg = nix::cmsg_space!([RawFd; MAX_FDS_PER_READ]);
        loop {
            let mut iov = [IoSliceMut::new(buf)];
            let msg = match recvmsg::<UnixAddr>(
                self.stream.as_raw_fd(),
                &mut iov,
                Some(&mut cmsg),
                recv_flags(),
            ) {
                Ok(msg) => msg,
                Err(nix::errno::Errno::EINTR) => continue,
                Err(e) => return Err(io::Error::from(e)),
            };
            let truncated = msg.flags.contains(MsgFlags::MSG_CTRUNC);
            let mut received = Vec::new();
            for control in msg.cmsgs().map_err(io::Error::from)? {
                if let ControlMessageOwned::ScmRights(raw) = control {
                    for fd in raw {
                        // SAFETY: the kernel just installed `fd` in this
                        // process for us; nothing else owns it.
                        received.push(unsafe { OwnedFd::from_raw_fd(fd) });
                    }
                }
            }
            let bytes = msg.bytes;
            for fd in received {
                set_cloexec(&fd);
                self.fds.push(fd);
            }
            if truncated {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "ancillary data was truncated: passed descriptors were lost",
                ));
            }
            return Ok(bytes);
        }
    }
}

/// Mark a received descriptor close-on-exec (already done atomically on Linux).
fn set_cloexec(fd: &OwnedFd) {
    // SAFETY: plain `fcntl` on a descriptor we own.
    unsafe {
        let flags = libc::fcntl(fd.as_raw_fd(), libc::F_GETFD);
        if flags >= 0 {
            libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::{TcpListener, TcpStream};
    use std::os::fd::AsFd;

    #[test]
    fn a_passed_socket_arrives_in_order_and_works() {
        let (host, runner) = UnixStream::pair().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let a = TcpStream::connect(addr).unwrap();
        let (mut a_peer, _) = listener.accept().unwrap();
        let b = TcpStream::connect(addr).unwrap();
        let (mut b_peer, _) = listener.accept().unwrap();

        send_with_fd(&host, b"one", a.as_fd()).unwrap();
        (&host).write_all(b"-plain-").unwrap();
        send_with_fd(&host, b"two", b.as_fd()).unwrap();
        // The host side drops its copies: the runner's are independent.
        drop((a, b));
        drop(host);

        let mut reader = FdReader::new(runner);
        let fds = reader.fds();
        let mut all = Vec::new();
        reader.read_to_end(&mut all).unwrap();
        assert_eq!(all, b"one-plain-two");
        assert_eq!(fds.len(), 2);

        let mut first = TcpStream::from(fds.pop().unwrap());
        let mut second = TcpStream::from(fds.pop().unwrap());
        assert!(fds.is_empty());
        first.write_all(b"A").unwrap();
        second.write_all(b"B").unwrap();
        let mut got = [0u8; 1];
        a_peer.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"A");
        b_peer.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"B");
    }

    #[test]
    fn received_descriptors_are_close_on_exec() {
        let (host, runner) = UnixStream::pair().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let sock = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        send_with_fd(&host, b"x", sock.as_fd()).unwrap();
        let mut reader = FdReader::new(runner);
        let mut byte = [0u8; 1];
        reader.read_exact(&mut byte).unwrap();
        let fd = reader.fds().pop().expect("a descriptor");
        // SAFETY: `F_GETFD` on a descriptor we own.
        let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0);
    }

    #[test]
    fn an_empty_frame_cannot_carry_a_descriptor() {
        let (host, _runner) = UnixStream::pair().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let sock = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        assert!(send_with_fd(&host, b"", sock.as_fd()).is_err());
    }
}
