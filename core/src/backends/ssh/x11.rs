//! X11 forwarding via SSH reverse port tunnel (russh implementation).
//!
//! Uses russh's `tcpip_forward` to request the SSH server to listen for X11
//! connections, then routes incoming channels through the [`ForwardedChannelRegistry`]
//! to async proxy tasks that bridge to the local X server.

use std::any::Any;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;
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

impl LocalXServerInfo {
    /// Build info for a TCP-loopback X server on `display_number`
    /// (`127.0.0.1:6000+n`) — how every termiHub-managed server, and an adopted
    /// server on a reachable local TCP port, is reached.
    pub fn tcp_loopback(display_number: u32) -> Self {
        Self {
            display_number,
            connection: LocalXConnection::Tcp(
                "127.0.0.1".to_string(),
                6000 + display_number as u16,
            ),
        }
    }
}

/// A termiHub-managed local X server (one that termiHub itself started).
///
/// See epic #1047 / concept #1044 (X server provisioning). It carries everything
/// the forwarder needs, so the connect path can forward to it without any
/// filesystem/`xauth` probing — which are no-ops on Windows anyway.
#[derive(Debug, Clone)]
pub struct ManagedXServer {
    /// Display number the managed server listens on (TCP `127.0.0.1:6000+n`).
    pub display_number: u32,
    /// The MIT-MAGIC-COOKIE-1 (32 hex chars) generated when the server was
    /// started, or `None` when it runs in `-ac` (loopback-only, no auth) mode.
    pub cookie: Option<String>,
}

impl ManagedXServer {
    /// Resolve this managed server to a concrete [`ResolvedXServer`] (TCP
    /// loopback with the known cookie) ready to hand to [`X11Forwarder::start`].
    pub fn resolved(&self) -> ResolvedXServer {
        ResolvedXServer {
            info: LocalXServerInfo::tcp_loopback(self.display_number),
            cookie: self.cookie.clone(),
        }
    }
}

/// A fully-resolved local X server for the connect path to forward to, plus its
/// auth cookie.
///
/// Produced once by the desktop X server provisioner (for a managed *or* an
/// adopted server) and handed to [`X11Forwarder::start`], which then performs no
/// second socket/DISPLAY/TCP probe. When no provisioner is registered (core used
/// standalone, or in tests) the forwarder falls back to [`detect_local_x_server`].
#[derive(Debug, Clone)]
pub struct ResolvedXServer {
    /// Where to reach the server.
    pub info: LocalXServerInfo,
    /// MIT-MAGIC-COOKIE-1 (hex) to authorize the forwarded display, or `None`
    /// for a cookieless (`-ac`) server.
    pub cookie: Option<String>,
}

impl ResolvedXServer {
    /// Resolve a user-run X server (no termiHub provisioner) into a forwarding
    /// target: [`detect_local_x_server`] for the connection, then
    /// [`read_local_xauth_cookie`] for its cookie. `None` when no local server is
    /// found. Shared by [`X11Forwarder::start`]'s no-provisioner fallback and the
    /// desktop orchestrator so user-run resolution lives in one place.
    pub fn detect_user_run() -> Option<Self> {
        let info = detect_local_x_server()?;
        let cookie = read_local_xauth_cookie(info.display_number);
        Some(Self { info, cookie })
    }
}

/// The outcome of [`XServerProvisioner::ensure`]: where to forward, plus an
/// opaque session-lifetime guard.
///
/// The `guard` is a desktop-side RAII handle (a dependent-session refcount lease,
/// #1107) that core keeps alive alongside the [`X11Forwarder`] for the session's
/// lifetime and drops when the session ends — so the desktop side sees exactly
/// one release per acquired session, whether the session closed cleanly or the
/// connect failed after acquisition. Core treats it as an opaque `Any` and never
/// inspects it.
#[derive(Default)]
pub struct XServerLease {
    /// The resolved server to forward to, or `None` to fall back to
    /// [`detect_local_x_server`] (provisioning disabled / nothing resolved).
    pub resolved: Option<ResolvedXServer>,
    /// Opaque guard held for the session lifetime; dropping it releases the
    /// desktop-side session claim. `None` when nothing was claimed.
    pub guard: Option<Box<dyn Any + Send>>,
}

