//! The ABI shim: the real 1.x ABI objects the runner hands a plugin, each one
//! backed by the IPC channel to the host.
//!
//! * [`output_sender`] — a `PluginOutputSender` whose `send` writes one
//!   `Output` frame straight to the channel (no thread hop on the hot path).
//! * [`SessionServices`] — the ABI 1.1 services: `log` becomes a `Log` frame,
//!   `is_cancelled` reads atomics the host sets with `Cancel` frames.
//!
//! The capability bridge lives in [`super::bridge`] (#4183).
//!
//! Every callback is `extern "C"`, tolerates a null context, and contains
//! panics — nothing unwinds into plugin frames.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use termihub_plugin_api::{
    FfiByteSlice, FfiStr, PluginHostServices, PluginHostServicesVTable, PluginOutputSender,
    PluginStatus, MAX_LOG_MESSAGE_BYTES,
};
use termihub_plugin_runner::ipc::{encode_data_frame, FrameKind, Log, Message};

use super::channel::Channel;

/// Per-session output state behind a [`PluginOutputSender`] context.
pub(crate) struct SessionOutput {
    session_id: u32,
    channel: Arc<Channel>,
    /// Set when the host closed the session: later sends are dropped with
    /// `ChannelClosed` instead of reaching the host for an unknown session.
    /// A mutex, not an atomic, so a send that passed the check finishes its
    /// write before [`mark_closed`](Self::mark_closed) returns — no `Output`
    /// frame can follow the session's `Closed` frame.
    closed: Mutex<bool>,
}

impl SessionOutput {
    pub(crate) fn new(session_id: u32, channel: Arc<Channel>) -> Arc<Self> {
        Arc::new(Self {
            session_id,
            channel,
            closed: Mutex::new(false),
        })
    }

    pub(crate) fn mark_closed(&self) {
        *self.closed.lock().unwrap_or_else(|e| e.into_inner()) = true;
    }

    fn send(&self, data: &[u8]) -> PluginStatus {
        let closed = self.closed.lock().unwrap_or_else(|e| e.into_inner());
        if *closed {
            return PluginStatus::ChannelClosed;
        }
        // Split oversize chunks: a frame carries at most 1 MiB.
        for chunk in data.chunks(super::MAX_OUTPUT_CHUNK) {
            let frame = match encode_data_frame(FrameKind::Output, self.session_id, chunk) {
                Ok(frame) => frame,
                Err(_) => return PluginStatus::Other,
            };
            if self.channel.send_encoded(&frame).is_err() {
                return PluginStatus::ChannelClosed;
            }
        }
        PluginStatus::Ok
    }
}

/// Build the plugin's output sender for one session. The sender owns one
/// strong reference on `output`, released by its `destroy`.
pub(crate) fn output_sender(output: &Arc<SessionOutput>) -> PluginOutputSender {
    let ctx = Arc::into_raw(Arc::clone(output))
        .cast_mut()
        .cast::<c_void>();
    // SAFETY: `ctx` is one leaked strong reference on a `SessionOutput`, which
    // `output_send` borrows and `output_destroy` gives back exactly once.
    unsafe { PluginOutputSender::from_raw(ctx, output_send, Some(output_destroy)) }
}

unsafe extern "C" fn output_send(ctx: *mut c_void, data: FfiByteSlice) -> PluginStatus {
    std::panic::catch_unwind(|| {
        // SAFETY: `ctx` is the live `Arc<SessionOutput>` pointer the sender owns.
        let Some(output) = (unsafe { ctx.cast::<SessionOutput>().cast_const().as_ref() }) else {
            return PluginStatus::Other;
        };
        // SAFETY: the plugin guarantees `data` is valid for the call.
        output.send(unsafe { data.as_slice() })
    })
    .unwrap_or(PluginStatus::Panic)
}

unsafe extern "C" fn output_destroy(ctx: *mut c_void) {
    if ctx.is_null() {
        return;
    }
    let _ = std::panic::catch_unwind(|| {
        // SAFETY: gives back the single reference leaked in `output_sender`.
        drop(unsafe { Arc::from_raw(ctx.cast::<SessionOutput>().cast_const()) });
    });
}

/// ABI 1.1 services state for one session.
pub(crate) struct SessionServices {
    session_id: u32,
    channel: Arc<Channel>,
    session_cancelled: AtomicBool,
    plugin_shutdown: Arc<AtomicBool>,
}

