//! Host side of the plugin **capability bridge** (#2018).
//!
//! A native plugin reaches the network and the filesystem only through the
//! [`PluginHostBridge`](termihub_plugin_api::PluginHostBridge) it receives at
//! `create_backend`. In the plugin's runner process that bridge forwards every
//! call over IPC (#4183); the host's bridge service
//! ([`crate::plugin::sandbox`]) answers it with the guarded operations in this
//! module, which route every mediated operation through the session's
//! [`PermissionSet`] — [`PermissionSet::require`] for network, and
//! [`FilesystemScope::check`](super::FilesystemScope::check) (via
//! [`PermissionSet::check_path`]) for filesystem — and its [`ConnectionPolicy`].
//! So `network`/`filesystem` are enforced **at runtime**, not merely validated at
//! load (concept §13; the runtime half of the primitives added in #2001).
//!
//! # Enforcement boundary
//!
//! The bridge is the plugin's **only** route to the network and to files outside
//! its own data folder. Native plugins run out of process, in a
//! `termihub-plugin-runner` confined by the operating-system sandbox (ADR-19):
//! landlock + seccomp on Linux, Seatbelt on macOS, a Less-Privileged
//! AppContainer on Windows. A direct syscall that bypasses the bridge — opening
//! a socket, reading a file outside the data folder, spawning a process — is
//! refused by the OS, not by this module. The host-side checks here decide what
//! a bridge request may do; the sandbox guarantees that nothing else gets
//! through. See the [`termihub_plugin_api::capabilities`] module docs.

use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use termihub_plugin_api::{PluginFileMetadata, PluginStatus, PluginWriteMode};
use termihub_plugin_runner::ipc::{
    LIST_DIR_ENTRY_OVERHEAD, MAX_LIST_DIR_BYTES, MAX_LIST_DIR_ENTRIES,
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

/// A session's live count of mediated connections against its
/// [`ConnectionPolicy`] ceiling (#2028), held by the bridge service for every
/// runner session (#4183).
#[derive(Debug, Clone)]
pub(crate) struct ConnectionSlots {
    active: Arc<AtomicUsize>,
    max: usize,
}

impl ConnectionSlots {
    /// No connections held yet, bounded by `policy`'s ceiling.
    pub(crate) fn new(policy: &ConnectionPolicy) -> Self {
        Self {
            active: Arc::new(AtomicUsize::new(0)),
            max: policy.max_connections,
        }
    }

    /// Try to reserve one connection slot, returning a [`ConnectionGuard`] that
    /// releases it on drop, or `None` if the session is already at its
    /// concurrent-connection ceiling.
    pub(crate) fn try_reserve(&self) -> Option<ConnectionGuard> {
        // Optimistically claim a slot, then roll back if that pushed the session
        // over its ceiling. A single atomic keeps the count correct across the
        // several threads a backend may drive the bridge from.
        let prev = self.active.fetch_add(1, Ordering::AcqRel);
        if prev >= self.max {
            self.active.fetch_sub(1, Ordering::AcqRel);
            None
        } else {
            Some(ConnectionGuard {
                active_connections: Arc::clone(&self.active),
            })
        }
    }
}

/// Releases one reserved connection slot when the mediated stream is dropped.
///
/// The host keeps it until the runner reports the connection released
/// (#4183), so a session's live connection count falls the moment the plugin
/// drops a connection — freeing the slot for a later dial-out.
#[derive(Debug)]
pub(crate) struct ConnectionGuard {
    active_connections: Arc<AtomicUsize>,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.active_connections.fetch_sub(1, Ordering::AcqRel);
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

// ---------------------------------------------------------------------------
// The guarded operations
//
// One implementation of every mediated operation, called by the bridge service
// that answers a plugin runner's `BridgeRequest` frames (#4183). Each one runs
// the permission / scope / policy check before any I/O and reports a refusal as
// the status the ABI returns.
// ---------------------------------------------------------------------------

/// Resolve `requested` inside the plugin's declared filesystem scope.
fn scoped(permissions: &PermissionSet, requested: &str) -> Result<PathBuf, PluginStatus> {
    permissions
        .check_path(Path::new(requested))
        .map_err(|e| scope_error_status(&e))
}

/// `open_connection`: require `network`, reserve a connection slot, then
/// connect within the policy's timeout. The returned guard holds the slot until
/// dropped.
///
/// A missing `network` permission is [`PluginStatus::PermissionDenied`]; a
/// session at its concurrent-connection ceiling is
/// [`PluginStatus::ResourceLimit`] (#2030); a failed dial-out is
/// [`PluginStatus::Io`] (and frees the slot again).
pub(crate) fn guarded_connect(
    permissions: &PermissionSet,
    policy: &ConnectionPolicy,
    slots: &ConnectionSlots,
    host: &str,
    port: u16,
) -> Result<(TcpStream, ConnectionGuard), PluginStatus> {
    // Runtime enforcement: refuse before touching the network if the plugin
    // never requested `network`.
    permissions
        .require(PluginPermission::Network)
        .map_err(|_| PluginStatus::PermissionDenied)?;
    // Resource enforcement, released when the guard drops (or right here, on
    // connect failure).
    let guard = slots.try_reserve().ok_or(PluginStatus::ResourceLimit)?;
    let stream =
        connect_with_timeout(host, port, policy.connect_timeout).map_err(|_| PluginStatus::Io)?;
    Ok((stream, guard))
}

/// `read_file`, one chunk: up to `max` bytes at `offset` of an in-scope file,
/// plus whether the file ends there. The path is re-resolved for every chunk.
#[cfg_attr(
    not(unix),
    allow(dead_code, reason = "no Windows runner transport yet")
)]
pub(crate) fn guarded_read_chunk(
    permissions: &PermissionSet,
    path: &str,
    offset: u64,
    max: usize,
) -> Result<(Vec<u8>, bool), PluginStatus> {
    use std::io::{Read, Seek, SeekFrom};
    let resolved = scoped(permissions, path)?;
    let mut file = std::fs::File::open(resolved).map_err(|_| PluginStatus::Io)?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| PluginStatus::Io)?;
    let mut buf = Vec::with_capacity(max.min(64 * 1024));
    // `max + 1` bytes tell "exactly `max` left" apart from "more to come".
    let limit = u64::try_from(max).unwrap_or(u64::MAX).saturating_add(1);
    file.take(limit)
        .read_to_end(&mut buf)
        .map_err(|_| PluginStatus::Io)?;
    let eof = buf.len() <= max;
    buf.truncate(max);
    Ok((buf, eof))
}

