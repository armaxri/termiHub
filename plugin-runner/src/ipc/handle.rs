//! Bridge-socket handle passing on Windows (#4219): the host duplicates an
//! approved, connected socket into the runner with `DuplicateHandle` and names
//! the handle value in its `HandleDuplicated` reply.
//!
//! * **No Winsock in the runner.** Under LPAC `WSAStartup` fails (10107) and
//!   `WSADuplicateSocketW` cannot be used (spike #4181). A socket of the base
//!   provider is a kernel file handle, though, so the runner drives it as one:
//!   [`SocketStream`] reads and writes it with the same overlapped
//!   `ReadFile` / `WriteFile` as the channel pipe ([`super::pipe`]). The
//!   runner never calls a socket function on it; socket options and shutdown
//!   stay with the host, which keeps its own handle on the connection.
//! * **Least access.** The duplicate carries only [`SOCKET_ACCESS`] (read and
//!   write data, read attributes, synchronize), not the host's full access.
//! * **Host side** ([`duplicate_into`], [`close_in`]) runs in termiHub, which
//!   holds the runner's process handle from its spawn. It only duplicates a
//!   socket the host checked is a kernel handle (an IFS provider); any other
//!   one, or a failed duplication, falls back to the `StreamData` proxy.
//! * **Runner side** ([`adopt`]) refuses a value that is not an open
//!   socket-like handle, so a stray value can never alias the runner's own
//!   channel pipe.

use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};

use windows_sys::Win32::Foundation::{
    DuplicateHandle, ERROR_BROKEN_PIPE, ERROR_HANDLE_EOF, FALSE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileType, ReadFile, WriteFile, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_TYPE_PIPE,
    FILE_WRITE_DATA, SYNCHRONIZE,
};
use windows_sys::Win32::System::Pipes::GetNamedPipeInfo;
use windows_sys::Win32::System::Threading::GetCurrentProcess;

use super::pipe::overlapped;
use crate::win::is_os_error;

/// The access a duplicated bridge socket carries into the runner: enough for
/// `ReadFile` / `WriteFile`, `GetFileType` and waiting, nothing more.
pub const SOCKET_ACCESS: u32 =
    FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;

/// Host side: duplicate `socket` (a connected socket of this process, given
/// as a handle) into `process` with [`SOCKET_ACCESS`], non-inheritable.
/// Returns the handle's value in `process`; the target owns it from now on
/// (see [`close_in`] for a duplicate that never reached it).
///
/// # Errors
/// The OS error of `DuplicateHandle` (the caller falls back to the proxy).
pub fn duplicate_into(process: BorrowedHandle<'_>, socket: BorrowedHandle<'_>) -> io::Result<u64> {
    let mut target: HANDLE = std::ptr::null_mut();
    // SAFETY: both handles are valid for the call; `target` receives a value
    // in the other process's handle table, never used as a handle here.
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            socket.as_raw_handle(),
            process.as_raw_handle(),
            &mut target,
            SOCKET_ACCESS,
            FALSE,
            0,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(target as usize as u64)
}

/// Host side: close the handle `value` in `process` — a duplicate whose reply
/// never reached the runner. Best effort: a runner that is gone took the
/// handle with it.
pub fn close_in(process: BorrowedHandle<'_>, value: u64) {
    let Ok(value) = usize::try_from(value) else {
        return;
    };
    // SAFETY: `DUPLICATE_CLOSE_SOURCE` with no target only closes `value` in
    // `process`; nothing in this process is touched.
    unsafe {
        DuplicateHandle(
            process.as_raw_handle(),
            value as HANDLE,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            FALSE,
            windows_sys::Win32::Foundation::DUPLICATE_CLOSE_SOURCE,
        )
    };
}

