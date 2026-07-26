//! The **host-mediated capability bridge** (#2018).
//!
//! A native plugin backend runs as a dynamic library *inside the host process*,
//! so the host cannot intercept a plugin's own syscalls. The permission
//! primitives from the security layer (`PermissionSet`, `FilesystemScope`) are
//! therefore only enforceable at the surfaces the host itself mediates. This
//! module defines one such surface: a [`PluginHostBridge`] the host passes into
//! `plugin_create_backend`, through which a **cooperating** plugin performs
//! network and filesystem access *by asking the host to do it*. The host runs the
//! operation only after checking the plugin's declared permissions, so
//! `network`/`filesystem` are enforced **at runtime**, not merely declared at
//! load.
//!
//! ```text
//!   plugin                         host (owns the PermissionSet)
//!   ------                         -----------------------------
//!   bridge.open_connection(h,p) ─▶ require(Network)?  ─ no ─▶ PermissionDenied
//!                                        │ yes
//!                                        ▼
//!                                  TcpStream::connect ─▶ mediated PluginTcpStream
//!
//!   bridge.read_file(path)      ─▶ FilesystemScope::check(path)? ─ no ─▶ PermissionDenied
//!                                        │ yes
//!                                        ▼
//!                                  std::fs::read ─▶ owned bytes
//!
//!   bridge.write_file(p,d,mode) ─▶ FilesystemScope::check(p)?    ─ no ─▶ PermissionDenied
//!                                        │ yes
//!                                        ▼
//!                                  OpenOptions(mode) + write_all
//!
//!   bridge.stat(path)           ─▶ FilesystemScope::check(path)? ─ no ─▶ PermissionDenied
//!   bridge.list_dir(path)       ─▶ FilesystemScope::check(path)? ─ no ─▶ PermissionDenied
//! ```
//!
//! Every filesystem operation — read, write, append, create, stat, list —
//! resolves its path through the same [`FilesystemScope::check`] guard, so a
//! plugin can only touch paths inside its declared roots (out-of-scope and `..`
//! traversal are rejected before the host performs any I/O).
//!
//! [`FilesystemScope::check`]: https://docs.rs/termihub-core
//!
//! # What this does and does not enforce
//!
//! This bridge mediates the operations a plugin routes *through it*: for those,
//! the host is the one that opens the socket / reads the file, and it refuses
//! when the permission or path-scope check fails. It is **not** an OS sandbox — a
//! malicious plugin could still call `std::net::TcpStream::connect` or
//! `std::fs::read` directly and bypass the bridge entirely; stopping that needs
//! OS-level process isolation termiHub does not have (documented as future work
//! in the security module). The bridge realises concept §13's "the host can deny
//! network access even if requested" for the cooperative path, which is the
//! enforceable slice today.
//!
//! # ABI shape
//!
//! Like [`crate::output::PluginOutputSender`], everything here is an opaque
//! context pointer plus `#[repr(C)]` `extern "C"` function pointers — no `String`,
//! `dyn Trait`, or allocator crosses the boundary. The host builds the bridge (its
//! context owns the granted permission set) and hands it to the plugin by value;
//! the plugin owns it thereafter and drops it, running the host-provided
//! destructor.

use core::ffi::c_void;
use std::io::{Read, Write};

use crate::error::{PluginError, PluginStatus};
use crate::ffi::{FfiByteSlice, FfiOwnedBytes, FfiStr};

/// Signature of the host callback that opens a network connection on the plugin's
/// behalf. The host enforces the `network` permission before connecting; on
/// success it writes a mediated [`PluginTcpStream`] into `out_stream`.
pub type PluginOpenConnectionFn = unsafe extern "C" fn(
    ctx: *mut c_void,
    host: FfiStr,
    port: u16,
    out_stream: *mut PluginTcpStream,
) -> PluginStatus;

/// Signature of the host callback that reads a file on the plugin's behalf. The
/// host resolves and authorizes `path` against the plugin's declared filesystem
/// scope before reading; on success it writes the file's contents into
/// `out_bytes`.
pub type PluginReadFileFn = unsafe extern "C" fn(
    ctx: *mut c_void,
    path: FfiStr,
    out_bytes: *mut FfiOwnedBytes,
) -> PluginStatus;