/// A hook the desktop app installs so the SSH connect path can ensure a usable
/// local X server *before* X11 forwarding starts.
///
/// Core cannot provision servers itself — VcXsrv acquisition, process lifecycle,
/// and the per-platform install flows all live in the desktop app layer
/// (`src-tauri`, epic #1047 / concept #1044). This trait is the seam: the app
/// registers an implementation via [`set_x_server_provisioner`] at startup, and
/// [`connect_shell`](super::connector::SshConnector) consults it whenever
/// `enable_x11_forwarding` is set. When no provisioner is registered (core used
/// standalone, or in tests) behavior is unchanged — detection falls back to a
/// user-run server.
#[async_trait]
pub trait XServerProvisioner: Send + Sync {
    /// Ensure a usable local X server exists, resolve where to reach it, and
    /// claim a dependent session against it.
    ///
    /// On success returns an [`XServerLease`]:
    /// - `lease.resolved = Some(resolved)` — a server (managed or adopted) is
    ///   ready; forward to `resolved.info` with `resolved.cookie`.
    /// - `lease.resolved = None` — provisioning is disabled or resolved nothing;
    ///   fall back to [`detect_local_x_server`] for a user-run server.
    /// - `lease.guard` — an opaque session-lifetime guard the connect path holds
    ///   until the session ends (see [`XServerLease`]).
    ///
    /// `cancel` is the connect-abort token (`None` when the caller has none): if
    /// the user aborts the connect while the provisioner is still bringing a
    /// server up (e.g. waiting for XQuartz on macOS, #1260), tripping it
    /// short-cuts that wait promptly instead of blocking to completion.
    ///
    /// `Err(message)` — provisioning failed; `message` is an actionable,
    /// user-facing explanation surfaced to the UI (never a silent no-op).
    async fn ensure(&self, cancel: Option<CancellationToken>) -> Result<XServerLease, String>;
}

static PROVISIONER: OnceLock<Arc<dyn XServerProvisioner>> = OnceLock::new();

/// Install the process-wide X server provisioner (called once at app startup).
///
/// The first registration wins; later calls are ignored.
pub fn set_x_server_provisioner(provisioner: Arc<dyn XServerProvisioner>) {
    let _ = PROVISIONER.set(provisioner);
}

/// Returns the registered X server provisioner, if any.
pub fn x_server_provisioner() -> Option<Arc<dyn XServerProvisioner>> {
    PROVISIONER.get().cloned()
}

/// First X11 display number to try when allocating a remote forward.
///
/// Matches OpenSSH's default `X11DisplayOffset`, keeping the forwarded display
/// out of the range a directly-attached X server would use (`:0`, `:1`).
const X11_DISPLAY_OFFSET: u16 = 10;

/// How many consecutive display numbers to probe before giving up (ports
/// `6000 + X11_DISPLAY_OFFSET ..`). Bounds the scan so a host with every X11
/// port taken fails promptly instead of walking thousands of ports.
const X11_MAX_DISPLAYS: u16 = 64;

/// Request a remote X11 listener on a conventional display port.
///
/// Scans display numbers `X11_DISPLAY_OFFSET .. + X11_MAX_DISPLAYS`, asking the
/// SSH server to bind `localhost:6000+display` for each until one succeeds.
/// Returns `(bound_port, display_number)` with `bound_port == 6000 + display`.
///
/// A specific-port `tcpip_forward` request is answered per RFC 4254 with **no**
/// port (russh returns `0`), so — unlike a `port 0` request whose reply carries
/// the actual high ephemeral port — success just means the server bound exactly
/// the port we asked for. We therefore key off the requested port, yielding a
/// small standard display number every X client accepts (issue #1304).
async fn request_x11_display_forward(session: &SshSession) -> Result<(u32, u32), SessionError> {
    for display_num in X11_DISPLAY_OFFSET..(X11_DISPLAY_OFFSET + X11_MAX_DISPLAYS) {
        let port = 6000 + display_num as u32;
        match session.tcpip_forward("localhost", port).await {
            Ok(_) => return Ok((port, display_num as u32)),
            Err(e) => {
                debug!("X11 forwarding: display :{display_num} (port {port}) unavailable ({e})");
            }
        }
    }
    Err(SessionError::SpawnFailed(format!(
        "X11 tcpip-forward failed: no free X11 display in :{}..:{}",
        X11_DISPLAY_OFFSET,
        X11_DISPLAY_OFFSET + X11_MAX_DISPLAYS
    )))
}

/// Manages X11 forwarding over an SSH tunnel.
pub struct X11Forwarder {
    alive: Arc<AtomicBool>,
    task_handle: Option<tokio::task::JoinHandle<()>>,
}

