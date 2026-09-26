//! The **host context** a backend receives at session creation (PLG-014, added
//! in ABI **1.1**).
//!
//! ABI 1.0 handed `plugin_create_backend` only the session config, the output
//! sender and the capability bridge. From 1.1 the host also passes a
//! [`PluginHostContext`], reached through the pointer appended to
//! [`PluginSessionConfig`](crate::PluginSessionConfig) (an append-only minor
//! addition to a host-owned, by-pointer struct — see [`crate::version`]):
//!
//! | Item | Where |
//! | --- | --- |
//! | host (termiHub) version | [`HostContext::host_version`] |
//! | a plugin-scoped data directory the host created for the plugin | [`HostContext::data_dir`] |
//! | a host log callback, tagged with the plugin id, that lands in the Log Viewer | [`PluginHostServices::log`] |
//! | a shutdown / cancellation signal | [`PluginHostServices::is_cancelled`] |
//! | the plugin's resolved settings JSON | **not duplicated** — it is [`PluginSessionConfig::settings_json`](crate::PluginSessionConfig::settings_json) (ABI 1.0, PLG-008) |
//!
//! A plugin built for ABI 1.0 never reads the appended pointer, so it keeps
//! working unchanged; the host only builds a context for plugins whose ABI
//! [`supports`](crate::AbiVersion::supports) 1.1.
//!
//! # Lifetimes
//!
//! * The [`PluginHostContext`] itself — and the `host_version` / `data_dir`
//!   strings it points at — is **borrowed for the duration of the
//!   `plugin_create_backend` call only**, like the rest of the session config.
//!   [`PluginSessionConfig::context`](crate::PluginSessionConfig::context)
//!   copies it into an owned [`HostContext`].
//! * [`PluginHostServices`] is **reference counted by the host**. Obtaining one
//!   from the context takes a new reference; cloning takes another; dropping
//!   releases it. A plugin may keep a handle for as long as it likes — in its
//!   backend, in worker threads — and every call on it stays memory-safe even
//!   after the session has ended (the host's side of it lives in the host
//!   binary, which outlives every plugin). Handles should nevertheless be dropped
//!   with the session so nothing lingers.
//!
//! # Cancellation
//!
//! [`PluginHostServices::is_cancelled`] is a cheap, poll-able, **sticky** flag
//! (once `true`, always `true`). The host sets it when:
//!
//! 1. the session is being torn down (disconnect, or the session object is
//!    dropped) — set *before* the backend's `close` is called, so a worker
//!    thread polling it can wind down promptly; or
//! 2. the plugin is being unloaded or disabled (or the app is shutting down) —
//!    this cancels **every** session of the plugin at once.
//!
//! Long-running plugin work (reader threads, reconnect loops, blocking waits
//! with timeouts) should poll it and stop when it flips.
//!
//! # Logging
//!
//! [`PluginHostServices::log`] routes a message into the host's log pipeline
//! (the Log Viewer and the log file) under the `plugin` target, prefixed with
//! the plugin's id — the plugin cannot choose or spoof the tag. The host bounds
//! each message to [`MAX_LOG_MESSAGE_BYTES`] (longer ones are truncated, never
//! rejected), replaces control characters so a message cannot forge extra log
//! lines, and contains any panic on its side. Invalid UTF-8 is replaced, not
//! trusted.
//!
//! The host also **rate-limits** each plugin's log lines with a token bucket
//! shared by all of the plugin's sessions: a burst of 100 lines, then 20 lines
//! per second sustained (host policy, not part of the ABI — it may be tuned).
//! A line over the limit is **dropped, and the call still returns `Ok`**: a
//! dropped log line is not an error a plugin can usefully act on, and keeping
//! the status set unchanged keeps the ABI append-only. The host reports the
//! drops itself with one `[<id>] N log lines suppressed …` warning per window
//! (at most one per second, on the plugin's next log call or when it is
//! unloaded), so a flood stays visible without evicting other log entries.

use core::ffi::c_void;
use std::path::PathBuf;

use crate::error::{PluginError, PluginStatus};
use crate::ffi::FfiStr;

/// The host truncates any single log message longer than this many bytes. It
/// never reads past this bound in the plugin's buffer.
pub const MAX_LOG_MESSAGE_BYTES: usize = 8 * 1024;

/// Severity of a plugin log message. Carried across the ABI as a plain `u32`
/// ([`as_wire`](Self::as_wire)) — never as a Rust enum, because an out-of-range
/// discriminant would be undefined behavior on the host side. The host rejects
/// an unknown value with [`PluginStatus::InvalidConfig`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PluginLogLevel {
    /// Something failed.
    Error,
    /// Something looks wrong but the plugin carried on.
    Warn,
    /// Normal operational messages.
    Info,
    /// Diagnostic detail.
    Debug,
    /// Very verbose diagnostic detail.
    Trace,
}

