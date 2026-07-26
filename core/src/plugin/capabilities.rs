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

use std::net::TcpStream;
use std::path::Path;

use termihub_plugin_api::capabilities::{
    PluginBridgeDestroyFn, PluginOpenConnectionFn, PluginReadFileFn,
};
use termihub_plugin_api::{FfiOwnedBytes, FfiStr, PluginHostBridge, PluginStatus, PluginTcpStream};

use super::security::{PermissionError, PermissionSet};
use super::PluginPermission;

/// Build the host capability bridge for a session granted `permissions`.
///
/// The returned [`PluginHostBridge`] is passed by value into the plugin's
/// `create_backend`; the plugin owns it thereafter and drops it (running the
/// destructor installed here, which frees the boxed permission set). Every call a
/// plugin makes through the bridge is checked against `permissions` before the
/// host performs it.
#[must_use]
pub fn build_host_bridge(permissions: PermissionSet) -> PluginHostBridge {
    // The bridge context owns a clone of the granted permission set. Leaked as a
    // raw pointer to cross the ABI; `bridge_destroy` reclaims it.
    let ctx = Box::into_raw(Box::new(permissions)).cast::<core::ffi::c_void>();
    let open_connection: PluginOpenConnectionFn = bridge_open_connection;
    let read_file: PluginReadFileFn = bridge_read_file;
    let destroy: PluginBridgeDestroyFn = bridge_destroy;
    // SAFETY: `ctx` is a leaked `Box<PermissionSet>`; the three callbacks below
    // only ever interpret it as exactly that, and `destroy` reclaims it exactly
    // once. `PermissionSet` is `Send + Sync`, matching the bridge's bounds.
    unsafe { PluginHostBridge::from_raw(ctx, open_connection, read_file, Some(destroy)) }
}

/// Borrow the boxed [`PermissionSet`] behind a bridge `ctx`.
///
/// # Safety
///
/// `ctx` must be a live `*mut PermissionSet` produced by [`build_host_bridge`].
unsafe fn permissions<'a>(ctx: *mut core::ffi::c_void) -> &'a PermissionSet {
    // SAFETY: caller guarantees `ctx` is the leaked `Box<PermissionSet>`; borrowing
    // it shared is sound because every callback only reads it.
    unsafe { &*ctx.cast::<PermissionSet>() }
}

/// `open_connection` callback: enforce the `network` permission, then connect.
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
        let perms = unsafe { permissions(ctx) };
        // Runtime enforcement: refuse before touching the network if the plugin
        // never requested `network`.
        if perms.require(PluginPermission::Network).is_err() {
            return PluginStatus::PermissionDenied;
        }
        // SAFETY: `host` is a valid borrowed `&str` for the call.
        let host_str = unsafe { host.as_str() };
        match TcpStream::connect((host_str, port)) {
            Ok(stream) => {
                let handle = PluginTcpStream::from_std(stream);
                // SAFETY: `out_stream` is a valid, writable out-parameter.
                unsafe { out_stream.write(handle) };
                PluginStatus::Ok
            }
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
        let perms = unsafe { permissions(ctx) };
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
            Err(PermissionError::Denied(_)) | Err(PermissionError::PathOutsideScope { .. }) => {
                PluginStatus::PermissionDenied
            }
            Err(_) => PluginStatus::Other,
        }
    }));
    result.unwrap_or(PluginStatus::Panic)
}

/// Destructor for the bridge context: reclaim the boxed [`PermissionSet`].
///
/// # Safety
///
/// `ctx` must be the leaked `Box<PermissionSet>` from [`build_host_bridge`] and
/// must not be used afterwards.
unsafe extern "C" fn bridge_destroy(ctx: *mut core::ffi::c_void) {
    if !ctx.is_null() {
        // SAFETY: reclaims the box leaked in `build_host_bridge`, exactly once.
        drop(unsafe { Box::from_raw(ctx.cast::<PermissionSet>()) });
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
}