impl SessionServices {
    pub(crate) fn new(
        session_id: u32,
        channel: Arc<Channel>,
        plugin_shutdown: Arc<AtomicBool>,
    ) -> Arc<Self> {
        Arc::new(Self {
            session_id,
            channel,
            session_cancelled: AtomicBool::new(false),
            plugin_shutdown,
        })
    }

    pub(crate) fn cancel(&self) {
        self.session_cancelled.store(true, Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.session_cancelled.load(Ordering::SeqCst) || self.plugin_shutdown.load(Ordering::SeqCst)
    }

    /// A new FFI handle owning one reference on `state`.
    pub(crate) fn handle(state: &Arc<Self>) -> PluginHostServices {
        let ctx = Arc::into_raw(Arc::clone(state)).cast_mut().cast::<c_void>();
        // SAFETY: `ctx` carries one leaked strong reference that the handle
        // adopts and `services_release` gives back; every callback interprets
        // `ctx` as exactly an `Arc<SessionServices>` pointer.
        unsafe { PluginHostServices::from_raw(ctx, &SERVICES_VTABLE) }
    }
}

static SERVICES_VTABLE: PluginHostServicesVTable = PluginHostServicesVTable {
    retain: services_retain,
    release: services_release,
    log: services_log,
    is_cancelled: services_is_cancelled,
};

/// # Safety
///
/// A non-null `ctx` must be a pointer from [`SessionServices::handle`] on which
/// the caller holds a live reference.
unsafe fn services<'a>(ctx: *mut c_void) -> Option<&'a SessionServices> {
    // SAFETY: caller contract; `as_ref` handles null.
    unsafe { ctx.cast::<SessionServices>().cast_const().as_ref() }
}

unsafe extern "C" fn services_retain(ctx: *mut c_void) {
    if ctx.is_null() {
        return;
    }
    let _ = std::panic::catch_unwind(|| {
        // SAFETY: the caller holds a live reference on this `Arc` pointer.
        unsafe { Arc::increment_strong_count(ctx.cast::<SessionServices>().cast_const()) };
    });
}

unsafe extern "C" fn services_release(ctx: *mut c_void) {
    if ctx.is_null() {
        return;
    }
    let _ = std::panic::catch_unwind(|| {
        // SAFETY: releases exactly the reference the caller owns.
        unsafe { Arc::decrement_strong_count(ctx.cast::<SessionServices>().cast_const()) };
    });
}

unsafe extern "C" fn services_is_cancelled(ctx: *mut c_void) -> bool {
    std::panic::catch_unwind(|| {
        // SAFETY: the caller holds a live reference on `ctx` (or it is null).
        unsafe { services(ctx) }.is_none_or(SessionServices::is_cancelled)
    })
    .unwrap_or(true)
}

unsafe extern "C" fn services_log(ctx: *mut c_void, level: u32, message: FfiStr) -> PluginStatus {
    std::panic::catch_unwind(|| {
        // SAFETY: the caller holds a live reference on `ctx` (or it is null).
        let Some(state) = (unsafe { services(ctx) }) else {
            return PluginStatus::Other;
        };
        if termihub_plugin_api::PluginLogLevel::from_wire(level).is_none() {
            return PluginStatus::InvalidConfig;
        }
        // Read at most the bound of the plugin's buffer, never past it. The
        // host re-checks the bound, rate-limits and sanitises (untrusted peer).
        let bounded = message.len.min(MAX_LOG_MESSAGE_BYTES);
        let bytes: &[u8] = if bounded == 0 || message.ptr.is_null() {
            &[]
        } else {
            // SAFETY: the plugin promises `ptr` is valid for `len` bytes for
            // the call; we read a prefix of that range only.
            unsafe { std::slice::from_raw_parts(message.ptr, bounded) }
        };
        let log = Message::Log(Log {
            session_id: Some(state.session_id),
            level,
            message: String::from_utf8_lossy(bytes).into_owned(),
            truncated: message.len > MAX_LOG_MESSAGE_BYTES,
            denied: None,
        });
        // A dropped line (channel gone) still reports `Ok`, as the host does.
        let _ = state.channel.send(&log);
        PluginStatus::Ok
    })
    .unwrap_or(PluginStatus::Panic)
}