/// `write_file`: open an in-scope path per `mode` and write `data`. An
/// out-of-scope or traversal path is rejected before any file is created or
/// opened (#2024).
pub(crate) fn guarded_write(
    permissions: &PermissionSet,
    path: &str,
    data: &[u8],
    mode: PluginWriteMode,
) -> Result<(), PluginStatus> {
    let resolved = scoped(permissions, path)?;
    let mut options = std::fs::OpenOptions::new();
    match mode {
        PluginWriteMode::Truncate => options.create(true).write(true).truncate(true),
        PluginWriteMode::Append => options.create(true).append(true),
        PluginWriteMode::CreateNew => options.create_new(true).write(true),
    };
    options
        .open(&resolved)
        .and_then(|mut f| f.write_all(data))
        .map_err(|_| PluginStatus::Io)
}

/// `stat_path`: metadata of an in-scope path; a missing one is
/// [`PluginFileMetadata::absent`], not an error.
pub(crate) fn guarded_stat(
    permissions: &PermissionSet,
    path: &str,
) -> Result<PluginFileMetadata, PluginStatus> {
    let resolved = scoped(permissions, path)?;
    match std::fs::metadata(&resolved) {
        Ok(m) => Ok(PluginFileMetadata {
            exists: true,
            is_dir: m.is_dir(),
            len: m.len(),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PluginFileMetadata::absent()),
        Err(_) => Err(PluginStatus::Io),
    }
}

/// `list_dir`: the entry names (lossy UTF-8) of an in-scope directory, in the
/// host's directory order.
///
/// Bounded (#4220): a directory with more than [`MAX_LIST_DIR_ENTRIES`]
/// entries, or whose names exceed [`MAX_LIST_DIR_BYTES`] (each charged its
/// length plus [`LIST_DIR_ENTRY_OVERHEAD`]), is refused with
/// [`PluginStatus::ResourceLimit`] while it is read, so the host never holds an
/// unbounded listing.
pub(crate) fn guarded_list_dir(
    permissions: &PermissionSet,
    path: &str,
) -> Result<Vec<String>, PluginStatus> {
    let resolved = scoped(permissions, path)?;
    let read_dir = std::fs::read_dir(&resolved).map_err(|_| PluginStatus::Io)?;
    collect_bounded(
        read_dir
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned()),
        MAX_LIST_DIR_ENTRIES,
        MAX_LIST_DIR_BYTES,
    )
}

