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

/// Manages X11 forwarding over an SSH tunnel.
pub struct X11Forwarder {
    alive: Arc<AtomicBool>,
    task_handle: Option<tokio::task::JoinHandle<()>>,
}

impl X11Forwarder {
    /// Start X11 forwarding using an existing SSH session.
    ///
    /// Returns `(forwarder, remote_display_number, xauth_cookie)`.
    pub async fn start(
        _config: &SshConfig,
        session: &mut SshSession,
        registry: ForwardedChannelRegistry,
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
                return Some(LocalXServerInfo {
                    display_number: display_num,
                    #[cfg(unix)]
                    connection: LocalXConnection::UnixSocket(format!(
                        "/tmp/.X11-unix/X{display_num}"
                    )),
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