impl X11Forwarder {
    /// Start X11 forwarding using an existing SSH session.
    ///
    /// `resolved` is the server the desktop provisioner already resolved (managed
    /// or adopted); when present it is used as-is with **no** second
    /// socket/DISPLAY/TCP probe. Pass `None` (core standalone / tests) to detect
    /// a user-run server here via [`detect_local_x_server`].
    ///
    /// Returns `(forwarder, remote_display_number, xauth_cookie)`.
    pub async fn start(
        _config: &SshConfig,
        session: &mut SshSession,
        registry: ForwardedChannelRegistry,
        alive: Arc<AtomicBool>,
        resolved: Option<ResolvedXServer>,
    ) -> Result<(Self, u32, Option<String>), SessionError> {
        // Use the provisioner-resolved server as-is; without one, detect a
        // user-run server here (the sole fallback probe on the connect path).
        let ResolvedXServer {
            info: local_x,
            cookie: xauth_cookie,
        } = resolved
            .or_else(ResolvedXServer::detect_user_run)
            .ok_or_else(|| {
                SessionError::SpawnFailed(
                    "No local X server detected. Start an X server (XQuartz on macOS).".to_string(),
                )
            })?;

        info!(
            "X11 forwarding: using local X server at display :{}",
            local_x.display_number
        );

        if xauth_cookie.is_some() {
            info!("X11 forwarding: read local xauth cookie");
        } else {
            warn!(
                "X11 forwarding: no xauth cookie found for display :{}",
                local_x.display_number
            );
        }

        // Request the SSH server to listen for X11 connections on a conventional
        // X11 display port. Mirroring OpenSSH (X11DisplayOffset / X11MaxDisplays),
        // we scan display numbers from the offset and bind `6000 + display`, so
        // the remote `$DISPLAY` is a small, standard number (`:10`, `:11`, …) that
        // every X client accepts. Deriving the display from an arbitrary ephemeral
        // port (a `port 0` request) instead yields values like `:26961` that
        // stricter X clients refuse to connect to — so the forwarded X11
        // connection is never opened and no channel reaches this forwarder (#1304).
        let (bound_port, display_number) = request_x11_display_forward(session).await?;
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

/// Detect a user-run local X server.
///
/// A termiHub-**managed** server is resolved upstream by the desktop provisioner
/// (which hands the forwarder a [`ResolvedXServer`]); this covers only the
/// no-provisioner fallback. Resolution order (see the "Detection decision flow"
/// diagram in concept #1044):
/// 1. The `DISPLAY` environment variable, when set.
/// 2. Platform fallback: on Unix, scan `/tmp/.X11-unix/` for live sockets; on
///    Windows, probe `127.0.0.1:6000`.
pub fn detect_local_x_server() -> Option<LocalXServerInfo> {
    // 1. Honor an explicit DISPLAY.
    if let Ok(display) = std::env::var("DISPLAY") {
        if !display.is_empty() {
            let (host, display_number, _screen) = parse_display(&display)?;
            return Some(info_from_parsed(host, display_number));
        }
    }

    // 2. Platform fallback for user-installed servers.
    #[cfg(unix)]
    {
        detect_from_sockets()
    }
    #[cfg(not(unix))]
    {
        detect_from_tcp_probe()
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
        Some(LocalXServerInfo::tcp_loopback(0))
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
/// Runs `xauth list :N` and parses the hex cookie. Returns `None` if `xauth` is
/// not installed (e.g. Windows, where a `-ac` server still works) or no cookie
/// is found. A termiHub-managed server's cookie is known up front and threaded
/// through [`ResolvedXServer`] instead, so this is only the user-run path.
pub fn read_local_xauth_cookie(display_number: u32) -> Option<String> {
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

    // ── Resolved / managed server mapping (issue #1087) ──────────────────

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
    fn tcp_loopback_maps_display_to_port() {
        // Display :0 → 127.0.0.1:6000; display :3 → 127.0.0.1:6003.
        let zero = LocalXServerInfo::tcp_loopback(0);
        assert_eq!(zero.display_number, 0);
        assert_tcp(&zero.connection, "127.0.0.1", 6000);

        let three = LocalXServerInfo::tcp_loopback(3);
        assert_eq!(three.display_number, 3);
        assert_tcp(&three.connection, "127.0.0.1", 6003);
    }

    #[test]
    fn managed_server_resolves_to_tcp_loopback_with_cookie() {
        // A managed server on :2 resolves to TCP 127.0.0.1:6002 carrying its
        // known cookie — no filesystem/xauth probing needed at the forwarder.
        let resolved = ManagedXServer {
            display_number: 2,
            cookie: Some("cafebabe".to_string()),
        }
        .resolved();
        assert_eq!(resolved.info.display_number, 2);
        assert_tcp(&resolved.info.connection, "127.0.0.1", 6002);
        assert_eq!(resolved.cookie.as_deref(), Some("cafebabe"));
    }

    #[test]
    fn managed_server_without_cookie_resolves_ac_mode() {
        // A managed server started with `-ac` has no cookie; the resolved
        // server carries `None` so no `xauth` add is emitted.
        let resolved = ManagedXServer {
            display_number: 0,
            cookie: None,
        }
        .resolved();
        assert_tcp(&resolved.info.connection, "127.0.0.1", 6000);
        assert!(resolved.cookie.is_none());
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
