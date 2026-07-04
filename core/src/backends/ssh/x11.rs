//! X11 forwarding via SSH reverse port tunnel (russh implementation).
//!
//! Uses russh's `tcpip_forward` to request the SSH server to listen for X11
//! connections, then routes incoming channels through the [`ForwardedChannelRegistry`]
//! to async proxy tasks that bridge to the local X server.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tracing::{debug, error, info, warn};

use crate::config::SshConfig;
use crate::errors::SessionError;

use super::handler::{ForwardedChannelRegistry, IncomingChannel, SshSession};

/// Describes how to connect to the local X server.
#[derive(Debug, Clone)]
pub enum LocalXConnection {
    #[cfg(unix)]
    UnixSocket(String),
    Tcp(String, u16),
}

/// Local X server info needed for forwarding.
#[derive(Debug, Clone)]
pub struct LocalXServerInfo {
    pub display_number: u32,
    pub connection: LocalXConnection,
}

/// A termiHub-managed local X server (one that termiHub itself started).
///
/// See epic #1047 / concept #1044 (X server provisioning). When present, this
/// carries everything the forwarder needs, so detection can skip all
/// filesystem/`xauth` probing — which are no-ops on Windows anyway.
#[derive(Debug, Clone)]
pub struct ManagedXServer {
    /// Display number the managed server listens on (TCP `127.0.0.1:6000+n`).
    pub display_number: u32,
    /// The MIT-MAGIC-COOKIE-1 (32 hex chars) generated when the server was
    /// started, or `None` when it runs in `-ac` (loopback-only, no auth) mode.
    pub cookie: Option<String>,
}

/// A source of termiHub-managed X server information.
///
/// This is a thin seam so detection can be managed-server-aware without a
/// global: the Windows [`XServerManager`] (issue #1049) will implement it, and
/// [`detect_local_x_server`] / [`read_local_xauth_cookie`] consult it first.
/// Until the manager lands, callers pass `None` and behavior is unchanged.
///
/// [`XServerManager`]: https://github.com/armaxri/termiHub/issues/1049
pub trait ManagedXServerSource: Send + Sync {
    /// Returns the currently managed local X server, if termiHub started one.
    fn managed_server(&self) -> Option<ManagedXServer>;
}

/// Manages X11 forwarding over an SSH tunnel.
pub struct X11Forwarder {
    alive: Arc<AtomicBool>,
    task_handle: Option<tokio::task::JoinHandle<()>>,
}

