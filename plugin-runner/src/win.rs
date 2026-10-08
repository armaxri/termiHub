//! Small Win32 helpers shared by the Windows channel ([`crate::ipc::pipe`])
//! and the job-object spawn ([`crate::process`]).

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle};

use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};

/// Take ownership of a handle a Win32 call just returned, turning the two
/// failure sentinels (`NULL`, `INVALID_HANDLE_VALUE`) into the thread's last
/// OS error.
pub(crate) fn owned(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the caller hands over a fresh handle from a successful Win32
    // call; nothing else owns or closes it.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

/// `s` as a NUL-terminated UTF-16 string; an interior NUL is refused (Win32
/// would silently truncate there).
pub(crate) fn to_wide(s: &OsStr) -> io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = s.encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "string contains an interior NUL",
        ));
    }
    wide.push(0);
    Ok(wide)
}

/// An OS error from a `WIN32_ERROR` code.
pub(crate) fn os_error(code: u32) -> io::Error {
    // Win32 error codes fit in an `i32`; `from_raw_os_error` wants one.
    io::Error::from_raw_os_error(i32::try_from(code).unwrap_or(i32::MAX))
}

/// Whether `error` is the Win32 error `code`.
pub(crate) fn is_os_error(error: &io::Error, code: u32) -> bool {
    error
        .raw_os_error()
        .is_some_and(|raw| u32::try_from(raw).is_ok_and(|raw| raw == code))
}
