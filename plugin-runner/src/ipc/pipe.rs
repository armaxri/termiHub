//! The Windows runner channel (#4201): a private, single-instance, duplex
//! named pipe, driven with overlapped `ReadFile` / `WriteFile` on both ends.
//!
//! * **Private.** The host creates the pipe under a random 128-bit name with
//!   `FILE_FLAG_FIRST_PIPE_INSTANCE` (it fails if anyone already owns that
//!   name), one instance at most, `PIPE_REJECT_REMOTE_CLIENTS`, and a protected
//!   DACL granting the current user's SID only ([`PipeStream::pair_with_access`]
//!   takes the extra SIDs the AppContainer phase adds, #4187). The host then
//!   opens the client end itself, which occupies the single instance — nobody
//!   else can connect afterwards — and passes that handle to the runner by
//!   inheritance ([`crate::process`]). No name is ever handed to the runner.
//! * **No Winsock.** Under LPAC `WSAStartup` fails and std's lazy Winsock
//!   initialisation panics (spike #4181), so the runner never touches sockets
//!   or `std::net` for its channel: it is a plain file handle.
//! * **Overlapped on both ends.** A synchronous handle serialises every
//!   operation on its file object, so the runner's reader thread blocked in
//!   `ReadFile` would stall every plugin thread's `WriteFile` (and the host's
//!   writers behind its reader the same way). Overlapped I/O lets one thread
//!   read while others write, and gives the host the read / write deadlines a
//!   socket has ([`ChannelStream`]). Each operation waits on a per-thread
//!   event; a deadline cancels it (`CancelIoEx`) and waits for the
//!   cancellation before its `OVERLAPPED` goes out of scope.
//!
//! The same overlapped `ReadFile` / `WriteFile` drive a connected socket handle
//! the host duplicates into the runner, which is how bridge sockets will be
//! handed over on Windows (#4219).

use std::io::{self, Read, Write};
use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    GetLastError, SetHandleInformation, BOOL, ERROR_BROKEN_PIPE, ERROR_IO_PENDING,
    ERROR_OPERATION_ABORTED, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, FALSE, GENERIC_READ,
    GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, TRUE, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFileType, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE,
    FILE_FLAG_OVERLAPPED, FILE_TYPE_PIPE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
    SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

use super::transport::ChannelStream;
use crate::win::{is_os_error, os_error, owned, to_wide};

/// Requested in- and out-buffer size of the pipe (advisory; the system may
/// adjust it). Large enough that a 64 KiB output burst crosses in one write.
pub const PIPE_BUFFER: u32 = 1024 * 1024;

/// Every runner pipe's name starts with this; a random 128-bit hex suffix
/// follows.
pub const PIPE_NAME_PREFIX: &str = r"\\.\pipe\termihub-plugin-runner-";

/// How long the host waits for its own client end to register as connected.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// One end of a runner channel pipe. Clones ([`ChannelStream::try_clone`])
/// share the handle and the timeouts, like clones of a socket.
#[derive(Debug)]
pub struct PipeStream {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    handle: OwnedHandle,
    read_timeout: Mutex<Option<Duration>>,
    write_timeout: Mutex<Option<Duration>>,
}

impl PipeStream {
    /// Create a private channel: the host's end, and the runner's end to be
    /// passed by inheritance. Only the current user's SID is granted access.
    pub fn pair() -> io::Result<(PipeStream, OwnedHandle)> {
        Self::pair_with_access(&[])
    }

    /// [`pair`](Self::pair), also granting `extra_sids` (string SIDs such as
    /// an AppContainer's `S-1-15-2-…`) access to the pipe.
    pub fn pair_with_access(extra_sids: &[&str]) -> io::Result<(PipeStream, OwnedHandle)> {
        let name = format!("{PIPE_NAME_PREFIX}{}", random_suffix()?);
        create(&name, extra_sids)
    }