/// Collect directory entry names, refusing with
/// [`PluginStatus::ResourceLimit`] as soon as more than `max_entries` arrive or
/// their charged size (length plus [`LIST_DIR_ENTRY_OVERHEAD`] each) passes
/// `max_bytes`.
fn collect_bounded(
    names: impl Iterator<Item = String>,
    max_entries: usize,
    max_bytes: usize,
) -> Result<Vec<String>, PluginStatus> {
    let mut out = Vec::new();
    let mut bytes = 0usize;
    for name in names {
        bytes = bytes.saturating_add(name.len().saturating_add(LIST_DIR_ENTRY_OVERHEAD));
        if out.len() >= max_entries || bytes > max_bytes {
            return Err(PluginStatus::ResourceLimit);
        }
        out.push(name);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    /// A permission set granting exactly `perms`, scoped to `fs_paths`.
    fn perms(perms: &[PluginPermission], fs_paths: &[&str]) -> PermissionSet {
        let owned: Vec<String> = fs_paths.iter().map(|s| (*s).to_owned()).collect();
        PermissionSet::from_parts(perms.iter().copied(), &owned)
    }

    /// Dial out under `permissions` and `policy` against `slots`.
    fn connect(
        permissions: &PermissionSet,
        policy: &ConnectionPolicy,
        slots: &ConnectionSlots,
        port: u16,
    ) -> Result<(TcpStream, ConnectionGuard), PluginStatus> {
        guarded_connect(permissions, policy, slots, "127.0.0.1", port)
    }

    /// Read the whole of a small in-scope file.
    fn read(permissions: &PermissionSet, path: &Path) -> Result<Vec<u8>, PluginStatus> {
        let (bytes, eof) = guarded_read_chunk(permissions, path.to_str().unwrap(), 0, 1 << 20)?;
        assert!(eof, "test files fit in one chunk");
        Ok(bytes)
    }

    /// Write `data` to `path` per `mode`.
    fn write(
        permissions: &PermissionSet,
        path: &Path,
        data: &[u8],
        mode: PluginWriteMode,
    ) -> Result<(), PluginStatus> {
        guarded_write(permissions, path.to_str().unwrap(), data, mode)
    }

    #[test]
    fn network_is_denied_without_the_permission() {
        // A plugin with no `network` permission cannot open a connection through
        // the bridge — the host refuses before the socket is ever touched.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let policy = ConnectionPolicy::default();
        let slots = ConnectionSlots::new(&policy);

        let err = connect(
            &perms(&[PluginPermission::Terminal], &[]),
            &policy,
            &slots,
            port,
        )
        .unwrap_err();
        assert_eq!(err, PluginStatus::PermissionDenied);

        // Nothing connected: a non-blocking accept finds no pending connection.
        listener.set_nonblocking(true).unwrap();
        assert!(
            listener.accept().is_err(),
            "denied plugin must not have opened a connection"
        );
    }

    /// SEC2-005: without the manifest's `allowLocalNetwork` opt-in a plugin
    /// cannot dial a loopback service — the host refuses before connecting.
    #[test]
    fn loopback_is_denied_without_the_local_network_opt_in() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let policy = ConnectionPolicy::default();
        let slots = ConnectionSlots::new(&policy);
        let granted = perms(&[PluginPermission::Network], &[]);

        for host in ["127.0.0.1", "localhost"] {
            let err = guarded_connect(&granted, &policy, &slots, host, port).unwrap_err();
            assert_eq!(err, PluginStatus::PermissionDenied, "{host} must be refused");
        }
        listener.set_nonblocking(true).unwrap();
        assert!(
            listener.accept().is_err(),
            "a refused loopback dial-out must never reach the socket"
        );
    }

    /// SEC2-005 / SEC2-007: link-local, unspecified, broadcast and cloud
    /// metadata targets are refused as a permission denial (never dialled), by
    /// default.
    #[test]
    fn metadata_and_link_local_targets_are_always_denied() {
        let policy = ConnectionPolicy::new(DEFAULT_MAX_CONNECTIONS, Duration::from_millis(300));
        let slots = ConnectionSlots::new(&policy);
        let granted = perms(&[PluginPermission::Network], &[]);
        for host in [
            "169.254.169.254",
            "169.254.1.1",
            "100.100.100.200",
            "0.0.0.0",
            "255.255.255.255",
            "::",
            "fe80::1",
            "fd00:ec2::254",
            "::ffff:169.254.169.254",
            "64:ff9b::a9fe:a9fe",
        ] {
            let err = guarded_connect(&granted, &policy, &slots, host, 80).unwrap_err();
            assert_eq!(err, PluginStatus::PermissionDenied, "{host} must be refused");
        }
    }

    #[test]
    fn network_is_mediated_when_granted() {
        // With `network` granted the host opens the connection and hands back a
        // stream the plugin can actually use.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 5];
            sock.read_exact(&mut buf).unwrap();
            sock.write_all(b"pong").unwrap();
            buf
        });

        let policy = ConnectionPolicy::default();
        let slots = ConnectionSlots::new(&policy);
        let (mut stream, _guard) = connect(
            &perms(&[PluginPermission::Network], &[]),
            &policy,
            &slots,
            port,
        )
        .expect("granted");
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
        // frees again the moment an open connection is released (#2028).
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
        let slots = ConnectionSlots::new(&policy);
        let granted = perms(&[PluginPermission::Network], &[]);

        // Two concurrent connections fit under the ceiling of 2.
        let c1 = connect(&granted, &policy, &slots, port).expect("first fits");
        let c2 = connect(&granted, &policy, &slots, port).expect("second fits");

        // The third, still holding the first two, is refused as ResourceLimit —
        // a ceiling refusal, distinct from a permission denial (#2030).
        let err = connect(&granted, &policy, &slots, port).unwrap_err();
        assert_eq!(err, PluginStatus::ResourceLimit);

        // Releasing one frees its slot, so the next dial-out succeeds again.
        drop(c1);
        let c3 = connect(&granted, &policy, &slots, port).expect("slot freed by drop");

        drop(c2);
        drop(c3);
        let _ = accepting.join();
    }

    #[test]
    fn connection_slot_is_released_when_the_connect_fails() {
        // A failed dial-out must not leak a slot: the reservation is released on
        // the error path, so a later connect still fits under the ceiling (#2028).
        // Hold a bound, never-listening socket so the dial-out fails for the whole
        // test (a dropped listener's port can be reused by a parallel test, #3532).
        let (_refusing, refused_addr) = crate::util::test_net::unconnectable_tcp_addr();
        let good = TcpListener::bind("127.0.0.1:0").unwrap();
        let good_port = good.local_addr().unwrap().port();
        let accepting = std::thread::spawn(move || good.accept().map(|(s, _)| s));

        // Ceiling of 1, and a short timeout so a refusal (Linux/Windows) or a
        // dropped SYN (macOS) resolves fast.
        let policy = ConnectionPolicy::new(1, Duration::from_secs(2));
        let slots = ConnectionSlots::new(&policy);
        let granted = perms(&[PluginPermission::Network], &[]);

        // The refused connect fails with an I/O error, not a permission denial…
        let err = connect(&granted, &policy, &slots, refused_addr.port()).unwrap_err();
        assert_eq!(err, PluginStatus::Io);

        // …and it must have released its slot, so this connect (the only one held)
        // fits under the ceiling of 1.
        let ok = connect(&granted, &policy, &slots, good_port)
            .expect("failed connect must not have leaked a slot");
        drop(ok);
        let _ = accepting.join();
    }

    #[test]
    fn connect_timeout_is_configurable_and_bounds_the_dial_out() {
        // The policy carries the timeout and the mediated connect honours it
        // (#2028). A short custom timeout against a black-holed (RFC 5737
        // TEST-NET-1) address returns an error well within the 30s default
        // rather than hanging on it.
        let policy = ConnectionPolicy::new(DEFAULT_MAX_CONNECTIONS, Duration::from_millis(300));
        assert_eq!(policy.connect_timeout(), Duration::from_millis(300));
        assert_eq!(policy.max_connections(), DEFAULT_MAX_CONNECTIONS);
        let slots = ConnectionSlots::new(&policy);

        let start = std::time::Instant::now();
        let err = guarded_connect(
            &perms(&[PluginPermission::Network], &[]),
            &policy,
            &slots,
            "192.0.2.1",
            9,
        )
        .unwrap_err();
        let elapsed = start.elapsed();
        assert_eq!(err, PluginStatus::Io);
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
        let granted = perms(&[PluginPermission::Filesystem], &[root.to_str().unwrap()]);

        // In-scope read succeeds and returns the real contents.
        assert_eq!(read(&granted, &inside).unwrap(), b"in-scope contents");

        // A read outside the declared scope is rejected — the host never opens
        // the file.
        assert_eq!(
            read(&granted, &outside),
            Err(PluginStatus::PermissionDenied)
        );

        // A traversal escape from an in-scope prefix is rejected too.
        let escape = root.join("../secret.txt");
        assert_eq!(read(&granted, &escape), Err(PluginStatus::PermissionDenied));
    }

    #[test]
    fn filesystem_read_is_chunked_and_reports_the_end() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("data.txt");
        std::fs::write(&file, b"0123456789").unwrap();
        let granted = perms(
            &[PluginPermission::Filesystem],
            &[dir.path().to_str().unwrap()],
        );
        let path = file.to_str().unwrap();

        assert_eq!(
            guarded_read_chunk(&granted, path, 0, 4).unwrap(),
            (b"0123".to_vec(), false)
        );
        assert_eq!(
            guarded_read_chunk(&granted, path, 4, 6).unwrap(),
            (b"456789".to_vec(), true)
        );
        assert_eq!(
            guarded_read_chunk(&granted, path, 10, 4).unwrap(),
            (Vec::new(), true)
        );
    }

    #[test]
    fn filesystem_read_is_denied_without_the_permission() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("data.txt");
        std::fs::write(&file, b"contents").unwrap();

        // No `filesystem` permission at all → every read is refused.
        let terminal_only = perms(&[PluginPermission::Terminal], &[]);
        assert_eq!(
            read(&terminal_only, &file),
            Err(PluginStatus::PermissionDenied)
        );
    }

    #[test]
    fn filesystem_write_is_mediated_within_scope() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("scoped");
        std::fs::create_dir_all(&root).unwrap();
        let granted = perms(&[PluginPermission::Filesystem], &[root.to_str().unwrap()]);

        // Create-or-truncate writes the file within scope.
        let target = root.join("out.txt");
        write(&granted, &target, b"first", PluginWriteMode::Truncate).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first");

        // Truncate again replaces the contents.
        write(&granted, &target, b"second", PluginWriteMode::Truncate).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second");

        // Append extends it.
        write(&granted, &target, b"-more", PluginWriteMode::Append).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second-more");
    }

    #[test]
    fn filesystem_create_new_fails_when_the_file_exists() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("scoped");
        std::fs::create_dir_all(&root).unwrap();
        let granted = perms(&[PluginPermission::Filesystem], &[root.to_str().unwrap()]);

        let target = root.join("new.txt");
        write(&granted, &target, b"a", PluginWriteMode::CreateNew).unwrap();
        // A second create-new on the same path is an I/O error (already exists),
        // not a permission denial.
        assert_eq!(
            write(&granted, &target, b"b", PluginWriteMode::CreateNew),
            Err(PluginStatus::Io)
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"a");
    }

    #[test]
    fn filesystem_write_is_denied_outside_scope() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("scoped");
        std::fs::create_dir_all(&root).unwrap();
        let granted = perms(&[PluginPermission::Filesystem], &[root.to_str().unwrap()]);

        // A write outside the declared scope is refused and never creates a file.
        let outside = dir.path().join("escape.txt");
        assert_eq!(
            write(&granted, &outside, b"x", PluginWriteMode::Truncate),
            Err(PluginStatus::PermissionDenied)
        );
        assert!(!outside.exists(), "denied write must not create the file");

        // A traversal escape from an in-scope prefix is rejected too.
        let escape = root.join("../escape2.txt");
        assert_eq!(
            write(&granted, &escape, b"x", PluginWriteMode::Truncate),
            Err(PluginStatus::PermissionDenied)
        );
    }

    #[test]
    fn filesystem_write_is_denied_without_the_permission() {
        let dir = tempfile::TempDir::new().unwrap();
        // No `filesystem` permission → writes are refused before any file opens.
        let terminal_only = perms(&[PluginPermission::Terminal], &[]);
        let target = dir.path().join("nope.txt");
        assert_eq!(
            write(&terminal_only, &target, b"x", PluginWriteMode::Truncate),
            Err(PluginStatus::PermissionDenied)
        );
        assert!(!target.exists());
    }

    #[test]
    fn filesystem_stat_reports_metadata_within_scope() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("scoped");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("data.txt");
        std::fs::write(&file, b"12345").unwrap();
        let granted = perms(&[PluginPermission::Filesystem], &[root.to_str().unwrap()]);
        let stat = |p: &Path| guarded_stat(&granted, p.to_str().unwrap());

        // A file: exists, not a dir, correct length.
        let meta = stat(&file).unwrap();
        assert!(meta.exists && !meta.is_dir);
        assert_eq!(meta.len, 5);

        // A directory: exists, is a dir.
        let meta = stat(&root).unwrap();
        assert!(meta.exists && meta.is_dir);

        // In-scope but absent path: reported as absent, not an error.
        assert!(!stat(&root.join("missing.txt")).unwrap().exists);

        // Out-of-scope stat is refused.
        let outside = dir.path().join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();
        assert_eq!(stat(&outside), Err(PluginStatus::PermissionDenied));
    }

    #[test]
    fn filesystem_list_dir_lists_entries_within_scope() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("scoped");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), b"a").unwrap();
        std::fs::write(root.join("b.txt"), b"b").unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        let granted = perms(&[PluginPermission::Filesystem], &[root.to_str().unwrap()]);

        let mut entries = guarded_list_dir(&granted, root.to_str().unwrap()).unwrap();
        entries.sort();
        assert_eq!(entries, vec!["a.txt", "b.txt", "sub"]);

        // Out-of-scope listing is refused.
        assert_eq!(
            guarded_list_dir(&granted, dir.path().to_str().unwrap()),
            Err(PluginStatus::PermissionDenied)
        );
    }

    #[cfg(unix)]
    #[test]
    fn list_dir_name_with_newline_is_one_entry() {
        // CORE-035: a Unix filename may legally contain a newline. It must come
        // back as a single entry (the runner's length-prefixed framing then
        // carries it to the plugin intact).
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("scoped");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("plain.txt"), b"x").unwrap();
        let weird = "weird\nname.txt";
        std::fs::write(root.join(weird), b"y").unwrap();
        let granted = perms(&[PluginPermission::Filesystem], &[root.to_str().unwrap()]);

        let mut entries = guarded_list_dir(&granted, root.to_str().unwrap()).unwrap();
        entries.sort();
        // Exactly two entries — the newline did not inject a spurious third.
        assert_eq!(entries, vec!["plain.txt".to_owned(), weird.to_owned()]);
    }

    #[test]
    fn a_listing_past_its_bounds_is_a_resource_limit() {
        let names = |n: usize| (0..n).map(|i| format!("e{i}"));
        // At the entry bound it is returned; one more is refused.
        assert_eq!(collect_bounded(names(3), 3, usize::MAX).unwrap().len(), 3);
        assert_eq!(
            collect_bounded(names(4), 3, usize::MAX),
            Err(PluginStatus::ResourceLimit)
        );
        // Each name is charged its length plus the per-entry overhead.
        let cost = 2 + LIST_DIR_ENTRY_OVERHEAD;
        assert_eq!(collect_bounded(names(5), 100, 5 * cost).unwrap().len(), 5);
        assert_eq!(
            collect_bounded(names(5), 100, 5 * cost - 1),
            Err(PluginStatus::ResourceLimit)
        );
        // An endless directory stops at the bound instead of exhausting memory.
        assert_eq!(
            collect_bounded((0..).map(|i: u64| i.to_string()), 1000, usize::MAX),
            Err(PluginStatus::ResourceLimit)
        );
    }
}