/// Runner side: take ownership of the socket handle the host duplicated into
/// this process as `value`.
///
/// # Errors
/// `InvalidInput` when `value` is not an open socket-like handle: null,
/// `INVALID_HANDLE_VALUE`, out of range, not a pipe-type file (sockets report
/// `FILE_TYPE_PIPE`) or a named pipe — such as this runner's own channel. The
/// handle is then left alone, not closed.
///
/// # Safety
/// If `value` passes the checks, this process must own it (the host
/// duplicated it here for this reply) and nothing else may use or close it.
pub unsafe fn adopt(value: u64) -> io::Result<OwnedHandle> {
    let refused = || {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the duplicated bridge handle is not a socket",
        )
    };
    let raw = usize::try_from(value).map_err(|_| refused())? as HANDLE;
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(refused());
    }
    // SAFETY: `GetFileType` only inspects the handle; an invalid one yields
    // `FILE_TYPE_UNKNOWN`.
    if unsafe { GetFileType(raw) } != FILE_TYPE_PIPE {
        return Err(refused());
    }
    // A socket is not a named pipe; the channel (or any pipe) is.
    // SAFETY: null out-parameters are allowed; the call only queries.
    let is_named_pipe = unsafe {
        GetNamedPipeInfo(
            raw,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } != 0;
    if is_named_pipe {
        return Err(refused());
    }
    // SAFETY: the caller transfers ownership of the duplicated handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

/// A connected socket driven as an overlapped file handle (no Winsock).
///
/// Reads and writes block until they complete. Each runs on its calling
/// thread's own completion event, so a read blocked on one thread never holds
/// up a write on another. End of stream (the peer, or the host's shutdown)
/// reads as `0`.
#[derive(Debug)]
pub struct SocketStream {
    handle: OwnedHandle,
}

impl SocketStream {
    /// Wrap a socket handle opened for overlapped I/O (Winsock creates them
    /// so by default; [`adopt`] yields one).
    #[must_use]
    pub fn new(handle: OwnedHandle) -> Self {
        Self { handle }
    }

    fn raw(&self) -> HANDLE {
        self.handle.as_raw_handle()
    }
}

impl Read for &SocketStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let handle = self.raw();
        let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
        let data = buf.as_mut_ptr();
        // SAFETY: `data` is valid for `len` bytes for the whole operation:
        // `overlapped` does not return before it completed.
        let result = overlapped(handle, None, |ov| unsafe {
            ReadFile(handle, data, len, std::ptr::null_mut(), ov)
        });
        match result {
            Ok(read) => Ok(read as usize),
            Err(e) if is_os_error(&e, ERROR_HANDLE_EOF) || is_os_error(&e, ERROR_BROKEN_PIPE) => {
                Ok(0)
            }
            Err(e) => Err(e),
        }
    }
}

impl Write for &SocketStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let handle = self.raw();
        let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
        let data = buf.as_ptr();
        // SAFETY: as for `read`: `data` outlives the operation.
        let written = overlapped(handle, None, |ov| unsafe {
            WriteFile(handle, data, len, std::ptr::null_mut(), ov)
        })?;
        Ok(written as usize)
    }

    /// A socket buffers nothing on this side.
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Read for SocketStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        (&*self).read(buf)
    }
}