impl X11Forwarder {
    /// Start X11 forwarding using an existing SSH session.
    ///
    /// `managed` is an optional source of termiHub-managed X server info (a
    /// server termiHub started itself). When present it is consulted before any
    /// filesystem/`xauth` probing; pass `None` to rely purely on detection of a
    /// user-run server.
    ///
    /// Returns `(forwarder, remote_display_number, xauth_cookie)`.
    pub async fn start(
        _config: &SshConfig,
        session: &mut SshSession,
        registry: ForwardedChannelRegistry,
        alive: Arc<AtomicBool>,
        managed: Option<&dyn ManagedXServerSource>,
    ) -> Result<(Self, u32, Option<String>), SessionError> {
        let local_x = detect_local_x_server(managed).ok_or_else(|| {
            SessionError::SpawnFailed(
                "No local X server detected. Start an X server (XQuartz on macOS).".to_string(),
            )
        })?;

        info!(
            "X11 forwarding: detected local X server at display :{}",
            local_x.display_number
        );

        let xauth_cookie = read_local_xauth_cookie(local_x.display_number, managed);
        if xauth_cookie.is_some() {
            info!("X11 forwarding: read local xauth cookie");
        } else {
            warn!(
                "X11 forwarding: no xauth cookie found for display :{}",
                local_x.display_number
            );
        }

        // Request the SSH server to listen for X11 connections on a random port.
        let bound_port = session.tcpip_forward("localhost", 0).await.map_err(|e| {
            SessionError::SpawnFailed(format!("X11 tcpip-forward request failed: {e}"))
        })?;

        let display_number = bound_port.saturating_sub(6000);
        info!(
            "X11 forwarding: remote listening on port {} (display :{})",
            bound_port, display_number
        );

        // Register a receiver in the ForwardedChannelRegistry for the bound port.
        let (channel_tx, mut channel_rx) =
            tokio::sync::mpsc::unbounded_channel::<IncomingChannel>();
        {
            let mut reg = registry
                .lock()
                .map_err(|_| SessionError::SpawnFailed("Registry lock failed".to_string()))?;
            reg.insert(bound_port, channel_tx);
        }

        let alive_clone = alive.clone();
        let local_x = Arc::new(local_x);
        let registry_clone = registry.clone();

        let task_handle = tokio::spawn(async move {
            while alive_clone.load(Ordering::SeqCst) {
                tokio::select! {
                    biased;
                    incoming = channel_rx.recv() => {
                        match incoming {
                            Some(ch) => {
                                debug!("X11 forwarding: accepted new channel");
                                let local_x = local_x.clone();
                                tokio::spawn(async move {
                                    proxy_x11_channel(ch.channel, &local_x).await;
                                });
                            }
                            None => break,
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                }
            }

            // Deregister from the registry.
            if let Ok(mut reg) = registry_clone.lock() {
                reg.remove(&bound_port);
            }
            debug!("X11 event loop stopped");
        });

        Ok((
            Self {
                alive,
                task_handle: Some(task_handle),
            },
            display_number,
            xauth_cookie,
        ))
    }
}

impl Drop for X11Forwarder {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Some(handle) = self.task_handle.take() {
            handle.abort();
        }
        info!("X11 forwarder stopped");
    }
}

/// Proxy data bidirectionally between an SSH channel and the local X server.
async fn proxy_x11_channel(
    channel: russh::Channel<russh::client::Msg>,
    local_x: &LocalXServerInfo,
) {
    #[allow(unused_mut)]
    let mut channel_stream = channel.into_stream();

    match &local_x.connection {
        #[cfg(unix)]
        LocalXConnection::UnixSocket(path) => match tokio::net::UnixStream::connect(path).await {
            Ok(mut unix_stream) => {
                let _ = tokio::io::copy_bidirectional(&mut unix_stream, &mut channel_stream).await;
            }
            Err(e) => {
                error!("X11 proxy: failed to connect to Unix socket {path}: {e}");
            }
        },
        LocalXConnection::Tcp(host, port) => {
            match tokio::net::TcpStream::connect((host.as_str(), *port)).await {
                Ok(mut tcp_stream) => {
                    let _ =
                        tokio::io::copy_bidirectional(&mut tcp_stream, &mut channel_stream).await;
                }
                Err(e) => {
                    error!("X11 proxy: failed to connect to {host}:{port}: {e}");
                }
            }
        }
    }
}

// ── X11 detection utilities ──────────────────────────────────────────

/// Parse a DISPLAY string into (host, display_number, screen_number).
fn parse_display(display: &str) -> Option<(Option<String>, u32, u32)> {
    let colon_pos = display.rfind(':')?;
    let host_part = &display[..colon_pos];
    let display_screen = &display[colon_pos + 1..];

    let (display_num, screen_num) = if let Some(dot_pos) = display_screen.find('.') {
        let d: u32 = display_screen[..dot_pos].parse().ok()?;
        let s: u32 = display_screen[dot_pos + 1..].parse().ok()?;
        (d, s)
    } else {
        let d: u32 = display_screen.parse().ok()?;
        (d, 0)
    };

    let host = if host_part.is_empty() {
        None
    } else {
        Some(host_part.to_string())
    };

    Some((host, display_num, screen_num))
}

/// Build a `LocalXServerInfo` from a parsed DISPLAY value.
fn info_from_parsed(host: Option<String>, display_number: u32) -> LocalXServerInfo {
    match host {
        None => {
            #[cfg(unix)]
            {
                let socket_path = format!("/tmp/.X11-unix/X{display_number}");
                if std::path::Path::new(&socket_path).exists() {
                    return LocalXServerInfo {
                        display_number,
                        connection: LocalXConnection::UnixSocket(socket_path),
                    };
                }
            }
            LocalXServerInfo {
                display_number,
                connection: LocalXConnection::Tcp(
                    "localhost".to_string(),
                    6000 + display_number as u16,
                ),
            }
        }
        Some(ref h) if h.starts_with('/') => {
            #[cfg(unix)]
            {
                if std::path::Path::new(h).exists()
                    || std::path::Path::new(&format!("{h}:{display_number}")).exists()
                {
                    return LocalXServerInfo {
                        display_number,
                        connection: LocalXConnection::UnixSocket(h.clone()),
                    };
                }
            }
            LocalXServerInfo {
                display_number,
                connection: LocalXConnection::Tcp(
                    "localhost".to_string(),
                    6000 + display_number as u16,
                ),
            }
        }
        Some(ref h) if h == "localhost" || h == "127.0.0.1" || h == "::1" => {
            #[cfg(unix)]
            {
                let socket_path = format!("/tmp/.X11-unix/X{display_number}");
                if std::path::Path::new(&socket_path).exists() {
                    return LocalXServerInfo {
                        display_number,
                        connection: LocalXConnection::UnixSocket(socket_path),
                    };
                }
            }
            LocalXServerInfo {
                display_number,
                connection: LocalXConnection::Tcp(h.clone(), 6000 + display_number as u16),
            }
        }
        Some(h) => LocalXServerInfo {
            display_number,
            connection: LocalXConnection::Tcp(h, 6000 + display_number as u16),
        },
    }
}

/// Detect the local X server.
///
/// Resolution order (see the "Detection decision flow" diagram in concept
/// #1044):
/// 1. A termiHub-**managed** server (via `managed`) wins — returned as
///    `Tcp("127.0.0.1", 6000+n)` with no filesystem/`xauth` probing.
/// 2. The `DISPLAY` environment variable, when set.
/// 3. Platform fallback for user-run servers: on Unix, scan `/tmp/.X11-unix/`
///    for live sockets; on Windows, probe `127.0.0.1:6000`.
pub fn detect_local_x_server(
    managed: Option<&dyn ManagedXServerSource>,
) -> Option<LocalXServerInfo> {
    // 1. A termiHub-managed server takes precedence over everything.
    if let Some(server) = managed.and_then(|src| src.managed_server()) {
        return Some(managed_server_info(&server));
    }

    // 2. Honor an explicit DISPLAY.
    if let Ok(display) = std::env::var("DISPLAY") {
        if !display.is_empty() {
            let (host, display_number, _screen) = parse_display(&display)?;
            return Some(info_from_parsed(host, display_number));
        }
    }

    // 3. Platform fallback for user-installed servers.
    #[cfg(unix)]
    {
        detect_from_sockets()
    }
    #[cfg(not(unix))]
    {
        detect_from_tcp_probe()
    }
}

/// Map a managed server to a `LocalXServerInfo` (always TCP loopback).
fn managed_server_info(server: &ManagedXServer) -> LocalXServerInfo {
    LocalXServerInfo {
        display_number: server.display_number,
        connection: LocalXConnection::Tcp(
            "127.0.0.1".to_string(),
            6000 + server.display_number as u16,
        ),
    }
}

/// Scan `/tmp/.X11-unix/` for X server sockets (Unix only).
#[cfg(unix)]
fn detect_from_sockets() -> Option<LocalXServerInfo> {
    let x11_dir = std::path::Path::new("/tmp/.X11-unix");
    if !x11_dir.is_dir() {
        return None;
    }

    let entries = std::fs::read_dir(x11_dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(num_str) = name.strip_prefix('X') {
            if let Ok(display_num) = num_str.parse::<u32>() {
                return Some(LocalXServerInfo {
                    display_number: display_num,
                    connection: LocalXConnection::UnixSocket(format!(
                        "/tmp/.X11-unix/X{display_num}"
                    )),
                });
            }
        }
    }
    None
}

/// TCP fallback for platforms without `/tmp/.X11-unix` (Windows): probe whether
/// a user-installed X server (e.g. VcXsrv) is listening on `127.0.0.1:6000`
/// (display `:0`).
#[cfg(not(unix))]
fn detect_from_tcp_probe() -> Option<LocalXServerInfo> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 6000));
    if probe_tcp_x_server_at(addr, std::time::Duration::from_millis(300)) {
        Some(LocalXServerInfo {
            display_number: 0,
            connection: LocalXConnection::Tcp("127.0.0.1".to_string(), 6000),
        })
    } else {
        None
    }
}