/// How a mediated filesystem write should open its target file.
///
/// A `#[repr(i32)]` field-less enum so it is FFI-safe and stable across the ABI.
/// Every variant is confined to the plugin's declared scope by the host before
/// any file is opened.
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginWriteMode {
    /// Create the file if absent, **truncate** it if present, then write.
    Truncate = 0,
    /// Create the file if absent, **append** to it if present.
    Append = 1,
    /// **Create a new** file, failing with an I/O error if it already exists.
    CreateNew = 2,
}

/// Signature of the host callback that writes a file on the plugin's behalf. The
/// host resolves and authorizes `path` against the plugin's declared filesystem
/// scope, then opens it per `mode` and writes `data`.
pub type PluginWriteFileFn = unsafe extern "C" fn(
    ctx: *mut c_void,
    path: FfiStr,
    data: FfiByteSlice,
    mode: PluginWriteMode,
) -> PluginStatus;

/// FFI-safe filesystem metadata returned by a mediated [`stat`](PluginHostBridge::stat).
///
/// `#[repr(C)]` with only FFI-safe scalar fields. When `exists` is `false` the
/// other fields are meaningless (`is_dir == false`, `len == 0`).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PluginFileMetadata {
    /// Whether anything exists at the (in-scope) path.
    pub exists: bool,
    /// Whether the path is a directory. Only meaningful when `exists`.
    pub is_dir: bool,
    /// File size in bytes. `0` for directories and non-existent paths.
    pub len: u64,
}

impl PluginFileMetadata {
    /// The "nothing here" metadata for an in-scope path that does not exist.
    #[must_use]
    pub fn absent() -> Self {
        Self {
            exists: false,
            is_dir: false,
            len: 0,
        }
    }
}

/// Signature of the host callback that stats a path on the plugin's behalf. The
/// host authorizes `path` against the plugin's declared scope, then writes the
/// resolved [`PluginFileMetadata`] into `out_meta`. An in-scope but non-existent
/// path is **not** an error: it yields [`PluginFileMetadata::absent`].
pub type PluginStatPathFn = unsafe extern "C" fn(
    ctx: *mut c_void,
    path: FfiStr,
    out_meta: *mut PluginFileMetadata,
) -> PluginStatus;

/// Signature of the host callback that lists a directory on the plugin's behalf.
/// The host authorizes `path` against the plugin's declared scope, then writes
/// the directory's entry names — one per line, `\n`-separated, UTF-8
/// (lossily-encoded) — into `out_entries` as owned bytes.
pub type PluginListDirFn = unsafe extern "C" fn(
    ctx: *mut c_void,
    path: FfiStr,
    out_entries: *mut FfiOwnedBytes,
) -> PluginStatus;

/// Signature of the destructor for the host-provided bridge context.
pub type PluginBridgeDestroyFn = unsafe extern "C" fn(ctx: *mut c_void);

/// FFI-safe handle to the host's capability bridge.
///
/// Constructed by the host (its `ctx` owns the session's granted permission set),
/// passed **by value** into `plugin_create_backend`, then owned by the plugin's
/// backend. A plugin calls [`open_connection`](PluginHostBridge::open_connection)
/// and [`read_file`](PluginHostBridge::read_file) on it; both route through the
/// host's permission checks. Dropping the bridge runs the host-provided
/// `destroy`, releasing the context.
#[repr(C)]
pub struct PluginHostBridge {
    ctx: *mut c_void,
    open_connection: PluginOpenConnectionFn,
    read_file: PluginReadFileFn,
    write_file: PluginWriteFileFn,
    stat_path: PluginStatPathFn,
    list_dir: PluginListDirFn,
    destroy: Option<PluginBridgeDestroyFn>,
}

