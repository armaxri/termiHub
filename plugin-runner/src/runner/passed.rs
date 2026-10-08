//! The plugin-facing [`PluginTcpStream`] over a bridge socket the host
//! duplicated into this runner (Windows, #4219).
//!
//! The plugin sees the same 1.x stream it gets on Unix: an
//! opaque `state` plus `read` / `write` / `destroy`. Behind it is a
//! [`SocketStream`] — the socket driven as an overlapped file handle, never
//! through Winsock (which cannot start under LPAC) — and the connection's
//! release guard, dropped after the socket so the host's slot is freed only
//! once this side closed it.

use std::ffi::c_void;
use std::io::{Read, Write};

use termihub_plugin_api::{FfiByteSlice, PluginStatus, PluginTcpStream, PluginTcpStreamVTable};
use termihub_plugin_runner::ipc::handle::SocketStream;

/// The state behind a passed-socket [`PluginTcpStream`]. Field order matters:
/// `socket` closes before `_release` tells the host.
struct PassedStream {
    socket: SocketStream,
    _release: Box<dyn Send>,
}

/// Hand `socket` to the plugin; `release` runs when the plugin drops it.
pub(super) fn into_plugin_stream(socket: SocketStream, release: Box<dyn Send>) -> PluginTcpStream {
    PluginTcpStream {
        state: Box::into_raw(Box::new(PassedStream {
            socket,
            _release: release,
        }))
        .cast::<c_void>(),
        vtable: &PASSED_STREAM_VTABLE,
    }
}

static PASSED_STREAM_VTABLE: PluginTcpStreamVTable = PluginTcpStreamVTable {
    read: passed_read,
    write: passed_write,
    destroy: passed_destroy,
};

unsafe extern "C" fn passed_read(
    state: *mut c_void,
    buf: *mut u8,
    len: usize,
    out_read: *mut usize,
) -> PluginStatus {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: `state` is the live `PassedStream` behind this handle.
        let Some(stream) = (unsafe { state.cast::<PassedStream>().cast_const().as_ref() }) else {
            return PluginStatus::Other;
        };
        if out_read.is_null() || (buf.is_null() && len > 0) {
            return PluginStatus::Other;
        }
        let slice: &mut [u8] = if len == 0 {
            &mut []
        } else {
            // SAFETY: the plugin owns `buf` for `len` bytes for the call.
            unsafe { std::slice::from_raw_parts_mut(buf, len) }
        };
        match (&stream.socket).read(slice) {
            Ok(n) => {
                // SAFETY: `out_read` is the plugin's valid out-parameter.
                unsafe { out_read.write(n) };
                PluginStatus::Ok
            }
            Err(_) => PluginStatus::Io,
        }
    }))
    .unwrap_or(PluginStatus::Panic)
}

unsafe extern "C" fn passed_write(
    state: *mut c_void,
    data: FfiByteSlice,
    out_written: *mut usize,
) -> PluginStatus {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: `state` is the live `PassedStream` behind this handle.
        let Some(stream) = (unsafe { state.cast::<PassedStream>().cast_const().as_ref() }) else {
            return PluginStatus::Other;
        };
        if out_written.is_null() {
            return PluginStatus::Other;
        }
        // SAFETY: the plugin passes a slice valid for the call.
        let bytes = unsafe { data.as_slice() };
        match (&stream.socket).write(bytes) {
            Ok(n) => {
                // SAFETY: `out_written` is the plugin's valid out-parameter.
                unsafe { out_written.write(n) };
                PluginStatus::Ok
            }
            Err(_) => PluginStatus::Io,
        }
    }))
    .unwrap_or(PluginStatus::Panic)
}

unsafe extern "C" fn passed_destroy(state: *mut c_void) {
    if state.is_null() {
        return;
    }
    let _ = std::panic::catch_unwind(|| {
        // SAFETY: reclaims the box leaked in `into_plugin_stream`, exactly once.
        drop(unsafe { Box::from_raw(state.cast::<PassedStream>()) });
    });
}
