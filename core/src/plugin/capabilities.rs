//! Host side of the plugin **capability bridge** (#2018).
//!
//! [`build_host_bridge`] constructs the
//! [`PluginHostBridge`](termihub_plugin_api::PluginHostBridge) the host hands to a
//! plugin at `create_backend`. Its context owns a clone of the session's
//! [`PermissionSet`], and its callbacks route every mediated operation through
//! that set's guards — [`PermissionSet::require`] for network, and
//! [`FilesystemScope::check`] (via [`PermissionSet::check_path`]) for filesystem —
//! so `network`/`filesystem` are enforced **at runtime**, not merely validated at
//! load (concept §13; the runtime half of the primitives added in #2001).
//!
//! # Enforcement boundary
//!
//! The bridge mediates the operations a cooperating plugin routes *through it*:
//! for those, the host opens the socket / reads the file and refuses when the
//! permission or path-scope check fails. It is **not** an OS sandbox — an
//! in-process plugin could still bypass the bridge with a direct syscall, which
//! only OS-level isolation (out of scope, no substrate today) could stop. See the
//! [`termihub_plugin_api::capabilities`] module docs.

use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use termihub_plugin_api::capabilities::{
    PluginBridgeDestroyFn, PluginFileMetadata, PluginListDirFn, PluginOpenConnectionFn,
    PluginReadFileFn, PluginStatPathFn, PluginWriteFileFn, PluginWriteMode,
};
use termihub_plugin_api::{
    FfiByteSlice, FfiOwnedBytes, FfiStr, PluginHostBridge, PluginStatus, PluginTcpStream,
};

use super::manifest::ConnectionPolicyManifest;
use super::security::{PermissionError, PermissionSet};
use super::PluginPermission;

/// Default connect timeout applied to a mediated `open_connection` when the
/// session's [`ConnectionPolicy`] does not override it (#2024).
///
/// A bare `TcpStream::connect` blocks indefinitely on a black-holed host; this
/// per-connect ceiling keeps a plugin's dial-out from hanging a session forever.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Default per-session ceiling on concurrent mediated connections when the
/// session's [`ConnectionPolicy`] does not override it (#2028).
///
/// Enough headroom for a plugin that legitimately fans out to a handful of
/// endpoints, while still bounding how much host resource one cooperating session
/// can hold open through the bridge.
pub const DEFAULT_MAX_CONNECTIONS: usize = 8;

/// Host-side policy governing the connections a plugin session may open through
/// the capability bridge (#2028).
///
/// It bounds two things a cooperating plugin would otherwise control unchecked:
/// how many mediated connections it can hold open at once
/// ([`max_connections`](Self::max_connections)), and how long each dial-out may
/// block ([`connect_timeout`](Self::connect_timeout)). Both have host defaults
/// ([`DEFAULT_MAX_CONNECTIONS`], [`DEFAULT_CONNECT_TIMEOUT`]) and can be raised or
/// lowered per plugin through the manifest's `connectionPolicy`
/// ([`ConnectionPolicyManifest`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectionPolicy {
    max_connections: usize,
    connect_timeout: Duration,
}

impl Default for ConnectionPolicy {
    fn default() -> Self {
        Self {
            max_connections: DEFAULT_MAX_CONNECTIONS,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
        }
    }
}

impl ConnectionPolicy {
    /// A policy with explicit values.
    #[must_use]
    pub fn new(max_connections: usize, connect_timeout: Duration) -> Self {
        Self {
            max_connections,
            connect_timeout,
        }
    }

    /// Derive a policy from a manifest's optional `connectionPolicy`, falling back
    /// to the host defaults for any field the manifest leaves unset.
    #[must_use]
    pub fn from_manifest(policy: Option<&ConnectionPolicyManifest>) -> Self {
        let mut resolved = Self::default();
        if let Some(p) = policy {
            if let Some(max) = p.max_connections {
                resolved.max_connections = max;
            }
            if let Some(ms) = p.connect_timeout_ms {
                resolved.connect_timeout = Duration::from_millis(ms);
            }
        }
        resolved
    }

    /// Maximum number of concurrent mediated connections a session may hold open.
    #[must_use]
    pub fn max_connections(&self) -> usize {
        self.max_connections
    }