// SAFETY: the bridge uniquely owns `ctx`; the host guarantees (by constructing it
// from a `Send + Sync` permission set and thread-safe operations) that invoking
// the callbacks from the plugin's threads is sound. Backends run off the UI
// thread and may be driven from several threads, so this must be `Send + Sync`.
unsafe impl Send for PluginHostBridge {}
unsafe impl Sync for PluginHostBridge {}

impl PluginHostBridge {
    /// Assemble a bridge from raw FFI parts.
    ///
    /// For the host loader (and tests wiring a bridge directly). Most host code
    /// builds the bridge through the higher-level constructor in
    /// `termihub_core::plugin` that binds it to a session's `PermissionSet`.
    ///
    /// # Safety
    ///
    /// * `open_connection`, `read_file`, `write_file`, `stat_path`, `list_dir`
    ///   and `destroy` (if any) must be safe to call with `ctx`.
    /// * `ctx` must remain valid until `destroy` is invoked; ownership of it is
    ///   transferred to the returned bridge.
    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn from_raw(
        ctx: *mut c_void,
        open_connection: PluginOpenConnectionFn,
        read_file: PluginReadFileFn,
        write_file: PluginWriteFileFn,
        stat_path: PluginStatPathFn,
        list_dir: PluginListDirFn,
        destroy: Option<PluginBridgeDestroyFn>,
    ) -> Self {
        Self {
            ctx,
            open_connection,
            read_file,
            write_file,
            stat_path,
            list_dir,
            destroy,
        }
    }

    /// Ask the host to open a TCP connection to `host:port`.
    ///
    /// The host refuses with [`PluginError::PermissionDenied`] unless the plugin
    /// holds the `network` permission; otherwise it connects and returns a
    /// mediated [`HostTcpStream`] the plugin can read from and write to.
    pub fn open_connection(&self, host: &str, port: u16) -> Result<HostTcpStream, PluginError> {
        let mut stream = PluginTcpStream::null();
        // SAFETY: `ctx`/`open_connection` were validated at construction; `host`
        // outlives the call; `&mut stream` is a valid out-parameter the host fills
        // in on `Ok`.
        let status =
            unsafe { (self.open_connection)(self.ctx, FfiStr::new(host), port, &mut stream) };
        status.into_result()?;
        // SAFETY: on `Ok` the host wrote a live, host-owned stream handle whose
        // ownership now transfers to the wrapper.
        Ok(unsafe { HostTcpStream::from_raw(stream) })
    }

    /// Ask the host to read the file at `path`.
    ///
    /// The host refuses with [`PluginError::PermissionDenied`] unless the plugin
    /// holds the `filesystem` permission *and* `path` resolves inside its declared
    /// scope; otherwise it returns the file's contents.
    pub fn read_file(&self, path: &str) -> Result<Vec<u8>, PluginError> {
        let mut bytes = FfiOwnedBytes::empty();
        // SAFETY: `ctx`/`read_file` were validated at construction; `path` outlives
        // the call; `&mut bytes` is a valid out-parameter the host fills in on `Ok`.
        let status = unsafe { (self.read_file)(self.ctx, FfiStr::new(path), &mut bytes) };
        status.into_result()?;
        Ok(bytes.into_vec())
    }

    /// Ask the host to write `data` to the file at `path`, opening it per `mode`.
    ///
    /// The host refuses with [`PluginError::PermissionDenied`] unless the plugin
    /// holds the `filesystem` permission *and* `path` resolves inside its declared
    /// scope. Prefer the [`write_new`](Self::write_new), [`overwrite`](Self::overwrite)
    /// and [`append`](Self::append) convenience wrappers.
    pub fn write_file(
        &self,
        path: &str,
        data: &[u8],
        mode: PluginWriteMode,
    ) -> Result<(), PluginError> {
        // SAFETY: `ctx`/`write_file` were validated at construction; `path` and
        // `data` outlive the call.
        let status = unsafe {
            (self.write_file)(
                self.ctx,
                FfiStr::new(path),
                FfiByteSlice::from_slice(data),
                mode,
            )
        };
        status.into_result()
    }

