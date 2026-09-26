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
///
/// **Frozen for ABI 1.x.** This table lives in the *plugin* (it is compiled from
/// the plugin's copy of this crate), so a newer host must never read past the
/// entries an older-minor plugin was built with. New per-backend behavior in a
/// later minor is therefore exposed through a new optional exported symbol that
/// the host resolves only when the plugin's ABI supports that minor — never by
/// growing this struct (see [`crate::version`]).
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

#[cfg(test)]
mod tests {
    //! FFI teardown/drop soundness for the backend handle (TBE-010): the wrapper
    //! must release its backing FFI resource exactly once — never twice (a
    //! double-free) and never zero times (a leak) — and a panic in the backend's
    //! own `Drop` must be contained rather than unwound across the ABI.
    use super::*;

    use core::sync::atomic::{AtomicUsize, Ordering};

    /// Never dereferenced by the recording destructors below, so a dangling
    /// (non-null) `state` is fine for a pure drop-count probe.
    fn dangling_state() -> *mut c_void {
        core::ptr::NonNull::<c_void>::dangling().as_ptr()
    }

    unsafe extern "C" fn stub_write(_s: *mut c_void, _d: FfiByteSlice) -> PluginStatus {
        PluginStatus::Ok
    }
    unsafe extern "C" fn stub_resize(_s: *mut c_void, _c: u16, _r: u16) -> PluginStatus {
        PluginStatus::Ok
    }
    unsafe extern "C" fn stub_is_alive(_s: *mut c_void) -> bool {
        true
    }

    #[test]
    fn drop_calls_destroy_exactly_once() {
        // The backend's `state` is freed by exactly one `destroy` call on drop —
        // the no-double-free / no-leak guarantee the ABI's ownership rule rests on.
        static DESTROYS: AtomicUsize = AtomicUsize::new(0);
        unsafe extern "C" fn count_destroy(_s: *mut c_void) {
            DESTROYS.fetch_add(1, Ordering::SeqCst);
        }
        unsafe extern "C" fn stub_close(_s: *mut c_void) -> PluginStatus {
            PluginStatus::Ok
        }
        DESTROYS.store(0, Ordering::SeqCst);

        let vtable = PluginBackendVTable {
            write_input: stub_write,
            resize: stub_resize,
            close: stub_close,
            is_alive: stub_is_alive,
            destroy: count_destroy,
        };
        let raw = PluginBackend {
            state: dangling_state(),
            vtable: &vtable,
        };
        // SAFETY: `vtable` outlives the wrapper (dropped below, still in scope);
        // `count_destroy` ignores `state`, so a dangling pointer is sound here.
        let backend = unsafe { LoadedBackend::from_raw(raw) };
        assert_eq!(DESTROYS.load(Ordering::SeqCst), 0);
        drop(backend);
        assert_eq!(
            DESTROYS.load(Ordering::SeqCst),
            1,
            "destroy must run exactly once on drop — no double-free, no leak"
        );
    }

    #[test]
    fn graceful_close_then_drop_releases_once_each() {
        // Models the host adapter's disconnect path: a graceful `close()` followed
        // by the wrapper dropping. `close` runs once and `destroy` runs exactly
        // once afterwards — closing does not free the state, and dropping frees it
        // a single time.
        static CLOSES: AtomicUsize = AtomicUsize::new(0);
        static DESTROYS: AtomicUsize = AtomicUsize::new(0);
        unsafe extern "C" fn count_close(_s: *mut c_void) -> PluginStatus {
            CLOSES.fetch_add(1, Ordering::SeqCst);
            PluginStatus::Ok
        }
        unsafe extern "C" fn count_destroy(_s: *mut c_void) {
            DESTROYS.fetch_add(1, Ordering::SeqCst);
        }
        CLOSES.store(0, Ordering::SeqCst);
        DESTROYS.store(0, Ordering::SeqCst);

        let vtable = PluginBackendVTable {
            write_input: stub_write,
            resize: stub_resize,
            close: count_close,
            is_alive: stub_is_alive,
            destroy: count_destroy,
        };
        let raw = PluginBackend {
            state: dangling_state(),
            vtable: &vtable,
        };
        // SAFETY: as in the previous test — `vtable` outlives the wrapper and the
        // recording callbacks ignore `state`.
        let backend = unsafe { LoadedBackend::from_raw(raw) };
        backend.close().expect("stub close returns Ok");
        assert_eq!(CLOSES.load(Ordering::SeqCst), 1);
        assert_eq!(
            DESTROYS.load(Ordering::SeqCst),
            0,
            "close must not free the backend state"
        );
        drop(backend);
        assert_eq!(
            DESTROYS.load(Ordering::SeqCst),
            1,
            "destroy runs exactly once, after the graceful close"
        );
    }

    #[test]
    fn panicking_backend_drop_is_contained_not_unwound() {
        // A plugin backend whose own `Drop` panics must NOT unwind across the FFI
        // `destroy` boundary (that is undefined behavior). `from_boxed` installs
        // the shared `VTABLE`, whose `vt_destroy` wraps the drop in `catch_unwind`;
        // if the unwind escaped, this test would abort/propagate instead of pass.
        struct PanicsOnDrop;
        impl PluginTerminalBackend for PanicsOnDrop {
            fn write_input(&self, _d: &[u8]) -> Result<(), PluginError> {
                Ok(())
            }
            fn resize(&self, _c: u16, _r: u16) -> Result<(), PluginError> {
                Ok(())
            }
            fn close(&self) -> Result<(), PluginError> {
                Ok(())
            }
            fn is_alive(&self) -> bool {
                true
            }
        }
        impl Drop for PanicsOnDrop {
            fn drop(&mut self) {
                panic!("boom in plugin backend drop");
            }
        }

        // SAFETY: `from_boxed` produces a valid backend backed by the shared VTABLE.
        let backend =
            unsafe { LoadedBackend::from_raw(PluginBackend::from_boxed(Box::new(PanicsOnDrop))) };
        // The panic is contained by `vt_destroy`; the drop returns normally.
        drop(backend);
    }
}
