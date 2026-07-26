//! The terminal-backend contract: a safe Rust trait for plugin authors, and the
//! stable `#[repr(C)]` vtable that actually crosses the ABI.
//!
//! ## Why not `*mut dyn PluginTerminalBackend`
//!
//! The originating concept sketched
//! `extern "C" fn plugin_create_backend(...) -> *mut dyn PluginTerminalBackend`.
//! A `*mut dyn Trait` is a **fat pointer** carrying a pointer to a Rust vtable
//! whose layout is not part of any stable ABI. Passing it between a host and a
//! plugin built with a different compiler/version is undefined behavior. This
//! module instead exposes:
//!
//! * an **opaque state pointer** (`*mut c_void`) the host never dereferences, and
//! * a `#[repr(C)]` [`PluginBackendVTable`] of `extern "C"` function pointers,
//!
//! so only thin, FFI-safe pointers ever cross. The plugin's real
//! `Box<dyn PluginTerminalBackend>` stays entirely inside the plugin.

use core::ffi::c_void;
use std::panic::AssertUnwindSafe;

use crate::error::{PluginError, PluginStatus};
use crate::ffi::FfiByteSlice;

/// The behavior a plugin terminal backend implements. Plugin authors write a
/// normal Rust type implementing this trait; [`PluginBackend::from_boxed`] wraps
/// it into the FFI-safe representation.
///
/// Mirrors the host's internal process-handle contract (`write_input`, `resize`,
/// `close`, `is_alive`) so a plugin backend slots into the same session
/// machinery as the built-in backends.
///
/// Implementations must be [`Send`]: backends live off the UI thread and are
/// driven from session-manager / RPC threads.
pub trait PluginTerminalBackend: Send {
    /// Write input bytes (keystrokes / control sequences) to the session.
    fn write_input(&self, data: &[u8]) -> Result<(), PluginError>;

    /// Resize the session's terminal to `cols` x `rows`.
    fn resize(&self, cols: u16, rows: u16) -> Result<(), PluginError>;

    /// Gracefully close the session, releasing its resources.
    fn close(&self) -> Result<(), PluginError>;

    /// Report whether the underlying session is still running.
    fn is_alive(&self) -> bool;
}

/// Boxed trait object, double-boxed so a **thin** pointer represents it across
/// the ABI. `*mut BoxedBackend` is thin (a pointer to the fat `Box`), whereas
/// `*mut dyn PluginTerminalBackend` would be fat.
type BoxedBackend = Box<dyn PluginTerminalBackend>;

/// Stable, `#[repr(C)]` table of `extern "C"` function pointers implementing the
/// backend behavior against an opaque state pointer.
///
/// Every function takes the backend's opaque `state` (produced by
/// [`PluginBackend::from_boxed`]) as its first argument. All are
/// `unsafe extern "C"`: they dereference `state` and must only be called with a
/// `state` produced by the same plugin.
#[repr(C)]
pub struct PluginBackendVTable {
    /// See [`PluginTerminalBackend::write_input`].
    pub write_input: unsafe extern "C" fn(state: *mut c_void, data: FfiByteSlice) -> PluginStatus,
    /// See [`PluginTerminalBackend::resize`].
    pub resize: unsafe extern "C" fn(state: *mut c_void, cols: u16, rows: u16) -> PluginStatus,
    /// See [`PluginTerminalBackend::close`].
    pub close: unsafe extern "C" fn(state: *mut c_void) -> PluginStatus,
    /// See [`PluginTerminalBackend::is_alive`].
    pub is_alive: unsafe extern "C" fn(state: *mut c_void) -> bool,
    /// Drop the backend and free its `state`. Called exactly once, by the host,
    /// when it is done with the backend.
    pub destroy: unsafe extern "C" fn(state: *mut c_void),
}

/// FFI-safe handle to a plugin-created backend: an opaque `state` pointer plus a
/// pointer to its (usually `'static`) [`PluginBackendVTable`].
///
/// Returned by out-parameter from `plugin_create_backend`. The host wraps it in
/// a [`LoadedBackend`] for safe use.
#[repr(C)]
pub struct PluginBackend {
    /// Opaque backend state; only the producing plugin may interpret it.
    pub state: *mut c_void,
    /// Pointer to the vtable implementing this backend's behavior.
    pub vtable: *const PluginBackendVTable,
}

impl PluginBackend {
    /// Wrap a boxed trait object into the FFI-safe representation.
    ///
    /// Call this inside a plugin's `plugin_create_backend` to hand a backend
    /// back to the host. The returned [`PluginBackend`] owns the box; it is
    /// released when the host calls the vtable's `destroy`.
    #[must_use]
    pub fn from_boxed(backend: BoxedBackend) -> Self {
        // Double-box: the outer `Box` is a thin pointer to the fat inner box, so
        // only a thin `*mut c_void` crosses the ABI.
        let boxed: Box<BoxedBackend> = Box::new(backend);
        Self {
            state: Box::into_raw(boxed).cast::<c_void>(),
            vtable: &VTABLE,
        }
    }
}