    /// Take over the channel handle the host passed this process by
    /// inheritance, given by its value. The handle must be a pipe; it is made
    /// non-inheritable again so nothing this process starts inherits it.
    ///
    /// # Errors
    /// `InvalidInput` when `value` is not an open pipe handle (it is then left
    /// alone, not closed).
    ///
    /// # Safety
    /// If `value` is an open pipe handle, this process must own it and nothing
    /// else may use or close it afterwards.
    pub unsafe fn from_inherited(value: usize) -> io::Result<Self> {
        // Handle values are small integers that cross the command line.
        let raw = value as HANDLE;
        // SAFETY: `GetFileType` only inspects the handle; an invalid one
        // yields `FILE_TYPE_UNKNOWN`.
        if raw.is_null()
            || raw == INVALID_HANDLE_VALUE
            || unsafe { GetFileType(raw) } != FILE_TYPE_PIPE
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the inherited channel is not a pipe handle",
            ));
        }
        // Keep the channel out of any process a plugin might start (best
        // effort, like `FD_CLOEXEC` on Unix).
        // SAFETY: plain flag change on a handle the caller vouches we own.
        unsafe { SetHandleInformation(raw, HANDLE_FLAG_INHERIT, 0) };
        // SAFETY: the caller transfers ownership of the pipe handle.
        Ok(Self::from(unsafe { OwnedHandle::from_raw_handle(raw) }))
    }

    fn raw(&self) -> HANDLE {
        self.inner.handle.as_raw_handle()
    }
}

impl From<OwnedHandle> for PipeStream {
    /// Wrap a pipe handle opened with `FILE_FLAG_OVERLAPPED`. (A synchronous
    /// handle still works, but then a read blocks concurrent writes.)
    fn from(handle: OwnedHandle) -> Self {
        Self {
            inner: Arc::new(Inner {
                handle,
                read_timeout: Mutex::new(None),
                write_timeout: Mutex::new(None),
            }),
        }
    }
}

impl AsHandle for PipeStream {
    fn as_handle(&self) -> BorrowedHandle<'_> {
        self.inner.handle.as_handle()
    }
}

/// The value a handle has in this process — and, once inherited, in the child.
#[must_use]
pub fn handle_value(handle: BorrowedHandle<'_>) -> usize {
    handle.as_raw_handle() as usize
}

impl ChannelStream for PipeStream {
    fn try_clone(&self) -> io::Result<Self> {
        Ok(Self {
            inner: Arc::clone(&self.inner),
        })
    }

    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        *lock(&self.inner.read_timeout) = checked_timeout(timeout)?;
        Ok(())
    }

    fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        *lock(&self.inner.write_timeout) = checked_timeout(timeout)?;
        Ok(())
    }
}

impl Read for &PipeStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let handle = self.raw();
        let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
        let data = buf.as_mut_ptr();
        let timeout = *lock(&self.inner.read_timeout);
        // SAFETY: `data` is valid for `len` bytes for the whole operation:
        // `overlapped` does not return before it completed or was cancelled.
        let result = overlapped(handle, timeout, |ov| unsafe {
            ReadFile(handle, data, len, std::ptr::null_mut(), ov)
        });
        match result {
            Ok(read) => Ok(read as usize),
            // The other end closed its handle: end of stream.
            Err(e)
                if is_os_error(&e, ERROR_BROKEN_PIPE)
                    || is_os_error(&e, ERROR_PIPE_NOT_CONNECTED) =>
            {
                Ok(0)
            }
            Err(e) => Err(e),
        }
    }
}

impl Write for &PipeStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let handle = self.raw();
        let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
        let data = buf.as_ptr();
        let timeout = *lock(&self.inner.write_timeout);
        // SAFETY: as for `read`: `data` outlives the operation.
        let written = overlapped(handle, timeout, |ov| unsafe {
            WriteFile(handle, data, len, std::ptr::null_mut(), ov)
        })?;
        Ok(written as usize)
    }

    /// Nothing is buffered on this side; `FlushFileBuffers` would block until
    /// the peer read everything, which a frame writer must not wait for.
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Read for PipeStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        (&*self).read(buf)
    }
}

impl Write for PipeStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        (&*self).write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        (&*self).flush()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// A zero timeout is refused, as `UnixStream` refuses it.
fn checked_timeout(timeout: Option<Duration>) -> io::Result<Option<Duration>> {
    if timeout == Some(Duration::ZERO) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cannot set a 0 duration timeout",
        ));
    }
    Ok(timeout)
}

