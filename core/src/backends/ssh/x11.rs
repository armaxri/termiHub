//! X11 forwarding via SSH reverse port tunnel.
//!
//! Uses a dedicated SSH session with `channel_forward_listen()` to accept
//! X11 connections on the remote host and proxy them to the local X server.
//!
//! All SSH channel I/O runs on a single thread because libssh2 sessions
//! are not thread-safe.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tracing::{debug, error, info, warn};

use crate::config::SshConfig;
use crate::errors::SessionError;

use super::auth::connect_and_authenticate;

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

/// Manages X11 forwarding over an SSH tunnel.
pub struct X11Forwarder {
    alive: Arc<AtomicBool>,
    listener_handle: Option<std::thread::JoinHandle<()>>,
}

impl X11Forwarder {
    /// Start X11 forwarding using a new SSH session.
    ///
    /// Returns `(forwarder, remote_display_number, xauth_cookie)`.
    pub fn start(
        config: &SshConfig,
        alive: Arc<AtomicBool>,
    ) -> Result<(Self, u32, Option<String>), SessionError> {
        let local_x = detect_local_x_server().ok_or_else(|| {
            SessionError::SpawnFailed(
                "No local X server detected. Start an X server (XQuartz on macOS).".to_string(),
            )
        })?;

        info!(
            "X11 forwarding: detected local X server at display :{}",
            local_x.display_number
        );

        let xauth_cookie = read_local_xauth_cookie(local_x.display_number);
        if xauth_cookie.is_some() {
            info!("X11 forwarding: read local xauth cookie");
        } else {
            warn!(
                "X11 forwarding: no xauth cookie found for display :{}",
                local_x.display_number
            );
        }

        let session = connect_and_authenticate(config)?;

        let (mut listener, bound_port) = session
            .channel_forward_listen(0, Some("localhost"), None)
            .map_err(|e| SessionError::SpawnFailed(format!("X11 forward listen failed: {e}")))?;

        let display_number = (bound_port as u32).saturating_sub(6000);
        info!(
            "X11 forwarding: remote listening on port {} (display :{})",
            bound_port, display_number
        );

        session.set_blocking(false);

        let alive_clone = alive.clone();
        let listener_handle = std::thread::Builder::new()
            .name("x11-event-loop".to_string())
            .spawn(move || {
                event_loop(&session, &mut listener, &alive_clone, &local_x);
            })
            .map_err(|e| {
                SessionError::SpawnFailed(format!("Failed to spawn X11 event loop: {e}"))
            })?;

        Ok((
            Self {
                alive,
                listener_handle: Some(listener_handle),
            },
            display_number,
            xauth_cookie,
        ))
    }
}

impl Drop for X11Forwarder {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Some(handle) = self.listener_handle.take() {
            let _ = handle.join();
        }
        info!("X11 forwarder stopped");
    }
}

/// An active proxy connection between an SSH channel and a local X stream.
struct ActiveProxy {
    channel: ssh2::Channel,
    local_stream: LocalStream,
}

impl ActiveProxy {
    fn new(channel: ssh2::Channel, local_x: &LocalXServerInfo) -> Option<Self> {
        let local_stream = match &local_x.connection {
            #[cfg(unix)]
            LocalXConnection::UnixSocket(path) => {
                use std::os::unix::net::UnixStream;
                match UnixStream::connect(path) {
                    Ok(s) => {
                        let _ = s.set_nonblocking(true);
                        LocalStream::Unix(s)
                    }
                    Err(e) => {
                        error!(
                            "X11 proxy: failed to connect to Unix socket {}: {}",
                            path, e
                        );
                        return None;
                    }
                }
            }
            LocalXConnection::Tcp(host, port) => {
                match std::net::TcpStream::connect((host.as_str(), *port)) {
                    Ok(s) => {
                        let _ = s.set_nonblocking(true);
                        LocalStream::Tcp(s)
                    }
                    Err(e) => {
                        error!("X11 proxy: failed to connect to {}:{}: {}", host, port, e);
                        return None;
                    }
                }
            }
        };

        Some(Self {
            channel,
            local_stream,
        })
    }