    /// Connect timeout applied to each mediated dial-out.
    #[must_use]
    pub fn connect_timeout(&self) -> Duration {
        self.connect_timeout
    }
}

/// Owned context behind a [`PluginHostBridge`]: the session's granted
/// permissions, its [`ConnectionPolicy`], and the live count of mediated
/// connections it currently holds open.
struct BridgeContext {
    /// The session's granted permissions, checked on every mediated operation.
    permissions: PermissionSet,
    /// The session's connection policy (concurrency ceiling + connect timeout).
    policy: ConnectionPolicy,
    /// Mediated connections currently open for this session. Shared with each
    /// open connection's [`ConnectionGuard`], which decrements it on drop.
    active_connections: Arc<AtomicUsize>,
}

impl BridgeContext {
    /// Try to reserve one connection slot, returning a [`ConnectionGuard`] that
    /// releases it on drop, or `None` if the session is already at its
    /// concurrent-connection ceiling.
    fn try_reserve_connection(&self) -> Option<ConnectionGuard> {
        // Optimistically claim a slot, then roll back if that pushed the session
        // over its ceiling. A single atomic keeps the count correct across the
        // several threads a backend may drive the bridge from.
        let prev = self.active_connections.fetch_add(1, Ordering::AcqRel);
        if prev >= self.policy.max_connections {
            self.active_connections.fetch_sub(1, Ordering::AcqRel);
            None
        } else {
            Some(ConnectionGuard {
                active_connections: Arc::clone(&self.active_connections),
            })
        }
    }
}