    /// Create-or-truncate the file at `path` and write `data`
    /// ([`PluginWriteMode::Truncate`]).
    pub fn overwrite(&self, path: &str, data: &[u8]) -> Result<(), PluginError> {
        self.write_file(path, data, PluginWriteMode::Truncate)
    }

    /// Append `data` to the file at `path`, creating it if absent
    /// ([`PluginWriteMode::Append`]).
    pub fn append(&self, path: &str, data: &[u8]) -> Result<(), PluginError> {
        self.write_file(path, data, PluginWriteMode::Append)
    }

    /// Create a **new** file at `path` and write `data`, failing if it already
    /// exists ([`PluginWriteMode::CreateNew`]).
    pub fn write_new(&self, path: &str, data: &[u8]) -> Result<(), PluginError> {
        self.write_file(path, data, PluginWriteMode::CreateNew)
    }

    /// Ask the host for filesystem metadata about `path`.
    ///
    /// The host refuses with [`PluginError::PermissionDenied`] unless `path`
    /// resolves inside the plugin's declared scope. An in-scope path that does
    /// not exist is reported as [`PluginFileMetadata::absent`], not an error.
    pub fn stat(&self, path: &str) -> Result<PluginFileMetadata, PluginError> {
        let mut meta = PluginFileMetadata::absent();
        // SAFETY: `ctx`/`stat_path` were validated at construction; `path` outlives
        // the call; `&mut meta` is a valid out-parameter the host fills in on `Ok`.
        let status = unsafe { (self.stat_path)(self.ctx, FfiStr::new(path), &mut meta) };
        status.into_result()?;
        Ok(meta)
    }

    /// Ask the host to list the directory at `path`, returning its entry names.
    ///
    /// The host refuses with [`PluginError::PermissionDenied`] unless `path`
    /// resolves inside the plugin's declared scope. Entry names are the final
    /// path component only, in the host's directory order.
    pub fn list_dir(&self, path: &str) -> Result<Vec<String>, PluginError> {
        let mut entries = FfiOwnedBytes::empty();
        // SAFETY: `ctx`/`list_dir` were validated at construction; `path` outlives
        // the call; `&mut entries` is a valid out-parameter the host fills in on `Ok`.
        let status = unsafe { (self.list_dir)(self.ctx, FfiStr::new(path), &mut entries) };
        status.into_result()?;
        let joined = String::from_utf8_lossy(&entries.into_vec()).into_owned();
        Ok(joined.lines().map(str::to_owned).collect())
    }
}

impl Drop for PluginHostBridge {
    fn drop(&mut self) {
        if let Some(destroy) = self.destroy.take() {
            // SAFETY: called once (guarded by taking `destroy`) with the `ctx` this
            // bridge has owned since construction.
            unsafe { destroy(self.ctx) };
        }
    }
}

/// Stable `#[repr(C)]` vtable of a host-mediated TCP stream.
///
/// The host owns the real socket (behind the opaque `state`); the plugin drives
/// it through these `extern "C"` pointers, so no OS handle crosses the ABI.
#[repr(C)]
pub struct PluginTcpStreamVTable {
    /// Read up to `len` bytes into `buf`, writing the count read into `out_read`
    /// (0 at end-of-stream).
    pub read: unsafe extern "C" fn(
        state: *mut c_void,
        buf: *mut u8,
        len: usize,
        out_read: *mut usize,
    ) -> PluginStatus,
    /// Write `data`, writing the count written into `out_written`.
    pub write: unsafe extern "C" fn(
        state: *mut c_void,
        data: FfiByteSlice,
        out_written: *mut usize,
    ) -> PluginStatus,
    /// Drop the stream and free its `state`. Called exactly once.
    pub destroy: unsafe extern "C" fn(state: *mut c_void),
}

/// FFI-safe handle to a host-mediated TCP stream: an opaque host-owned `state`
/// plus a pointer to its vtable. A null `state`/`vtable` denotes "no stream".
#[repr(C)]
pub struct PluginTcpStream {
    /// Opaque host-owned stream state; only the host may interpret it.
    pub state: *mut c_void,
    /// Pointer to the vtable implementing this stream's behavior.
    pub vtable: *const PluginTcpStreamVTable,
}