impl PluginLogLevel {
    /// Wire value (`1` = error … `5` = trace, matching the `log` crate's order).
    #[must_use]
    pub const fn as_wire(self) -> u32 {
        match self {
            Self::Error => 1,
            Self::Warn => 2,
            Self::Info => 3,
            Self::Debug => 4,
            Self::Trace => 5,
        }
    }

    /// Decode a wire value; `None` for anything unrecognized.
    #[must_use]
    pub const fn from_wire(value: u32) -> Option<Self> {
        match value {
            1 => Some(Self::Error),
            2 => Some(Self::Warn),
            3 => Some(Self::Info),
            4 => Some(Self::Debug),
            5 => Some(Self::Trace),
            _ => None,
        }
    }
}

/// Host callback: take another reference on the services context.
pub type PluginServicesRetainFn = unsafe extern "C" fn(ctx: *mut c_void);
/// Host callback: release one reference on the services context.
pub type PluginServicesReleaseFn = unsafe extern "C" fn(ctx: *mut c_void);
/// Host callback: log `message` at `level` (a [`PluginLogLevel`] wire value).
pub type PluginServicesLogFn =
    unsafe extern "C" fn(ctx: *mut c_void, level: u32, message: FfiStr) -> PluginStatus;
/// Host callback: whether the session (or the whole plugin) has been cancelled.
pub type PluginServicesIsCancelledFn = unsafe extern "C" fn(ctx: *mut c_void) -> bool;

/// The host-services function table (ABI 1.1). A **host-owned** static, so a
/// later minor may append entries (see [`crate::version`]); a plugin only ever
/// calls the entries its own minor knows.
#[repr(C)]
pub struct PluginHostServicesVTable {
    /// Take another reference on `ctx`.
    pub retain: PluginServicesRetainFn,
    /// Release one reference on `ctx`.
    pub release: PluginServicesReleaseFn,
    /// Log a message (see [`PluginHostServices::log`]).
    pub log: PluginServicesLogFn,
    /// Poll the cancellation flag (see [`PluginHostServices::is_cancelled`]).
    pub is_cancelled: PluginServicesIsCancelledFn,
    // Append-only (ABI 1.x): host-owned, so later minors may append entries.
}

/// An owned, reference-counted handle on the host's per-session services:
/// logging and cancellation (ABI 1.1).
///
/// Obtained from [`HostContext::services`]; `Clone` takes another host
/// reference and `Drop` releases one. Passed **by value** inside the plugin
/// only — the ABI never carries it by value — but its two-pointer layout is
/// nonetheless pinned by the layout-freeze test.
#[repr(C)]
pub struct PluginHostServices {
    ctx: *mut c_void,
    vtable: *const PluginHostServicesVTable,
}

// SAFETY: the host implements the services over thread-safe state (atomics and
// a thread-safe log pipeline) and documents every callback as callable from any
// thread, so the handle may be shared and sent across the plugin's threads.
unsafe impl Send for PluginHostServices {}
unsafe impl Sync for PluginHostServices {}

impl PluginHostServices {
    /// Adopt one reference on a host services context.
    ///
    /// For the host (which creates the first reference) and for tests.
    ///
    /// # Safety
    ///
    /// * Every callback in `vtable` must be safe to call with `ctx` from any
    ///   thread, for as long as at least one reference is outstanding.
    /// * The caller transfers exactly **one** reference on `ctx` to the returned
    ///   handle, which releases it on drop.
    #[must_use]
    pub unsafe fn from_raw(ctx: *mut c_void, vtable: &'static PluginHostServicesVTable) -> Self {
        Self { ctx, vtable }
    }

    fn vtable(&self) -> &PluginHostServicesVTable {
        // SAFETY: `vtable` is a `&'static` (from `from_raw`) or was copied from a
        // live host context, whose tables are host statics; never mutated.
        unsafe { &*self.vtable }
    }

    /// Send `message` to the host log at `level`. The host tags it with this
    /// plugin's id and truncates it to [`MAX_LOG_MESSAGE_BYTES`].
    ///
    /// Lines over the host's per-plugin rate limit are dropped and still
    /// return `Ok(())` (see the module docs, *Logging*).
    pub fn log(&self, level: PluginLogLevel, message: &str) -> Result<(), PluginError> {
        // SAFETY: `ctx` holds a live reference; `message` outlives the call.
        let status =
            unsafe { (self.vtable().log)(self.ctx, level.as_wire(), FfiStr::new(message)) };
        status.into_result()
    }

    /// Log at [`PluginLogLevel::Error`], ignoring a logging failure.
    pub fn error(&self, message: &str) {
        let _ = self.log(PluginLogLevel::Error, message);
    }