/// Probe whether a TCP X server accepts a connection at `addr` within `timeout`.
///
/// Extracted from [`detect_from_tcp_probe`] so it is unit-testable on every
/// platform (the fallback itself is Windows-only) and shared with the desktop
/// [`XServerManager`] adopt-probe (issue #1049), keeping one definition of
/// "an X server is reachable on this TCP address".
///
/// [`XServerManager`]: https://github.com/armaxri/termiHub/issues/1049
pub fn probe_tcp_x_server_at(addr: std::net::SocketAddr, timeout: std::time::Duration) -> bool {
    std::net::TcpStream::connect_timeout(&addr, timeout).is_ok()
}

/// Read the MIT-MAGIC-COOKIE-1 for the given local display number.
///
/// Resolution order:
/// 1. If `managed` reports a server on this display, return its known cookie
///    directly — no `xauth` shell-out (which is a no-op on Windows). A `None`
///    cookie means the managed server runs in `-ac` mode.
/// 2. Otherwise run `xauth list :N` and parse the hex cookie. Returns `None` if
///    `xauth` is not installed (e.g. Windows without a managed server, where a
///    `-ac` server still works) or no cookie is found.
pub fn read_local_xauth_cookie(
    display_number: u32,
    managed: Option<&dyn ManagedXServerSource>,
) -> Option<String> {
    if let Some(server) = managed.and_then(|src| src.managed_server()) {
        if server.display_number == display_number {
            return server.cookie;
        }
    }

    let output = std::process::Command::new("xauth")
        .args(["list", &format!(":{display_number}")])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 && parts[1] == "MIT-MAGIC-COOKIE-1" {
            return Some(parts[2].to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_display_local() {
        let (host, display, screen) = parse_display(":0").unwrap();
        assert!(host.is_none());
        assert_eq!(display, 0);
        assert_eq!(screen, 0);
    }

    #[test]
    fn parse_display_local_with_screen() {
        let (host, display, screen) = parse_display(":0.0").unwrap();
        assert!(host.is_none());
        assert_eq!(display, 0);
        assert_eq!(screen, 0);
    }

    #[test]
    fn parse_display_local_high_number() {
        let (host, display, screen) = parse_display(":10.0").unwrap();
        assert!(host.is_none());
        assert_eq!(display, 10);
        assert_eq!(screen, 0);
    }

    #[test]
    fn parse_display_localhost() {
        let (host, display, screen) = parse_display("localhost:10.0").unwrap();
        assert_eq!(host.as_deref(), Some("localhost"));
        assert_eq!(display, 10);
        assert_eq!(screen, 0);
    }

    #[test]
    fn parse_display_remote_host() {
        let (host, display, screen) = parse_display("myhost:5.0").unwrap();
        assert_eq!(host.as_deref(), Some("myhost"));
        assert_eq!(display, 5);
        assert_eq!(screen, 0);
    }

    #[test]
    fn parse_display_xquartz() {
        let (host, display, screen) =
            parse_display("/private/tmp/com.apple.launchd.abc/org.xquartz:0").unwrap();
        assert_eq!(
            host.as_deref(),
            Some("/private/tmp/com.apple.launchd.abc/org.xquartz")
        );
        assert_eq!(display, 0);
        assert_eq!(screen, 0);
    }

    #[test]
    fn parse_display_empty() {
        assert!(parse_display("").is_none());
    }

    #[test]
    fn parse_display_no_colon() {
        assert!(parse_display("nodisplay").is_none());
    }

    #[test]
    fn parse_display_invalid_number() {
        assert!(parse_display(":abc").is_none());
    }

    // ── Managed-server-aware detection (issue #1051) ─────────────────────

    /// A test double for a termiHub-managed X server source.
    struct FakeManaged(Option<ManagedXServer>);

    impl ManagedXServerSource for FakeManaged {
        fn managed_server(&self) -> Option<ManagedXServer> {
            self.0.clone()
        }
    }

    /// Assert a connection is TCP to the expected host/port (cross-platform).
    fn assert_tcp(conn: &LocalXConnection, host: &str, port: u16) {
        match conn {
            LocalXConnection::Tcp(h, p) => {
                assert_eq!(h, host);
                assert_eq!(*p, port);
            }
            #[cfg(unix)]
            LocalXConnection::UnixSocket(_) => {
                panic!("expected a TCP connection, got a Unix socket")
            }
        }
    }

    #[test]
    fn detect_prefers_managed_server_over_everything() {
        // A managed server on display :0 must be returned as TCP 127.0.0.1:6000
        // with no filesystem/xauth probing — even if DISPLAY happens to be set
        // in the environment (managed is consulted first).
        let src = FakeManaged(Some(ManagedXServer {
            display_number: 0,
            cookie: Some("deadbeef".to_string()),
        }));
        let info = detect_local_x_server(Some(&src)).expect("managed server should be detected");
        assert_eq!(info.display_number, 0);
        assert_tcp(&info.connection, "127.0.0.1", 6000);

        // The managed cookie is returned directly, without shelling to `xauth`.
        assert_eq!(
            read_local_xauth_cookie(0, Some(&src)),
            Some("deadbeef".to_string())
        );
    }

    #[test]
    fn detect_managed_server_maps_display_to_port() {
        // Display :3 → TCP port 6003.
        let src = FakeManaged(Some(ManagedXServer {
            display_number: 3,
            cookie: None,
        }));
        let info = detect_local_x_server(Some(&src)).expect("managed server should be detected");
        assert_eq!(info.display_number, 3);
        assert_tcp(&info.connection, "127.0.0.1", 6003);
    }

    #[test]
    fn managed_server_without_cookie_is_ac_mode() {
        // A managed server started with `-ac` has no cookie; read must return
        // None (and must not shell to `xauth`).
        let src = FakeManaged(Some(ManagedXServer {
            display_number: 0,
            cookie: None,
        }));
        assert_eq!(read_local_xauth_cookie(0, Some(&src)), None);
    }

    #[test]
    fn no_managed_server_does_not_short_circuit() {
        // An empty managed source must behave exactly like `None`: detection
        // falls through to the platform path (no panic, returns an Option).
        let src = FakeManaged(None);
        let _ = detect_local_x_server(Some(&src));
    }

    #[test]
    fn tcp_probe_detects_open_and_refused_ports() {
        use std::net::TcpListener;
        use std::time::Duration;

        // An open listener is detected.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let open_addr = listener.local_addr().expect("local addr");
        assert!(probe_tcp_x_server_at(open_addr, Duration::from_millis(500)));

        // A refused (closed) port is not detected.
        let probe = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let closed_addr = probe.local_addr().expect("local addr");
        drop(probe);
        assert!(!probe_tcp_x_server_at(
            closed_addr,
            Duration::from_millis(200)
        ));
    }
}