impl PluginTcpStream {
    /// The "no stream" sentinel the plugin passes as the out-parameter.
    #[must_use]
    pub fn null() -> Self {
        Self {
            state: std::ptr::null_mut(),
            vtable: std::ptr::null(),
        }
    }

    /// Wrap a host-owned [`std::net::TcpStream`] into the FFI-safe handle.
    ///
    /// Host-side constructor: the returned handle owns the stream and frees it
    /// when the plugin drops its [`HostTcpStream`] wrapper (via the vtable's
    /// `destroy`).
    #[must_use]
    pub fn from_std(stream: std::net::TcpStream) -> Self {
        Self::from_mediated(MediatedTcpStream {
            stream,
            _guard: None,
        })
    }

    /// Wrap a host-owned [`std::net::TcpStream`] together with a host-side drop
    /// `guard` that runs when the plugin drops the stream.
    ///
    /// The guard lets the host release a per-session resource the connection
    /// reserved — a concurrent-connection slot in the session's connection policy
    /// (#2028), say — the moment the mediated stream is closed. Like the stream
    /// itself, the guard is opaque host state behind the handle's `state` pointer:
    /// it never crosses the FFI boundary.
    #[must_use]
    pub fn from_std_guarded(stream: std::net::TcpStream, guard: StreamDropGuard) -> Self {
        Self::from_mediated(MediatedTcpStream {
            stream,
            _guard: Some(guard),
        })
    }

    /// Box the host-owned [`MediatedTcpStream`] state behind the shared vtable.
    fn from_mediated(state: MediatedTcpStream) -> Self {
        Self {
            state: Box::into_raw(Box::new(state)).cast::<c_void>(),
            vtable: &TCP_STREAM_VTABLE,
        }
    }
}

/// A host-side drop guard carried by a mediated [`PluginTcpStream`].
///
/// It runs (host-side) when the plugin drops the stream, so the host can release
/// whatever per-session resource the connection reserved — for example a
/// concurrent-connection slot in the session's connection policy (#2028). It is
/// **opaque host state**: it lives behind the stream's `state` pointer and is
/// never handed across the FFI boundary, so `dyn Send` here does not weaken the
/// ABI's "no trait objects cross the boundary" guarantee.
pub type StreamDropGuard = Box<dyn Send>;

/// Host-owned state behind a mediated [`PluginTcpStream`]: the real socket plus an
/// optional [`StreamDropGuard`].
///
/// Declaration order matters: `stream` is dropped **before** `_guard`, so the
/// socket is closed before the guard releases the session resource it accounts
/// for.
struct MediatedTcpStream {
    /// The host-owned socket the plugin drives through the vtable.
    stream: std::net::TcpStream,
    /// Optional guard dropped after `stream`; `None` for unguarded streams.
    _guard: Option<StreamDropGuard>,
}

unsafe extern "C" fn tcp_vt_read(
    state: *mut c_void,
    buf: *mut u8,
    len: usize,
    out_read: *mut usize,
) -> PluginStatus {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: `state` is a live `*mut MediatedTcpStream` produced by
        // `from_mediated`; `buf`/`len` describe a writable region the plugin owns
        // for the call.
        let stream = unsafe { &mut (*state.cast::<MediatedTcpStream>()).stream };
        let slice = if len == 0 {
            &mut [][..]
        } else {
            unsafe { std::slice::from_raw_parts_mut(buf, len) }
        };
        stream.read(slice)
    }));
    match result {
        Ok(Ok(n)) => {
            // SAFETY: `out_read` is a valid, writable pointer supplied by the plugin.
            unsafe { out_read.write(n) };
            PluginStatus::Ok
        }
        Ok(Err(_)) => PluginStatus::Io,
        Err(_) => PluginStatus::Panic,
    }
}