    /// Log at [`PluginLogLevel::Warn`], ignoring a logging failure.
    pub fn warn(&self, message: &str) {
        let _ = self.log(PluginLogLevel::Warn, message);
    }

    /// Log at [`PluginLogLevel::Info`], ignoring a logging failure.
    pub fn info(&self, message: &str) {
        let _ = self.log(PluginLogLevel::Info, message);
    }

    /// Log at [`PluginLogLevel::Debug`], ignoring a logging failure.
    pub fn debug(&self, message: &str) {
        let _ = self.log(PluginLogLevel::Debug, message);
    }

    /// Whether the host has cancelled this session or is unloading the plugin.
    /// Sticky: once `true` it stays `true`. Cheap enough to poll in a loop.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        // SAFETY: `ctx` holds a live reference.
        unsafe { (self.vtable().is_cancelled)(self.ctx) }
    }
}

impl Clone for PluginHostServices {
    fn clone(&self) -> Self {
        // SAFETY: `ctx` holds a live reference, so retaining another is valid;
        // the new handle owns exactly that new reference.
        unsafe { (self.vtable().retain)(self.ctx) };
        Self {
            ctx: self.ctx,
            vtable: self.vtable,
        }
    }
}

impl Drop for PluginHostServices {
    fn drop(&mut self) {
        // SAFETY: releases the one reference this handle owns, exactly once.
        unsafe { (self.vtable().release)(self.ctx) };
    }
}

impl std::fmt::Debug for PluginHostServices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginHostServices").finish_non_exhaustive()
    }
}

/// The host context, as it crosses the ABI (ABI 1.1).
///
/// **Host-owned and borrowed**: the host builds it for one
/// `plugin_create_backend` call and passes it by pointer through
/// the `host_context` field of [`PluginSessionConfig`](crate::PluginSessionConfig);
/// a later minor may append fields. Plugins do not read it directly — use
/// [`PluginSessionConfig::context`](crate::PluginSessionConfig::context),
/// which copies it into an owned [`HostContext`].
#[repr(C)]
pub struct PluginHostContext {
    /// The host application's version (e.g. `"0.1.0"`). Borrowed, UTF-8.
    pub host_version: FfiStr,
    /// Absolute path of the plugin's private data directory, which the host has
    /// already created. Borrowed, UTF-8. Empty if the host provides none.
    pub data_dir: FfiStr,
    /// Services context — one reference **owned by the host** for the duration
    /// of the call. A plugin takes its own reference via
    /// [`PluginSessionConfig::context`](crate::PluginSessionConfig::context).
    pub services_ctx: *mut c_void,
    /// Services table (a host static).
    pub services_vtable: *const PluginHostServicesVTable,
    // Append-only (ABI 1.x): host-owned and passed by pointer.
}

impl PluginHostContext {
    /// Borrow the parts as a context. For the host. The result borrows
    /// `host_version` and `data_dir`, and borrows (does not take) the reference
    /// held by `services`; all three must outlive the `plugin_create_backend`
    /// call it is passed to.
    #[must_use]
    pub fn new(host_version: &str, data_dir: &str, services: &PluginHostServices) -> Self {
        Self {
            host_version: FfiStr::new(host_version),
            data_dir: FfiStr::new(data_dir),
            services_ctx: services.ctx,
            services_vtable: services.vtable,
        }
    }

    /// Copy this borrowed context into an owned [`HostContext`], taking a new
    /// reference on the services.
    ///
    /// Returns `None` when the services table is missing (a malformed
    /// context), so a plugin fails closed instead of calling through null.
    ///
    /// # Safety
    ///
    /// `self` must be a context the host passed for the current call (so its
    /// strings and services are live).
    #[must_use]
    pub unsafe fn to_owned_context(&self) -> Option<HostContext> {
        if self.services_vtable.is_null() {
            return None;
        }
        // SAFETY: the host guarantees both strings are live, UTF-8, for the call.
        let (host_version, data_dir) =
            unsafe { (self.host_version.as_str(), self.data_dir.as_str()) };
        // SAFETY: the vtable is a live host static and `services_ctx` carries a
        // host-held reference for this call, so retaining one more is valid;
        // the new handle owns exactly that reference.
        let services = unsafe {
            ((*self.services_vtable).retain)(self.services_ctx);
            PluginHostServices {
                ctx: self.services_ctx,
                vtable: self.services_vtable,
            }
        };
        Some(HostContext {
            host_version: host_version.to_owned(),
            data_dir: (!data_dir.is_empty()).then(|| PathBuf::from(data_dir)),
            services,
        })
    }
}

