//! Output channel a plugin backend uses to push terminal data to the host.

use core::ffi::c_void;

use crate::error::{PluginError, PluginStatus};
use crate::ffi::FfiByteSlice;

/// Signature of the host-provided output callback.
///
/// Receives the opaque host context and the bytes to deliver, and returns a
/// status (notably [`PluginStatus::ChannelClosed`] once the session is gone).
pub type PluginOutputSendFn =
    unsafe extern "C" fn(ctx: *mut c_void, data: FfiByteSlice) -> PluginStatus;

/// Signature of the destructor for the host-provided output context.
pub type PluginOutputDestroyFn = unsafe extern "C" fn(ctx: *mut c_void);

/// FFI-safe sink a plugin backend writes terminal output into.
///
/// The host constructs it (see [`PluginOutputSender::from_sender`]) and passes
/// it **by value** to `plugin_create_backend`; the plugin then owns it, stores
/// it in its backend, and calls [`PluginOutputSender::send`] whenever the child
/// process produces output. When the backend is dropped, so is the sender, which
/// runs the host-provided `destroy` callback.
///
/// This replaces the concept's `std::sync::mpsc::SyncSender<Vec<u8>>`, which
/// could not cross the ABI boundary (its layout is not stable), with an
/// opaque-context + `extern "C"` function pointer that can.
#[repr(C)]
pub struct PluginOutputSender {
    ctx: *mut c_void,
    send: PluginOutputSendFn,
    destroy: Option<PluginOutputDestroyFn>,
}

// SAFETY: the sender uniquely owns `ctx`, and the host guarantees (by
// constructing it from a `Send` sink) that invoking `send`/`destroy` from the
// plugin's threads is sound. Backends run off the UI thread, so this must be
// `Send`.
unsafe impl Send for PluginOutputSender {}

impl PluginOutputSender {
    /// Assemble a sender from raw FFI parts.
    ///
    /// Mainly for the host loader and for plugins that already hold raw
    /// callbacks; most host code should prefer [`PluginOutputSender::from_sender`].
    ///
    /// # Safety
    ///
    /// * `send` (and `destroy`, if any) must be safe to call with `ctx`.
    /// * `ctx` must remain valid until `destroy` is invoked, and ownership of it
    ///   is transferred to the returned sender.
    #[must_use]
    pub unsafe fn from_raw(
        ctx: *mut c_void,
        send: PluginOutputSendFn,
        destroy: Option<PluginOutputDestroyFn>,
    ) -> Self {
        Self { ctx, send, destroy }
    }

    /// Deliver `data` to the host.
    ///
    /// Returns [`PluginError::ChannelClosed`] once the host side has gone away.
    pub fn send(&self, data: &[u8]) -> Result<(), PluginError> {
        // SAFETY: `send`/`ctx` were validated at construction and `ctx` is still
        // owned by `self`.
        let status = unsafe { (self.send)(self.ctx, FfiByteSlice::from_slice(data)) };
        status.into_result()
    }
}

impl Drop for PluginOutputSender {
    fn drop(&mut self) {
        if let Some(destroy) = self.destroy.take() {
            // SAFETY: called once (guarded by taking `destroy`) with the `ctx`
            // this sender has owned since construction.
            unsafe { destroy(self.ctx) };
        }
    }
}

/// Host-side helpers, gated behind nothing — always available so tests and the
/// loader can wire a real channel to a plugin.
impl PluginOutputSender {
    /// Build a sender backed by an `std::sync::mpsc::Sender<Vec<u8>>`.
    ///
    /// This is the host-side convenience matching the concept's channel model:
    /// bytes the plugin sends arrive as `Vec<u8>` on the paired `Receiver`. Each
    /// [`PluginOutputSender::send`] copies the bytes into an owned `Vec` before
    /// they cross back, so no borrowed pointer escapes the call.
    #[must_use]
    pub fn from_sender(sender: std::sync::mpsc::Sender<Vec<u8>>) -> Self {
        let boxed = Box::new(sender);
        let ctx = Box::into_raw(boxed).cast::<c_void>();
        // SAFETY: `ctx` is a `Box<Sender<Vec<u8>>>` we just leaked; `send`/
        // `destroy` below only ever interpret it as exactly that, and `destroy`
        // reclaims it.
        unsafe { Self::from_raw(ctx, mpsc_send, Some(mpsc_destroy)) }
    }
}

/// `send` callback for [`PluginOutputSender::from_sender`].
///
/// # Safety
///
/// `ctx` must be a live `*mut std::sync::mpsc::Sender<Vec<u8>>`.
unsafe extern "C" fn mpsc_send(ctx: *mut c_void, data: FfiByteSlice) -> PluginStatus {
    // SAFETY: `ctx` is the leaked `Box<Sender<Vec<u8>>>`; borrowing it shared is
    // fine because `Sender::send` takes `&self`. `data` is a valid borrowed
    // slice for the duration of this call.
    let result = std::panic::catch_unwind(|| {
        let sender = unsafe { &*ctx.cast::<std::sync::mpsc::Sender<Vec<u8>>>() };
        let bytes = unsafe { data.as_slice() }.to_vec();
        sender.send(bytes)
    });
    match result {
        Ok(Ok(())) => PluginStatus::Ok,
        Ok(Err(_)) => PluginStatus::ChannelClosed,
        Err(_) => PluginStatus::Panic,
    }
}

/// `destroy` callback for [`PluginOutputSender::from_sender`].
///
/// # Safety
///
/// `ctx` must be the leaked `Box<std::sync::mpsc::Sender<Vec<u8>>>` and must not
/// be used afterwards.
unsafe extern "C" fn mpsc_destroy(ctx: *mut c_void) {
    if !ctx.is_null() {
        // SAFETY: reclaims the box leaked in `from_sender`, exactly once.
        drop(unsafe { Box::from_raw(ctx.cast::<std::sync::mpsc::Sender<Vec<u8>>>()) });
    }
}