/// Create the pipe `name` and connect the host's own client end to it.
fn create(name: &str, extra_sids: &[&str]) -> io::Result<(PipeStream, OwnedHandle)> {
    let security = security::Descriptor::granting(extra_sids)?;
    let wide = to_wide(name.as_ref())?;
    // SAFETY: `wide` is NUL-terminated and `security` outlives the call.
    let server = owned(unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            PIPE_BUFFER,
            PIPE_BUFFER,
            0,
            security.attributes(),
        )
    })?;
    // The client end: overlapped too (see the module docs). SQOS keeps the
    // pipe server from impersonating beyond identification.
    // SAFETY: `wide` is NUL-terminated; no template handle.
    let client = owned(unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            std::ptr::null_mut(),
        )
    })?;
    let raw = server.as_raw_handle();
    // The client is already connected, so this reports `ERROR_PIPE_CONNECTED`.
    // SAFETY: plain call on the server handle we own.
    match overlapped(raw, Some(CONNECT_TIMEOUT), |ov| unsafe {
        ConnectNamedPipe(raw, ov)
    }) {
        Ok(_) => {}
        Err(e) if is_os_error(&e, ERROR_PIPE_CONNECTED) => {}
        Err(e) => return Err(e),
    }
    Ok((PipeStream::from(server), client))
}

/// 128 random bits as lowercase hex (`BCryptGenRandom`, the system RNG).
fn random_suffix() -> io::Result<String> {
    use windows_sys::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };
    let mut bytes = [0u8; 16];
    // SAFETY: `bytes` is writable for its full length; no algorithm handle is
    // needed with `BCRYPT_USE_SYSTEM_PREFERRED_RNG`.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(io::Error::other(format!(
            "BCryptGenRandom failed: {status:#x}"
        )));
    }
    Ok(hex::encode(bytes))
}

thread_local! {
    /// This thread's completion event for overlapped operations (manual
    /// reset; every `ReadFile` / `WriteFile` / `ConnectNamedPipe` resets it
    /// when it starts).
    static IO_EVENT: Option<OwnedHandle> = new_event().ok();
}

fn new_event() -> io::Result<OwnedHandle> {
    // SAFETY: an unnamed, manual-reset, initially non-signalled event.
    owned(unsafe { CreateEventW(std::ptr::null(), TRUE, FALSE, std::ptr::null()) })
}

/// Run one overlapped operation on `handle` and wait for it, at most
/// `timeout`. `start` issues the call with the prepared `OVERLAPPED`.
///
/// Returns the bytes transferred; an expired deadline cancels the operation
/// and fails with [`io::ErrorKind::TimedOut`] (unless it completed meanwhile).
fn overlapped(
    handle: HANDLE,
    timeout: Option<Duration>,
    start: impl FnOnce(*mut OVERLAPPED) -> BOOL,
) -> io::Result<u32> {
    // The thread's cached event, or (while thread-locals are torn down) a
    // fresh one for this operation.
    let fallback;
    let event = match IO_EVENT.try_with(|event| event.as_ref().map(AsRawHandle::as_raw_handle)) {
        Ok(Some(event)) => event,
        _ => {
            fallback = new_event()?;
            fallback.as_raw_handle()
        }
    };
    // SAFETY: an all-zero `OVERLAPPED` is valid (offset 0, no event yet).
    let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
    ov.hEvent = event;
    if start(&mut ov) == 0 {
        // SAFETY: reads the calling thread's last error.
        let error = unsafe { GetLastError() };
        if error != ERROR_IO_PENDING {
            return Err(os_error(error));
        }
        if let Some(timeout) = timeout {
            // SAFETY: `event` is a valid event handle for this whole call.
            let waited = unsafe { WaitForSingleObject(event, wait_millis(timeout)) };
            if waited != WAIT_OBJECT_0 {
                // The deadline passed (or the wait failed): cancel, then wait
                // for the cancellation — `ov` must outlive the operation.
                // SAFETY: cancels only this operation, identified by `ov`.
                unsafe { CancelIoEx(handle, &ov) };
                return match finish(handle, &ov) {
                    // It completed before the cancellation landed.
                    Ok(done) => Ok(done),
                    Err(e)
                        if waited == WAIT_TIMEOUT && is_os_error(&e, ERROR_OPERATION_ABORTED) =>
                    {
                        Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "plugin runner pipe operation timed out",
                        ))
                    }
                    Err(e) => Err(e),
                };
            }
        }
    }
    finish(handle, &ov)
}