    /// Pump data in both directions. Returns `true` if the proxy is still alive.
    fn pump(&mut self) -> bool {
        let mut buf = [0u8; 16384];

        // channel -> local X server
        match self.channel.read(&mut buf) {
            Ok(0) => return false,
            Ok(n) => {
                if write_all_nonblocking(&self.local_stream, &buf[..n]).is_err() {
                    return false;
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => return false,
        }

        // local X server -> channel
        match self.local_stream.read(&mut buf) {
            Ok(0) => return false,
            Ok(n) => {
                if write_all_retry(&mut self.channel, &buf[..n]).is_err() {
                    return false;
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => return false,
        }

        true
    }
}

/// Single-threaded event loop: accept new channels and pump all proxies.
fn event_loop(
    _session: &ssh2::Session,
    listener: &mut ssh2::Listener,
    alive: &Arc<AtomicBool>,
    local_x: &LocalXServerInfo,
) {
    let mut proxies: Vec<ActiveProxy> = Vec::new();

    while alive.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok(channel) => {
                debug!("X11 forwarding: accepted new channel");
                if let Some(proxy) = ActiveProxy::new(channel, local_x) {
                    proxies.push(proxy);
                }
            }
            Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                // EAGAIN / WouldBlock
            }
            Err(e) => {
                if alive.load(Ordering::SeqCst) {
                    warn!("X11 listener error: {}", e);
                }
                break;
            }
        }

        proxies.retain_mut(|proxy| proxy.pump());

        if proxies.is_empty() {
            std::thread::sleep(Duration::from_millis(50));
        } else {
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    for proxy in &mut proxies {
        let _ = proxy.channel.send_eof();
        let _ = proxy.channel.close();
    }
    debug!(
        "X11 event loop finished ({} proxies cleaned up)",
        proxies.len()
    );
}

/// Write all bytes to a non-blocking local stream, retrying on WouldBlock.
fn write_all_nonblocking(stream: &LocalStream, mut buf: &[u8]) -> std::io::Result<()> {
    while !buf.is_empty() {
        match stream.write(buf) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "write returned 0",
                ))
            }
            Ok(n) => buf = &buf[n..],
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_micros(100));
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Write all bytes to an SSH channel, retrying on WouldBlock.
fn write_all_retry(channel: &mut ssh2::Channel, mut buf: &[u8]) -> std::io::Result<()> {
    while !buf.is_empty() {
        match channel.write(buf) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "write returned 0",
                ))
            }
            Ok(n) => buf = &buf[n..],
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_micros(100));
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Wrapper around either a Unix or TCP stream for the local X connection.
enum LocalStream {
    #[cfg(unix)]
    Unix(std::os::unix::net::UnixStream),
    Tcp(std::net::TcpStream),
}

impl LocalStream {
    fn read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(unix)]
            Self::Unix(s) => (&*s).read(buf),
            Self::Tcp(s) => (&*s).read(buf),
        }
    }

    fn write(&self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(unix)]
            Self::Unix(s) => (&*s).write(buf),
            Self::Tcp(s) => (&*s).write(buf),
        }
    }
}

// --- X11 detection utilities ---

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
            // Local display `:N` — try Unix socket first, fall back to TCP.
            let socket_path = format!("/tmp/.X11-unix/X{display_number}");
            if std::path::Path::new(&socket_path).exists() {
                LocalXServerInfo {
                    display_number,
                    #[cfg(unix)]
                    connection: LocalXConnection::UnixSocket(socket_path),
                    #[cfg(not(unix))]
                    connection: LocalXConnection::Tcp(
                        "localhost".to_string(),
                        6000 + display_number as u16,
                    ),
                }
            } else {
                LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::Tcp(
                        "localhost".to_string(),
                        6000 + display_number as u16,
                    ),
                }
            }
        }
        Some(ref h) if h.starts_with('/') => {
            // macOS XQuartz: /private/tmp/com.apple.launchd.xxx/org.xquartz:0
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
            let socket_path = format!("/tmp/.X11-unix/X{display_number}");
            if std::path::Path::new(&socket_path).exists() {
                LocalXServerInfo {
                    display_number,
                    #[cfg(unix)]
                    connection: LocalXConnection::UnixSocket(socket_path),
                    #[cfg(not(unix))]
                    connection: LocalXConnection::Tcp(h.clone(), 6000 + display_number as u16),
                }
            } else {
                LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::Tcp(h.clone(), 6000 + display_number as u16),
                }
            }
        }
        Some(h) => {
            // Remote host — TCP only.
            LocalXServerInfo {
                display_number,
                connection: LocalXConnection::Tcp(h, 6000 + display_number as u16),
            }
        }
    }
}

/// Detect the local X server.
///
/// Checks the DISPLAY environment variable first, then falls back to
/// scanning `/tmp/.X11-unix/` for live sockets.
pub fn detect_local_x_server() -> Option<LocalXServerInfo> {
    if let Ok(display) = std::env::var("DISPLAY") {
        if !display.is_empty() {
            let (host, display_number, _screen) = parse_display(&display)?;
            return Some(info_from_parsed(host, display_number));
        }
    }
    detect_from_sockets()
}

/// Scan `/tmp/.X11-unix/` for X server sockets.
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
                let socket_path = format!("/tmp/.X11-unix/X{display_num}");
                return Some(LocalXServerInfo {
                    display_number: display_num,
                    #[cfg(unix)]
                    connection: LocalXConnection::UnixSocket(socket_path),
                    #[cfg(not(unix))]
                    connection: LocalXConnection::Tcp(
                        "localhost".to_string(),
                        6000 + display_num as u16,
                    ),
                });
            }
        }
    }
    None
}

/// Read the MIT-MAGIC-COOKIE-1 for the given local display number.
///
/// Runs `xauth list :N` and parses the hex cookie from the output.
/// Returns `None` if xauth is not installed or no cookie is found.
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
}