/// Releases one reserved connection slot when the mediated stream is dropped.
///
/// Handed to the mediated stream as its
/// [`StreamDropGuard`](termihub_plugin_api::StreamDropGuard), so a session's live
/// connection count falls the instant the plugin drops a connection — freeing the
/// slot for a later dial-out.
struct ConnectionGuard {
    active_connections: Arc<AtomicUsize>,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.active_connections.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Build the host capability bridge for a session granted `permissions`, using
/// the host's default [`ConnectionPolicy`].
///
/// A convenience over [`build_host_bridge_with_policy`] for callers (and tests)
/// that do not customise the connection policy.
#[must_use]
pub fn build_host_bridge(permissions: PermissionSet) -> PluginHostBridge {
    build_host_bridge_with_policy(permissions, ConnectionPolicy::default())
}

/// Build the host capability bridge for a session granted `permissions` and
/// governed by `policy`.
///
/// The returned [`PluginHostBridge`] is passed by value into the plugin's
/// `create_backend`; the plugin owns it thereafter and drops it (running the
/// destructor installed here, which frees the boxed context). Every call a plugin
/// makes through the bridge is checked against `permissions` before the host
/// performs it, and every `open_connection` is bounded by `policy` — both its
/// concurrency ceiling and its connect timeout (#2028).
#[must_use]
pub fn build_host_bridge_with_policy(
    permissions: PermissionSet,
    policy: ConnectionPolicy,
) -> PluginHostBridge {
    // The bridge context owns the granted permission set, the connection policy,
    // and this session's live connection counter. Leaked as a raw pointer to
    // cross the ABI; `bridge_destroy` reclaims it.
    let ctx = Box::into_raw(Box::new(BridgeContext {
        permissions,
        policy,
        active_connections: Arc::new(AtomicUsize::new(0)),
    }))
    .cast::<core::ffi::c_void>();
    let open_connection: PluginOpenConnectionFn = bridge_open_connection;
    let read_file: PluginReadFileFn = bridge_read_file;
    let write_file: PluginWriteFileFn = bridge_write_file;
    let stat_path: PluginStatPathFn = bridge_stat_path;
    let list_dir: PluginListDirFn = bridge_list_dir;
    let destroy: PluginBridgeDestroyFn = bridge_destroy;
    // SAFETY: `ctx` is a leaked `Box<BridgeContext>`; every callback below only
    // ever interprets it as exactly that, and `destroy` reclaims it exactly once.
    // `BridgeContext` is `Send + Sync` (its fields are), matching the bridge's
    // bounds.
    unsafe {
        PluginHostBridge::from_raw(
            ctx,
            open_connection,
            read_file,
            write_file,
            stat_path,
            list_dir,
            Some(destroy),
        )
    }
}

/// Resolve `host:port` and connect, bounding each attempt by `timeout`.
///
/// Each resolved address is tried with [`TcpStream::connect_timeout`] so a
/// black-holed host cannot hang the connect indefinitely; the last error is
/// returned if every address fails or resolution yields none. `timeout` comes
/// from the session's [`ConnectionPolicy`] (#2028).
fn connect_with_timeout(host: &str, port: u16, timeout: Duration) -> std::io::Result<TcpStream> {
    let addrs = (host, port).to_socket_addrs()?;
    let mut last_err = std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no addresses resolved for host",
    );
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => return Ok(stream),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

/// Map a filesystem-scope check failure to the status the ABI reports. A missing
/// permission or an out-of-scope / traversal path is [`PluginStatus::PermissionDenied`];
/// anything else is [`PluginStatus::Other`].
fn scope_error_status(err: &PermissionError) -> PluginStatus {
    match err {
        PermissionError::Denied(_) | PermissionError::PathOutsideScope { .. } => {
            PluginStatus::PermissionDenied
        }
        _ => PluginStatus::Other,
    }
}

/// Borrow the boxed [`BridgeContext`] behind a bridge `ctx`.
///
/// # Safety
///
/// `ctx` must be a live `*mut BridgeContext` produced by
/// [`build_host_bridge_with_policy`].
unsafe fn context<'a>(ctx: *mut core::ffi::c_void) -> &'a BridgeContext {
    // SAFETY: caller guarantees `ctx` is the leaked `Box<BridgeContext>`; borrowing
    // it shared is sound because every callback only reads it (the connection
    // count it holds is an atomic).
    unsafe { &*ctx.cast::<BridgeContext>() }
}

/// `open_connection` callback: enforce the `network` permission and the session's
/// concurrent-connection ceiling, then connect within the policy's timeout.
///
/// The two refusals now carry **distinct** statuses so a plugin can tell them
/// apart (#2030): a missing `network` permission is
/// [`PluginStatus::PermissionDenied`], while hitting the session's
/// concurrent-connection ceiling is [`PluginStatus::ResourceLimit`] — a
/// well-behaved plugin can back off and retry the latter rather than treat it as
/// a hard permission failure.
///
/// # Safety
///
/// `ctx` must be a live bridge context; `out_stream` a valid, writable
/// `*mut PluginTcpStream`. `host` borrows valid memory for the call.
unsafe extern "C" fn bridge_open_connection(
    ctx: *mut core::ffi::c_void,
    host: FfiStr,
    port: u16,
    out_stream: *mut PluginTcpStream,
) -> PluginStatus {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: upheld by this function's contract.
        let cx = unsafe { context(ctx) };
        // Runtime enforcement: refuse before touching the network if the plugin
        // never requested `network`.
        if cx.permissions.require(PluginPermission::Network).is_err() {
            return PluginStatus::PermissionDenied;
        }
        // Resource enforcement: refuse if this session is already holding its
        // maximum number of concurrent mediated connections. Reported as
        // `ResourceLimit`, distinct from the `PermissionDenied` above, so the
        // plugin can tell a ceiling refusal apart from a missing permission and
        // back off/retry (#2030). The reservation is released when the returned
        // stream is dropped (or below, on connect failure).
        let Some(guard) = cx.try_reserve_connection() else {
            return PluginStatus::ResourceLimit;
        };
        // SAFETY: `host` is a valid borrowed `&str` for the call.
        let host_str = unsafe { host.as_str() };
        match connect_with_timeout(host_str, port, cx.policy.connect_timeout) {
            Ok(stream) => {
                // The guard rides along with the mediated stream, so the slot is
                // released the moment the plugin drops the connection.
                let handle = PluginTcpStream::from_std_guarded(stream, Box::new(guard));
                // SAFETY: `out_stream` is a valid, writable out-parameter.
                unsafe { out_stream.write(handle) };
                PluginStatus::Ok
            }
            // Dropping `guard` here frees the slot the failed dial-out reserved.
            Err(_) => PluginStatus::Io,
        }
    }));
    result.unwrap_or(PluginStatus::Panic)
}