impl Write for SocketStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        (&*self).write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        (&*self).flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::os::windows::io::{AsHandle, AsRawSocket, IntoRawHandle};

    /// A connected loopback pair: (ours, the peer's).
    fn tcp_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let ours = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (peer, _) = listener.accept().unwrap();
        (ours, peer)
    }

    fn socket_handle(stream: &TcpStream) -> BorrowedHandle<'_> {
        // SAFETY: a base-provider socket is a kernel handle, valid while
        // `stream` lives.
        unsafe { BorrowedHandle::borrow_raw(stream.as_raw_socket() as HANDLE) }
    }

    /// This process as a real (not pseudo) handle, as the host holds a
    /// runner's.
    fn this_process() -> OwnedHandle {
        // SAFETY: the current-process pseudo handle is always valid.
        unsafe { BorrowedHandle::borrow_raw(GetCurrentProcess()) }
            .try_clone_to_owned()
            .unwrap()
    }

    /// Duplicate `ours` the way the host does (into this process) and adopt it.
    fn duplicated(ours: &TcpStream) -> SocketStream {
        let process = this_process();
        let value = duplicate_into(process.as_handle(), socket_handle(ours)).unwrap();
        // SAFETY: freshly duplicated into this process for this test.
        SocketStream::new(unsafe { adopt(value) }.unwrap())
    }

    #[test]
    fn a_duplicated_socket_round_trips_bytes_without_winsock_calls() {
        let (ours, mut peer) = tcp_pair();
        let mut stream = duplicated(&ours);
        stream.write_all(b"ping").unwrap();
        let mut got = [0u8; 4];
        peer.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"ping");
        peer.write_all(b"pong").unwrap();
        stream.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"pong");
    }

    #[test]
    fn a_blocked_read_does_not_stall_a_write() {
        let (ours, mut peer) = tcp_pair();
        let stream = std::sync::Arc::new(duplicated(&ours));
        let reader = {
            let stream = std::sync::Arc::clone(&stream);
            std::thread::spawn(move || {
                let mut buf = [0u8; 2];
                (&*stream).read_exact(&mut buf).map(|()| buf)
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        (&*stream).write_all(b"go").unwrap();
        let mut got = [0u8; 2];
        peer.read_exact(&mut got).unwrap();
        peer.write_all(&got).unwrap();
        assert_eq!(&reader.join().unwrap().unwrap(), b"go");
    }

    #[test]
    fn the_peer_closing_reads_as_end_of_stream() {
        let (ours, peer) = tcp_pair();
        let mut stream = duplicated(&ours);
        drop(peer);
        let mut buf = [0u8; 8];
        // A graceful close is end of stream; an abortive one an error. Either
        // way the read returns.
        assert!(matches!(stream.read(&mut buf), Ok(0) | Err(_)));
    }

    /// The host's shutdown of its own handle ends a read blocked on the
    /// runner's duplicate (how a released or closed session ends it).
    #[test]
    fn the_hosts_shutdown_ends_a_blocked_read() {
        let (ours, _peer) = tcp_pair();
        let stream = duplicated(&ours);
        let reader = std::thread::spawn(move || {
            let mut buf = [0u8; 8];
            (&stream).read(&mut buf)
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
        ours.shutdown(Shutdown::Both).unwrap();
        assert!(matches!(reader.join().unwrap(), Ok(0) | Err(_)));
    }

    /// A duplicate that never reached its target is closed there: once the
    /// host also drops its own socket, the peer sees end of stream (it would
    /// not while any handle on the connection stayed open).
    #[test]
    fn close_in_closes_a_duplicate_the_target_never_adopted() {
        let (ours, mut peer) = tcp_pair();
        let process = this_process();
        let value = duplicate_into(process.as_handle(), socket_handle(&ours)).unwrap();
        close_in(process.as_handle(), value);
        drop(ours);
        peer.set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut buf = [0u8; 1];
        assert_eq!(peer.read(&mut buf).unwrap(), 0);
    }

    #[test]
    fn hostile_handle_values_are_refused_untouched() {
        // SAFETY: none of these values is owned; adopt refuses them.
        unsafe {
            assert!(adopt(0).is_err());
            assert!(adopt(INVALID_HANDLE_VALUE as usize as u64).is_err());
            assert!(adopt(u64::MAX).is_err());
            assert!(adopt(0x7fff_fff0).is_err(), "a value nobody opened");
        }
        // The runner's own channel pipe is a pipe-type handle too: refused,
        // and still usable afterwards.
        let (host, runner) = super::super::pipe::PipeStream::pair().unwrap();
        let runner = runner.into_raw_handle();
        // SAFETY: an open pipe handle; adopt must refuse it without owning it.
        assert!(unsafe { adopt(runner as usize as u64) }.is_err());
        // SAFETY: still ours.
        let mut runner =
            super::super::pipe::PipeStream::from(unsafe { OwnedHandle::from_raw_handle(runner) });
        (&host).write_all(b"ok").unwrap();
        let mut got = [0u8; 2];
        runner.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"ok");
        // A plain file is not a socket either.
        let file = tempfile::tempfile().unwrap();
        let raw = file.as_raw_handle();
        // SAFETY: an open file handle; refused without being owned.
        assert!(unsafe { adopt(raw as usize as u64) }.is_err());
    }
}