/// Wait for the operation behind `ov` and return its byte count.
fn finish(handle: HANDLE, ov: &OVERLAPPED) -> io::Result<u32> {
    let mut transferred = 0u32;
    // SAFETY: `ov` belongs to an operation issued on `handle`; `TRUE` waits
    // until it is no longer pending.
    if unsafe { GetOverlappedResult(handle, ov, &mut transferred, TRUE) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(transferred)
}

/// `timeout` in whole milliseconds for `WaitForSingleObject`, rounded up and
/// kept below `INFINITE`.
fn wait_millis(timeout: Duration) -> u32 {
    let millis = timeout.as_nanos().div_ceil(1_000_000);
    u32::try_from(millis)
        .unwrap_or(INFINITE - 1)
        .min(INFINITE - 1)
}

/// The pipe's security descriptor.
mod security {
    use std::io;

    use windows_sys::Win32::Foundation::{LocalFree, HANDLE, HLOCAL, TRUE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    use crate::win::{owned, to_wide};

    /// A protected DACL granting `GENERIC_ALL` to the current user and to the
    /// given extra SIDs, and nobody else; non-inheritable attributes for it.
    pub(super) struct Descriptor {
        descriptor: PSECURITY_DESCRIPTOR,
        attributes: SECURITY_ATTRIBUTES,
    }

    impl Descriptor {
        pub(super) fn granting(extra_sids: &[&str]) -> io::Result<Self> {
            let mut sddl = format!("D:P(A;;GA;;;{})", current_user_sid()?);
            for sid in extra_sids {
                if !is_sid_string(sid) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("`{sid}` is not a SID"),
                    ));
                }
                sddl.push_str(&format!("(A;;GA;;;{sid})"));
            }
            let wide = to_wide(sddl.as_ref())?;
            let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            // SAFETY: `wide` is NUL-terminated; `descriptor` receives a
            // `LocalAlloc`ed descriptor freed on drop.
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self {
                descriptor,
                attributes: SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: descriptor,
                    bInheritHandle: 0,
                },
            })
        }

        pub(super) fn attributes(&self) -> *const SECURITY_ATTRIBUTES {
            &self.attributes
        }
    }

    impl Drop for Descriptor {
        fn drop(&mut self) {
            // SAFETY: allocated by `ConvertStringSecurityDescriptorToSecurityDescriptorW`.
            unsafe { LocalFree(self.descriptor as HLOCAL) };
        }
    }

    /// `S-1-<digits and dashes>`: what may be spliced into the SDDL string.
    fn is_sid_string(sid: &str) -> bool {
        sid.strip_prefix("S-1-").is_some_and(|rest| {
            !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit() || b == b'-')
        })
    }

    /// The current process user's SID in string form.
    fn current_user_sid() -> io::Result<String> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: the pseudo handle of this process; `token` receives a new
        // handle owned below.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = owned(token)?;
        let raw = std::os::windows::io::AsRawHandle::as_raw_handle(&token);
        let mut len = 0u32;
        // Sizing call: expected to fail with the needed length.
        // SAFETY: a null buffer of length 0 only queries the size.
        unsafe { GetTokenInformation(raw, TokenUser, std::ptr::null_mut(), 0, &mut len) };
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        // `u64` storage keeps the `TOKEN_USER` header pointer-aligned.
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        // SAFETY: `buf` holds at least `len` writable bytes.
        let ok =
            unsafe { GetTokenInformation(raw, TokenUser, buf.as_mut_ptr().cast(), len, &mut len) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the call filled `buf` with a `TOKEN_USER` (aligned, see above).
        let user = unsafe { &*buf.as_ptr().cast::<TOKEN_USER>() };
        let mut wide: *mut u16 = std::ptr::null_mut();
        // SAFETY: `user.User.Sid` points into `buf`, alive for the call.
        if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut wide) } != TRUE {
            return Err(io::Error::last_os_error());
        }
        let mut chars = 0usize;
        // SAFETY: `wide` is a NUL-terminated string `LocalAlloc`ed by the call.
        let sid = unsafe {
            while *wide.add(chars) != 0 {
                chars += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(wide, chars))
        };
        // SAFETY: allocated by `ConvertSidToStringSidW`.
        unsafe { LocalFree(wide as HLOCAL) };
        Ok(sid)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn only_sid_strings_are_accepted() {
            assert!(is_sid_string("S-1-15-2-1-2-3"));
            assert!(!is_sid_string("S-1-"));
            assert!(!is_sid_string("WD"));
            assert!(!is_sid_string("S-1-5)(A;;GA;;;WD"));
        }

        #[test]
        fn the_current_user_sid_resolves() {
            assert!(current_user_sid().unwrap().starts_with("S-1-"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::windows::io::IntoRawHandle;
    use std::time::Instant;

    fn pair() -> (PipeStream, PipeStream) {
        let (host, runner) = PipeStream::pair().unwrap();
        (host, PipeStream::from(runner))
    }

    #[test]
    fn bytes_cross_in_both_directions() {
        let (mut host, mut runner) = pair();
        host.write_all(b"to runner").unwrap();
        runner.write_all(b"to host").unwrap();
        let mut buf = [0u8; 9];
        runner.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"to runner");
        let mut buf = [0u8; 7];
        host.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"to host");
    }

    /// The reason both ends are overlapped: a read blocked on one thread must
    /// not hold up a write on the same handle from another.
    #[test]
    fn a_blocked_read_does_not_stall_a_write_on_the_same_handle() {
        let (host, runner) = pair();
        let reader = runner.try_clone().unwrap();
        let blocked = std::thread::spawn(move || {
            let mut buf = [0u8; 4];
            (&reader).read_exact(&mut buf).map(|()| buf)
        });
        std::thread::sleep(Duration::from_millis(100));
        (&runner).write_all(b"pong").unwrap();
        let mut buf = [0u8; 4];
        (&host).read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"pong");
        (&host).write_all(b"ping").unwrap();
        assert_eq!(&blocked.join().unwrap().unwrap(), b"ping");
    }

    #[test]
    fn a_read_deadline_times_out_and_the_channel_stays_usable() {
        let (host, runner) = pair();
        host.set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let started = Instant::now();
        let err = (&host).read(&mut [0u8; 8]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= Duration::from_millis(90));
        (&runner).write_all(b"late").unwrap();
        let mut buf = [0u8; 4];
        (&host).read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"late");
        assert!(host.set_read_timeout(Some(Duration::ZERO)).is_err());
    }

    #[test]
    fn closing_one_end_is_end_of_stream_and_a_broken_pipe() {
        let (host, runner) = pair();
        drop(runner);
        assert_eq!((&host).read(&mut [0u8; 8]).unwrap(), 0);
        let err = (&host).write_all(b"gone").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn the_pipe_is_single_instance_and_its_name_cannot_be_reused() {
        let name = format!("{PIPE_NAME_PREFIX}{}", random_suffix().unwrap());
        let (_host, _runner) = create(&name, &[]).unwrap();
        // A second server under the name is refused (first-instance flag)…
        assert!(create(&name, &[]).is_err());
        // …and so is a second client: the one instance is taken.
        let wide = to_wide(name.as_ref()).unwrap();
        // SAFETY: plain open attempt; any handle returned is owned below.
        let other = owned(unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                std::ptr::null_mut(),
            )
        });
        assert!(other.is_err(), "a second client connected");
    }

    #[test]
    fn names_are_random() {
        assert_ne!(random_suffix().unwrap(), random_suffix().unwrap());
        assert_eq!(random_suffix().unwrap().len(), 32);
    }

    #[test]
    fn an_inherited_value_that_is_not_a_pipe_is_refused_and_left_open() {
        let file = tempfile::tempfile().unwrap();
        let value = handle_value(file.as_handle());
        // SAFETY: the value is a file, not a pipe: refused without taking it.
        assert!(unsafe { PipeStream::from_inherited(value) }.is_err());
        // SAFETY: zero is never a handle.
        assert!(unsafe { PipeStream::from_inherited(0) }.is_err());
        // Still open and usable.
        assert!(file.metadata().is_ok());
    }

    #[test]
    fn an_inherited_pipe_value_is_taken_over() {
        let (host, runner) = PipeStream::pair().unwrap();
        // Release ownership: the value now belongs to the stream.
        let value = runner.into_raw_handle() as usize;
        // SAFETY: `value` is the pipe handle we just released.
        let runner = unsafe { PipeStream::from_inherited(value) }.unwrap();
        (&runner).write_all(b"ok").unwrap();
        let mut buf = [0u8; 2];
        (&host).read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"ok");
    }
}
