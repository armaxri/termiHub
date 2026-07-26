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
use std::time::Duration;

/// Host-side connect timeout applied to every mediated `open_connection` (#2024).
///
/// A bare `TcpStream::connect` blocks indefinitely on a black-holed host; this
/// per-connect ceiling is the host-side connection policy that keeps a plugin's
/// dial-out from hanging a session forever.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

use termihub_plugin_api::capabilities::{
    PluginBridgeDestroyFn, PluginFileMetadata, PluginListDirFn, PluginOpenConnectionFn,
    PluginReadFileFn, PluginStatPathFn, PluginWriteFileFn, PluginWriteMode,
};
use termihub_plugin_api::{
    FfiByteSlice, FfiOwnedBytes, FfiStr, PluginHostBridge, PluginStatus, PluginTcpStream,
};

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
    let write_file: PluginWriteFileFn = bridge_write_file;
    let stat_path: PluginStatPathFn = bridge_stat_path;
    let list_dir: PluginListDirFn = bridge_list_dir;
    let destroy: PluginBridgeDestroyFn = bridge_destroy;
    // SAFETY: `ctx` is a leaked `Box<PermissionSet>`; every callback below only
    // ever interprets it as exactly that, and `destroy` reclaims it exactly once.
    // `PermissionSet` is `Send + Sync`, matching the bridge's bounds.
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

/// Resolve `host:port` and connect with the host-side [`CONNECT_TIMEOUT`] policy.
///
/// Each resolved address is tried with [`TcpStream::connect_timeout`] so a
/// black-holed host cannot hang the connect indefinitely; the last error is
/// returned if every address fails or resolution yields none.
fn connect_with_timeout(host: &str, port: u16) -> std::io::Result<TcpStream> {
    let addrs = (host, port).to_socket_addrs()?;
    let mut last_err = std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no addresses resolved for host",
    );
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
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
        match connect_with_timeout(host_str, port) {
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
        let perms = unsafe { permissions(ctx) };
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
        let perms = unsafe { permissions(ctx) };
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
        let perms = unsafe { permissions(ctx) };
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
        bridge.overwrite(target.to_str().unwrap(), b"first").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first");

        // Truncate again replaces the contents.
        bridge
            .write_file(target.to_str().unwrap(), b"second", PluginWriteMode::Truncate)
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
        let err = bridge.write_new(target.to_str().unwrap(), b"b").unwrap_err();
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
        let err = bridge.overwrite(outside.to_str().unwrap(), b"x").unwrap_err();
        assert!(matches!(
            err,
            termihub_plugin_api::PluginError::PermissionDenied
        ));
        assert!(!outside.exists(), "denied write must not create the file");

        // A traversal escape from an in-scope prefix is rejected too.
        let escape = root.join("../escape2.txt");
        let err = bridge.overwrite(escape.to_str().unwrap(), b"x").unwrap_err();
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
        let err = bridge.overwrite(target.to_str().unwrap(), b"x").unwrap_err();
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
        let meta = bridge.stat(root.join("missing.txt").to_str().unwrap()).unwrap();
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