/// `read_file` callback: resolve the path against the plugin's declared scope,
/// then read it.
///
/// # Safety
///
/// `ctx` must be a live bridge context; `out_bytes` a valid, writable
/// `*mut FfiOwnedBytes`. `path` borrows valid memory for the call.
unsafe extern "C" fn bridge_read_file(
    ctx: *mut core::ffi::c_void,
    path: FfiStr,
    out_bytes: *mut FfiOwnedBytes,
) -> PluginStatus {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: upheld by this function's contract.
        let perms = unsafe { &context(ctx).permissions };
        // SAFETY: `path` is a valid borrowed `&str` for the call.
        let requested = unsafe { path.as_str() };
        // Runtime enforcement: reject a missing `filesystem` permission or a path
        // outside the declared scope before any read happens.
        match perms.check_path(Path::new(requested)) {
            Ok(resolved) => match std::fs::read(&resolved) {
                Ok(bytes) => {
                    // SAFETY: `out_bytes` is a valid, writable out-parameter.
                    unsafe { out_bytes.write(FfiOwnedBytes::from_vec(bytes)) };
                    PluginStatus::Ok
                }
                Err(_) => PluginStatus::Io,
            },
            Err(e) => scope_error_status(&e),
        }
    }));
    result.unwrap_or(PluginStatus::Panic)
}

/// `write_file` callback: resolve the path against the plugin's declared scope,
/// then open it per `mode` and write the supplied bytes.
///
/// Confining every write through [`PermissionSet::check_path`] is the whole point
/// (#2024): an out-of-scope or traversal path is rejected before any file is
/// created or opened, so a plugin can only write inside its declared roots.
///
/// # Safety
///
/// `ctx` must be a live bridge context; `path`/`data` borrow valid memory for the
/// call.
unsafe extern "C" fn bridge_write_file(
    ctx: *mut core::ffi::c_void,
    path: FfiStr,
    data: FfiByteSlice,
    mode: PluginWriteMode,
) -> PluginStatus {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: upheld by this function's contract.
        let perms = unsafe { &context(ctx).permissions };
        // SAFETY: `path`/`data` are valid borrowed views for the call.
        let requested = unsafe { path.as_str() };
        let bytes = unsafe { data.as_slice() };
        // Runtime enforcement: reject a missing `filesystem` permission or a path
        // outside the declared scope before anything is written or created.
        let resolved = match perms.check_path(Path::new(requested)) {
            Ok(resolved) => resolved,
            Err(e) => return scope_error_status(&e),
        };
        let mut options = std::fs::OpenOptions::new();
        match mode {
            PluginWriteMode::Truncate => options.create(true).write(true).truncate(true),
            PluginWriteMode::Append => options.create(true).append(true),
            PluginWriteMode::CreateNew => options.create_new(true).write(true),
        };
        match options.open(&resolved).and_then(|mut f| f.write_all(bytes)) {
            Ok(()) => PluginStatus::Ok,
            Err(_) => PluginStatus::Io,
        }
    }));
    result.unwrap_or(PluginStatus::Panic)
}

/// `stat_path` callback: resolve the path against the plugin's declared scope,
/// then report its metadata. An in-scope path that does not exist is reported as
/// [`PluginFileMetadata::absent`] with [`PluginStatus::Ok`] — a legitimate query,
/// not an error.
///
/// # Safety
///
/// `ctx` must be a live bridge context; `out_meta` a valid, writable
/// `*mut PluginFileMetadata`; `path` borrows valid memory for the call.
unsafe extern "C" fn bridge_stat_path(
    ctx: *mut core::ffi::c_void,
    path: FfiStr,
    out_meta: *mut PluginFileMetadata,
) -> PluginStatus {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: upheld by this function's contract.
        let perms = unsafe { &context(ctx).permissions };
        // SAFETY: `path` is a valid borrowed `&str` for the call.
        let requested = unsafe { path.as_str() };
        let resolved = match perms.check_path(Path::new(requested)) {
            Ok(resolved) => resolved,
            Err(e) => return scope_error_status(&e),
        };
        let meta = match std::fs::metadata(&resolved) {
            Ok(m) => PluginFileMetadata {
                exists: true,
                is_dir: m.is_dir(),
                len: m.len(),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => PluginFileMetadata::absent(),
            Err(_) => return PluginStatus::Io,
        };
        // SAFETY: `out_meta` is a valid, writable out-parameter.
        unsafe { out_meta.write(meta) };
        PluginStatus::Ok
    }));
    result.unwrap_or(PluginStatus::Panic)
}