unsafe extern "C" fn tcp_vt_write(
    state: *mut c_void,
    data: FfiByteSlice,
    out_written: *mut usize,
) -> PluginStatus {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: `state` is a live `*mut MediatedTcpStream`; `data` is a valid
        // borrowed slice for the duration of the call.
        let stream = unsafe { &mut (*state.cast::<MediatedTcpStream>()).stream };
        let bytes = unsafe { data.as_slice() };
        stream.write(bytes)
    }));
    match result {
        Ok(Ok(n)) => {
            // SAFETY: `out_written` is a valid, writable pointer supplied by the plugin.
            unsafe { out_written.write(n) };
            PluginStatus::Ok
        }
        Ok(Err(_)) => PluginStatus::Io,
        Err(_) => PluginStatus::Panic,
    }
}

unsafe extern "C" fn tcp_vt_destroy(state: *mut c_void) {
    if state.is_null() {
        return;
    }
    // SAFETY: reclaims the box leaked in `from_mediated`, exactly once. Dropping
    // it closes the socket, then runs any [`StreamDropGuard`] the stream carried.
    let boxed = unsafe { Box::from_raw(state.cast::<MediatedTcpStream>()) };
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || drop(boxed)));
}

/// The single shared TCP-stream vtable — generic-free, so one `'static` instance
/// serves every mediated stream.
static TCP_STREAM_VTABLE: PluginTcpStreamVTable = PluginTcpStreamVTable {
    read: tcp_vt_read,
    write: tcp_vt_write,
    destroy: tcp_vt_destroy,
};

/// Safe, plugin-side wrapper over a host-mediated [`PluginTcpStream`].
///
/// Implements [`Read`] and [`Write`], so a plugin uses it like any socket while
/// the host owns the underlying connection. Dropping it frees the host's stream
/// via the vtable's `destroy`.
pub struct HostTcpStream {
    inner: PluginTcpStream,
}

// SAFETY: the wrapper uniquely owns the host stream state; the vtable functions
// only touch that owned state. Backends run off the UI thread.
unsafe impl Send for HostTcpStream {}

impl HostTcpStream {
    /// Adopt a raw [`PluginTcpStream`] returned by the host bridge.
    ///
    /// # Safety
    ///
    /// `stream.state`/`stream.vtable` must be valid and produced by a compatible
    /// host, and ownership of them transfers to the wrapper (which calls `destroy`
    /// exactly once, on drop).
    #[must_use]
    pub unsafe fn from_raw(stream: PluginTcpStream) -> Self {
        Self { inner: stream }
    }

    fn vtable(&self) -> &PluginTcpStreamVTable {
        // SAFETY: `vtable` is valid for the wrapper's lifetime (upheld by the
        // `from_raw` contract; host streams point at `TCP_STREAM_VTABLE`).
        unsafe { &*self.inner.vtable }
    }
}

impl std::fmt::Debug for HostTcpStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostTcpStream").finish_non_exhaustive()
    }
}

impl Read for HostTcpStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut n_read: usize = 0;
        // SAFETY: `state` is owned and valid; `buf` outlives the call; `&mut n_read`
        // is a valid out-parameter.
        let status = unsafe {
            (self.vtable().read)(self.inner.state, buf.as_mut_ptr(), buf.len(), &mut n_read)
        };
        status
            .into_result()
            .map(|()| n_read)
            .map_err(std::io::Error::other)
    }
}

impl Write for HostTcpStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut n_written: usize = 0;
        // SAFETY: `state` is owned and valid; `buf` outlives the call; `&mut
        // n_written` is a valid out-parameter.
        let status = unsafe {
            (self.vtable().write)(
                self.inner.state,
                FfiByteSlice::from_slice(buf),
                &mut n_written,
            )
        };
        status
            .into_result()
            .map(|()| n_written)
            .map_err(std::io::Error::other)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        // Writes go straight to the host socket; there is no plugin-side buffer.
        Ok(())
    }
}

impl Drop for HostTcpStream {
    fn drop(&mut self) {
        if self.inner.state.is_null() || self.inner.vtable.is_null() {
            return;
        }
        // SAFETY: `state` is owned and valid; `destroy` is called exactly once.
        unsafe { (self.vtable().destroy)(self.inner.state) };
    }
}