/// Run `f` (which borrows the backend from `state`) with a panic guard, mapping
/// its result to a status. Panics are contained rather than unwinding across
/// FFI, which would be undefined behavior.
///
/// # Safety
///
/// `state` must be a live `*mut BoxedBackend` produced by
/// [`PluginBackend::from_boxed`].
unsafe fn with_backend<F>(state: *mut c_void, f: F) -> PluginStatus
where
    F: FnOnce(&BoxedBackend) -> Result<(), PluginError>,
{
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: caller guarantees `state` is a live `*mut BoxedBackend`.
        let backend = unsafe { &*state.cast::<BoxedBackend>() };
        f(backend)
    }));
    match result {
        Ok(r) => PluginStatus::from_result(r),
        Err(_) => PluginStatus::Panic,
    }
}

unsafe extern "C" fn vt_write_input(state: *mut c_void, data: FfiByteSlice) -> PluginStatus {
    // SAFETY: `state` is a live backend; `data` is a valid borrowed slice for the
    // duration of the call.
    unsafe { with_backend(state, |b| b.write_input(data.as_slice())) }
}

unsafe extern "C" fn vt_resize(state: *mut c_void, cols: u16, rows: u16) -> PluginStatus {
    // SAFETY: `state` is a live backend.
    unsafe { with_backend(state, |b| b.resize(cols, rows)) }
}

unsafe extern "C" fn vt_close(state: *mut c_void) -> PluginStatus {
    // SAFETY: `state` is a live backend.
    unsafe { with_backend(state, |b| b.close()) }
}

unsafe extern "C" fn vt_is_alive(state: *mut c_void) -> bool {
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: `state` is a live `*mut BoxedBackend`.
        let backend = unsafe { &*state.cast::<BoxedBackend>() };
        backend.is_alive()
    }));
    result.unwrap_or(false)
}

unsafe extern "C" fn vt_destroy(state: *mut c_void) {
    if state.is_null() {
        return;
    }
    // SAFETY: reclaims the double-box leaked in `from_boxed`, exactly once.
    let boxed = unsafe { Box::from_raw(state.cast::<BoxedBackend>()) };
    // Contain any panic from the backend's `Drop` rather than unwinding across FFI.
    let _ = std::panic::catch_unwind(AssertUnwindSafe(move || drop(boxed)));
}

/// The single shared vtable. It is generic-free — every entry operates on
/// `BoxedBackend` — so one `'static` instance serves all backends.
static VTABLE: PluginBackendVTable = PluginBackendVTable {
    write_input: vt_write_input,
    resize: vt_resize,
    close: vt_close,
    is_alive: vt_is_alive,
    destroy: vt_destroy,
};

/// Safe host-side wrapper over a [`PluginBackend`].
///
/// Provides ergonomic, panic-guarded methods that dispatch through the vtable,
/// and drops the backend (via the vtable's `destroy`) when it goes out of scope.
/// The host loader (a separate issue) returns these to the session manager.
pub struct LoadedBackend {
    inner: PluginBackend,
}

// SAFETY: `PluginTerminalBackend: Send`, and the vtable functions only touch the
// owned backend state, so the wrapper is safe to move between threads.
unsafe impl Send for LoadedBackend {}

impl LoadedBackend {
    /// Adopt a raw [`PluginBackend`] returned by a plugin.
    ///
    /// # Safety
    ///
    /// `backend.state`/`backend.vtable` must be valid and produced by a
    /// compatible plugin, and ownership of them is transferred to the wrapper
    /// (which will call `destroy` exactly once, on drop).
    #[must_use]
    pub unsafe fn from_raw(backend: PluginBackend) -> Self {
        Self { inner: backend }
    }

    fn vtable(&self) -> &PluginBackendVTable {
        // SAFETY: `vtable` is a valid pointer for the wrapper's lifetime (upheld
        // by the `from_raw` contract; in-process backends point at `VTABLE`).
        unsafe { &*self.inner.vtable }
    }

    /// Write input bytes to the backend. See [`PluginTerminalBackend::write_input`].
    pub fn write_input(&self, data: &[u8]) -> Result<(), PluginError> {
        // SAFETY: `state` is owned and valid; `data` outlives the call.
        let status = unsafe {
            (self.vtable().write_input)(self.inner.state, FfiByteSlice::from_slice(data))
        };
        status.into_result()
    }

    /// Resize the backend's terminal. See [`PluginTerminalBackend::resize`].
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PluginError> {
        // SAFETY: `state` is owned and valid.
        let status = unsafe { (self.vtable().resize)(self.inner.state, cols, rows) };
        status.into_result()
    }

    /// Close the backend. See [`PluginTerminalBackend::close`].
    pub fn close(&self) -> Result<(), PluginError> {
        // SAFETY: `state` is owned and valid.
        let status = unsafe { (self.vtable().close)(self.inner.state) };
        status.into_result()
    }

    /// Report whether the backend is still alive. See
    /// [`PluginTerminalBackend::is_alive`].
    #[must_use]
    pub fn is_alive(&self) -> bool {
        // SAFETY: `state` is owned and valid.
        unsafe { (self.vtable().is_alive)(self.inner.state) }
    }
}

impl Drop for LoadedBackend {
    fn drop(&mut self) {
        // SAFETY: `state` is owned and valid; `destroy` is called exactly once.
        unsafe { (self.vtable().destroy)(self.inner.state) };
    }
}