/// An owned copy of the [host context](self), safe to keep for the session's
/// lifetime.
#[derive(Debug, Clone)]
pub struct HostContext {
    /// The host application's version (e.g. `"0.1.0"`).
    pub host_version: String,
    /// The plugin's private, host-created data directory — shared by every
    /// session of the plugin and kept across plugin updates, removed on
    /// uninstall. `None` if the host provides none.
    pub data_dir: Option<PathBuf>,
    /// Logging and cancellation for this session.
    pub services: PluginHostServices,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// A test host: counts references and records log lines.
    struct TestHost {
        refs: AtomicUsize,
        cancelled: AtomicBool,
        lines: Mutex<Vec<(u32, String)>>,
    }

    unsafe extern "C" fn retain(ctx: *mut c_void) {
        let host = unsafe { &*ctx.cast::<TestHost>() };
        host.refs.fetch_add(1, Ordering::SeqCst);
    }
    unsafe extern "C" fn release(ctx: *mut c_void) {
        let host = unsafe { &*ctx.cast::<TestHost>() };
        host.refs.fetch_sub(1, Ordering::SeqCst);
    }
    unsafe extern "C" fn log(ctx: *mut c_void, level: u32, message: FfiStr) -> PluginStatus {
        let host = unsafe { &*ctx.cast::<TestHost>() };
        if PluginLogLevel::from_wire(level).is_none() {
            return PluginStatus::InvalidConfig;
        }
        let text = unsafe { message.as_str() }.to_owned();
        host.lines.lock().unwrap().push((level, text));
        PluginStatus::Ok
    }
    unsafe extern "C" fn is_cancelled(ctx: *mut c_void) -> bool {
        let host = unsafe { &*ctx.cast::<TestHost>() };
        host.cancelled.load(Ordering::SeqCst)
    }

    static VTABLE: PluginHostServicesVTable = PluginHostServicesVTable {
        retain,
        release,
        log,
        is_cancelled,
    };

    #[test]
    fn context_round_trip_counts_references_and_forwards_calls() {
        let host = Box::leak(Box::new(TestHost {
            refs: AtomicUsize::new(1),
            cancelled: AtomicBool::new(false),
            lines: Mutex::new(Vec::new()),
        }));
        let ctx_ptr = std::ptr::from_mut(host).cast::<c_void>();
        // SAFETY: the host starts with one reference, adopted here.
        let host_handle = unsafe { PluginHostServices::from_raw(ctx_ptr, &VTABLE) };

        let raw = PluginHostContext::new("0.1.0", "/data/echo", &host_handle);
        // SAFETY: `raw` borrows live values for this scope.
        let owned = unsafe { raw.to_owned_context() }.unwrap();
        assert_eq!(owned.host_version, "0.1.0");
        assert_eq!(owned.data_dir, Some(PathBuf::from("/data/echo")));
        assert_eq!(host.refs.load(Ordering::SeqCst), 2);

        let clone = owned.services.clone();
        assert_eq!(host.refs.load(Ordering::SeqCst), 3);
        clone.info("hello");
        assert!(!clone.is_cancelled());
        host.cancelled.store(true, Ordering::SeqCst);
        assert!(owned.services.is_cancelled());
        drop(clone);
        drop(owned);
        assert_eq!(host.refs.load(Ordering::SeqCst), 1);
        drop(host_handle);
        assert_eq!(host.refs.load(Ordering::SeqCst), 0);
        assert_eq!(
            host.lines.lock().unwrap().as_slice(),
            &[(3, "hello".to_owned())]
        );
    }

    #[test]
    fn empty_data_dir_is_none_and_null_vtable_fails_closed() {
        let host = Box::leak(Box::new(TestHost {
            refs: AtomicUsize::new(1),
            cancelled: AtomicBool::new(false),
            lines: Mutex::new(Vec::new()),
        }));
        let ctx_ptr = std::ptr::from_mut(host).cast::<c_void>();
        // SAFETY: as above.
        let handle = unsafe { PluginHostServices::from_raw(ctx_ptr, &VTABLE) };
        let raw = PluginHostContext::new("0.1.0", "", &handle);
        // SAFETY: live for this scope.
        let owned = unsafe { raw.to_owned_context() }.unwrap();
        assert_eq!(owned.data_dir, None);
        drop(owned);

        let mut broken = PluginHostContext::new("0.1.0", "", &handle);
        broken.services_vtable = std::ptr::null();
        // SAFETY: the null table is detected before any call.
        assert!(unsafe { broken.to_owned_context() }.is_none());
    }

    #[test]
    fn log_level_wire_round_trips_and_rejects_garbage() {
        for level in [
            PluginLogLevel::Error,
            PluginLogLevel::Warn,
            PluginLogLevel::Info,
            PluginLogLevel::Debug,
            PluginLogLevel::Trace,
        ] {
            assert_eq!(PluginLogLevel::from_wire(level.as_wire()), Some(level));
        }
        assert_eq!(PluginLogLevel::from_wire(0), None);
        assert_eq!(PluginLogLevel::from_wire(6), None);
    }
}