/// `list_dir` callback: resolve the path against the plugin's declared scope,
/// then list its entries as `\n`-separated (lossy-UTF-8) owned bytes.
///
/// # Safety
///
/// `ctx` must be a live bridge context; `out_entries` a valid, writable
/// `*mut FfiOwnedBytes`; `path` borrows valid memory for the call.
unsafe extern "C" fn bridge_list_dir(
    ctx: *mut core::ffi::c_void,
    path: FfiStr,
    out_entries: *mut FfiOwnedBytes,
) -> PluginStatus {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: upheld by this function's contract.
        let perms = unsafe { &context(ctx).permissions };
        // SAFETY: `path` is a valid borrowed `&str` for the call.
        let requested = unsafe { path.as_str() };
        let resolved = match perms.check_path(Path::new(requested)) {
            Ok(resolved) => resolved,
            Err(e) => return scope_error_status(&e),
        };
        let read_dir = match std::fs::read_dir(&resolved) {
            Ok(rd) => rd,
            Err(_) => return PluginStatus::Io,
        };
        let mut names: Vec<String> = Vec::new();
        for entry in read_dir.flatten() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        let joined = names.join("\n");
        // SAFETY: `out_entries` is a valid, writable out-parameter.
        unsafe { out_entries.write(FfiOwnedBytes::from_vec(joined.into_bytes())) };
        PluginStatus::Ok
    }));
    result.unwrap_or(PluginStatus::Panic)
}

/// Destructor for the bridge context: reclaim the boxed [`BridgeContext`].
///
/// # Safety
///
/// `ctx` must be the leaked `Box<BridgeContext>` from
/// [`build_host_bridge_with_policy`] and must not be used afterwards.
unsafe extern "C" fn bridge_destroy(ctx: *mut core::ffi::c_void) {
    if !ctx.is_null() {
        // SAFETY: reclaims the box leaked in `build_host_bridge_with_policy`,
        // exactly once.
        drop(unsafe { Box::from_raw(ctx.cast::<BridgeContext>()) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A permission set granting exactly `perms`, scoped to `fs_paths`.
    fn perms(perms: &[PluginPermission], fs_paths: &[&str]) -> PermissionSet {
        let owned: Vec<String> = fs_paths.iter().map(|s| (*s).to_owned()).collect();
        PermissionSet::from_parts(perms.iter().copied(), &owned)
    }

    #[test]
    fn network_is_denied_without_the_permission() {
        // A plugin with no `network` permission cannot open a connection through
        // the bridge — the host refuses before the socket is ever touched.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let bridge = build_host_bridge(perms(&[PluginPermission::Terminal], &[]));
        let err = bridge.open_connection("127.0.0.1", port).unwrap_err();
        assert!(
            matches!(err, termihub_plugin_api::PluginError::PermissionDenied),
            "got {err:?}"
        );

        // Nothing connected: a non-blocking accept finds no pending connection.
        listener.set_nonblocking(true).unwrap();
        assert!(
            listener.accept().is_err(),
            "denied plugin must not have opened a connection"
        );
    }

    #[test]
    fn network_is_mediated_when_granted() {
        // With `network` granted the host opens the connection and hands back a
        // mediated stream the plugin can actually use.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 5];
            sock.read_exact(&mut buf).unwrap();
            sock.write_all(b"pong").unwrap();
            buf
        });

        let bridge = build_host_bridge(perms(&[PluginPermission::Network], &[]));
        let mut stream = bridge.open_connection("127.0.0.1", port).expect("granted");
        stream.write_all(b"hello").unwrap();
        let mut reply = [0u8; 4];
        stream.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"pong");

        let received = server.join().unwrap();
        assert_eq!(&received, b"hello");
    }

    #[test]
    fn connection_limit_rejects_once_the_ceiling_is_reached() {
        // A session may hold at most `max_connections` mediated connections open
        // at once; the one that would exceed the ceiling is refused, and a slot
        // frees again the moment an open connection is dropped (#2028).
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        // Accept the dial-outs that actually reach the socket so each host-side
        // connect succeeds — the only thing under test is the host's own
        // concurrency ceiling. Exactly three connects succeed host-side (c1, c2,
        // then c3 after a slot frees); the over-ceiling attempt is refused before
        // it ever touches the network, so it is never accepted here.
        let accepting = std::thread::spawn(move || {
            let mut held = Vec::new();
            for _ in 0..3 {
                match listener.accept() {
                    Ok((sock, _)) => held.push(sock),
                    Err(_) => break,
                }
            }
            held
        });

        let policy = ConnectionPolicy::new(2, DEFAULT_CONNECT_TIMEOUT);
        let bridge =
            build_host_bridge_with_policy(perms(&[PluginPermission::Network], &[]), policy);

        // Two concurrent connections fit under the ceiling of 2.
        let c1 = bridge
            .open_connection("127.0.0.1", port)
            .expect("first fits");
        let c2 = bridge
            .open_connection("127.0.0.1", port)
            .expect("second fits");

        // The third, still holding the first two, is refused as ResourceLimit —
        // a ceiling refusal, distinct from a permission denial (#2030).
        let err = bridge.open_connection("127.0.0.1", port).unwrap_err();
        assert!(
            matches!(err, termihub_plugin_api::PluginError::ResourceLimit),
            "over-ceiling connection should hit the resource limit, got {err:?}"
        );

        // Dropping one frees its slot, so the next dial-out succeeds again.
        drop(c1);
        let _c3 = bridge
            .open_connection("127.0.0.1", port)
            .expect("slot freed by drop");

        drop(c2);
        drop(_c3);
        let _ = accepting.join();
    }

    #[test]
    fn connection_slot_is_released_when_the_connect_fails() {
        // A failed dial-out must not leak a slot: the reservation is released on
        // the error path, so a later connect still fits under the ceiling (#2028).
        // Bind then immediately drop a listener to get a port that refuses.
        let refused_port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let good = TcpListener::bind("127.0.0.1:0").unwrap();
        let good_port = good.local_addr().unwrap().port();
        let accepting = std::thread::spawn(move || good.accept().map(|(s, _)| s));

        // Ceiling of 1, and a short timeout so a refusal (or drop) resolves fast.
        let policy = ConnectionPolicy::new(1, Duration::from_secs(2));
        let bridge =
            build_host_bridge_with_policy(perms(&[PluginPermission::Network], &[]), policy);

        // The refused connect fails with an I/O error, not a permission denial…
        let err = bridge
            .open_connection("127.0.0.1", refused_port)
            .unwrap_err();
        assert!(
            matches!(err, termihub_plugin_api::PluginError::Io(_)),
            "refused connect should be an I/O error, got {err:?}"
        );

        // …and it must have released its slot, so this connect (the only one held)
        // fits under the ceiling of 1.
        let _ok = bridge
            .open_connection("127.0.0.1", good_port)
            .expect("failed connect must not have leaked a slot");
        drop(_ok);
        let _ = accepting.join();
    }

    #[test]
    fn connect_timeout_is_configurable_and_bounds_the_dial_out() {
        // The timeout is no longer a hardcoded constant: the policy carries it and
        // the mediated connect honours it (#2028). A short custom timeout against a
        // black-holed (RFC 5737 TEST-NET-1) address returns an error well within
        // the 30s default rather than hanging on it.
        let policy = ConnectionPolicy::new(DEFAULT_MAX_CONNECTIONS, Duration::from_millis(300));
        assert_eq!(policy.connect_timeout(), Duration::from_millis(300));
        assert_eq!(policy.max_connections(), DEFAULT_MAX_CONNECTIONS);

        let bridge =
            build_host_bridge_with_policy(perms(&[PluginPermission::Network], &[]), policy);
        let start = std::time::Instant::now();
        let err = bridge.open_connection("192.0.2.1", 9).unwrap_err();
        let elapsed = start.elapsed();
        assert!(
            matches!(err, termihub_plugin_api::PluginError::Io(_)),
            "black-holed connect should fail with I/O, got {err:?}"
        );
        assert!(
            elapsed < Duration::from_secs(10),
            "configured 300ms timeout should bound the connect, took {elapsed:?}"
        );
    }

    #[test]
    fn connection_policy_from_manifest_overrides_only_declared_fields() {
        use crate::plugin::ConnectionPolicyManifest;

        // No manifest policy → host defaults.
        let d = ConnectionPolicy::from_manifest(None);
        assert_eq!(d.max_connections(), DEFAULT_MAX_CONNECTIONS);
        assert_eq!(d.connect_timeout(), DEFAULT_CONNECT_TIMEOUT);

        // A partial declaration overrides only the field it sets.
        let only_max = ConnectionPolicyManifest {
            max_connections: Some(3),
            connect_timeout_ms: None,
        };
        let p = ConnectionPolicy::from_manifest(Some(&only_max));
        assert_eq!(p.max_connections(), 3);
        assert_eq!(p.connect_timeout(), DEFAULT_CONNECT_TIMEOUT);

        // Both fields declared → both overridden.
        let both = ConnectionPolicyManifest {
            max_connections: Some(5),
            connect_timeout_ms: Some(1500),
        };
        let p = ConnectionPolicy::from_manifest(Some(&both));
        assert_eq!(p.max_connections(), 5);
        assert_eq!(p.connect_timeout(), Duration::from_millis(1500));
    }

    #[test]
    fn filesystem_read_is_denied_outside_the_declared_scope() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("scoped");
        std::fs::create_dir_all(&root).unwrap();
        let inside = root.join("data.txt");
        std::fs::write(&inside, b"in-scope contents").unwrap();
        let outside = dir.path().join("secret.txt");
        std::fs::write(&outside, b"top secret").unwrap();

        let bridge = build_host_bridge(perms(
            &[PluginPermission::Filesystem],
            &[root.to_str().unwrap()],
        ));

        // In-scope read succeeds and returns the real contents.
        let bytes = bridge
            .read_file(inside.to_str().unwrap())
            .expect("in scope");
        assert_eq!(bytes, b"in-scope contents");

        // A read outside the declared scope is rejected end-to-end — the host
        // never opens the file.
        let err = bridge.read_file(outside.to_str().unwrap()).unwrap_err();
        assert!(
            matches!(err, termihub_plugin_api::PluginError::PermissionDenied),
            "got {err:?}"
        );

        // A traversal escape from an in-scope prefix is rejected too.
        let escape = root.join("../secret.txt");
        let err = bridge.read_file(escape.to_str().unwrap()).unwrap_err();
        assert!(matches!(
            err,
            termihub_plugin_api::PluginError::PermissionDenied
        ));
    }

    #[test]
    fn filesystem_read_is_denied_without_the_permission() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("data.txt");
        std::fs::write(&file, b"contents").unwrap();

        // No `filesystem` permission at all → every read is refused.
        let bridge = build_host_bridge(perms(&[PluginPermission::Terminal], &[]));
        let err = bridge.read_file(file.to_str().unwrap()).unwrap_err();
        assert!(matches!(
            err,
            termihub_plugin_api::PluginError::PermissionDenied
        ));
    }

    #[test]
    fn filesystem_write_is_mediated_within_scope() {
        use termihub_plugin_api::PluginWriteMode;
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("scoped");
        std::fs::create_dir_all(&root).unwrap();
        let bridge = build_host_bridge(perms(
            &[PluginPermission::Filesystem],
            &[root.to_str().unwrap()],
        ));

        // Create-or-truncate writes the file within scope.
        let target = root.join("out.txt");
        bridge
            .overwrite(target.to_str().unwrap(), b"first")
            .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first");

        // Truncate again replaces the contents.
        bridge
            .write_file(
                target.to_str().unwrap(),
                b"second",
                PluginWriteMode::Truncate,
            )
            .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second");

        // Append extends it.
        bridge.append(target.to_str().unwrap(), b"-more").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second-more");
    }

    #[test]
    fn filesystem_create_new_fails_when_the_file_exists() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("scoped");
        std::fs::create_dir_all(&root).unwrap();
        let bridge = build_host_bridge(perms(
            &[PluginPermission::Filesystem],
            &[root.to_str().unwrap()],
        ));

        let target = root.join("new.txt");
        bridge.write_new(target.to_str().unwrap(), b"a").unwrap();
        // A second create-new on the same path is an I/O error (already exists),
        // not a permission denial.
        let err = bridge
            .write_new(target.to_str().unwrap(), b"b")
            .unwrap_err();
        assert!(
            matches!(err, termihub_plugin_api::PluginError::Io(_)),
            "got {err:?}"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"a");
    }

    #[test]
    fn filesystem_write_is_denied_outside_scope() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("scoped");
        std::fs::create_dir_all(&root).unwrap();
        let bridge = build_host_bridge(perms(
            &[PluginPermission::Filesystem],
            &[root.to_str().unwrap()],
        ));

        // A write outside the declared scope is refused and never creates a file.
        let outside = dir.path().join("escape.txt");
        let err = bridge
            .overwrite(outside.to_str().unwrap(), b"x")
            .unwrap_err();
        assert!(matches!(
            err,
            termihub_plugin_api::PluginError::PermissionDenied
        ));
        assert!(!outside.exists(), "denied write must not create the file");

        // A traversal escape from an in-scope prefix is rejected too.
        let escape = root.join("../escape2.txt");
        let err = bridge
            .overwrite(escape.to_str().unwrap(), b"x")
            .unwrap_err();
        assert!(matches!(
            err,
            termihub_plugin_api::PluginError::PermissionDenied
        ));
    }

    #[test]
    fn filesystem_write_is_denied_without_the_permission() {
        let dir = tempfile::TempDir::new().unwrap();
        // No `filesystem` permission → writes are refused before any file opens.
        let bridge = build_host_bridge(perms(&[PluginPermission::Terminal], &[]));
        let target = dir.path().join("nope.txt");
        let err = bridge
            .overwrite(target.to_str().unwrap(), b"x")
            .unwrap_err();
        assert!(matches!(
            err,
            termihub_plugin_api::PluginError::PermissionDenied
        ));
        assert!(!target.exists());
    }

    #[test]
    fn filesystem_stat_reports_metadata_within_scope() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("scoped");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("data.txt");
        std::fs::write(&file, b"12345").unwrap();
        let bridge = build_host_bridge(perms(
            &[PluginPermission::Filesystem],
            &[root.to_str().unwrap()],
        ));

        // A file: exists, not a dir, correct length.
        let meta = bridge.stat(file.to_str().unwrap()).unwrap();
        assert!(meta.exists && !meta.is_dir);
        assert_eq!(meta.len, 5);

        // A directory: exists, is a dir.
        let meta = bridge.stat(root.to_str().unwrap()).unwrap();
        assert!(meta.exists && meta.is_dir);

        // In-scope but absent path: reported as absent, not an error.
        let meta = bridge
            .stat(root.join("missing.txt").to_str().unwrap())
            .unwrap();
        assert!(!meta.exists);

        // Out-of-scope stat is refused.
        let outside = dir.path().join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();
        let err = bridge.stat(outside.to_str().unwrap()).unwrap_err();
        assert!(matches!(
            err,
            termihub_plugin_api::PluginError::PermissionDenied
        ));
    }

    #[test]
    fn filesystem_list_dir_lists_entries_within_scope() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("scoped");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), b"a").unwrap();
        std::fs::write(root.join("b.txt"), b"b").unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        let bridge = build_host_bridge(perms(
            &[PluginPermission::Filesystem],
            &[root.to_str().unwrap()],
        ));

        let mut entries = bridge.list_dir(root.to_str().unwrap()).unwrap();
        entries.sort();
        assert_eq!(entries, vec!["a.txt", "b.txt", "sub"]);

        // Out-of-scope listing is refused.
        let err = bridge.list_dir(dir.path().to_str().unwrap()).unwrap_err();
        assert!(matches!(
            err,
            termihub_plugin_api::PluginError::PermissionDenied
        ));
    }
}
