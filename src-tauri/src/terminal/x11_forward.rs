//! Legacy X11 forwarding via SSH reverse port tunnel.
//!
//! Uses a dedicated SSH session (same pattern as SFTP) with
//! `channel_forward_listen()` to accept X11 connections on the remote
//! host and proxy them to the local X server.
//!
//! All SSH channel I/O runs on a single thread because libssh2
//! sessions are not thread-safe.
//!
//! The canonical implementation is now in
//! [`termihub_core::backends::ssh::x11`](termihub_core::backends::ssh).
//! This module will be removed once all callers are migrated to use
//! the core SSH backend.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tracing::{debug, error, info, warn};

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;
use crate::utils::x11_detect::{
    detect_local_x_server, read_local_xauth_cookie, LocalXConnection, LocalXServerInfo,
};

/// Manages X11 forwarding over an SSH tunnel.
pub struct X11Forwarder {
    alive: Arc<AtomicBool>,
    listener_handle: Option<std::thread::JoinHandle<()>>,
}

impl X11Forwarder {
    /// Start X11 forwarding using a new SSH session.
    ///
    /// Returns `(forwarder, remote_display_number, xauth_cookie)`.
    /// The xauth cookie is the local display's MIT-MAGIC-COOKIE-1 that
    /// must be registered on the remote for authentication to work.
    pub fn start(
        config: &SshConfig,
        alive: Arc<AtomicBool>,
    ) -> Result<(Self, u32, Option<String>), TerminalError> {
        let local_x = detect_local_x_server().ok_or_else(|| {
            TerminalError::SshError(
                "No local X server detected. Start an X server (XQuartz on macOS).".to_string(),
            )
        })?;

        info!(
            "X11 forwarding: detected local X server at display :{}",
            local_x.display_number
        );

        // Read the local xauth cookie before we move local_x
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

        // Request the server to listen on a random port for X11 connections
        let (mut listener, bound_port) = session
            .channel_forward_listen(0, Some("localhost"), None)
            .map_err(|e| TerminalError::SshError(format!("X11 forward listen failed: {}", e)))?;

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
                TerminalError::SshError(format!("Failed to spawn X11 event loop: {}", e))
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
    /// Create a new proxy by connecting to the local X server.
    fn new(channel: ssh2::Channel, local_x: &LocalXServerInfo) -> Option<Self> {
        let local_stream = match &local_x.connection {
            LocalXConnection::UnixSocket(path) => {
                #[cfg(unix)]
                {
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
                #[cfg(not(unix))]
                {
                    error!(
                        "X11 proxy: Unix sockets not supported on this platform, path: {}",
                        path
                    );
                    return None;
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

        // channel → local X server
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

        // local X server → channel
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
///
/// All SSH operations happen on this one thread because libssh2 sessions
/// are not thread-safe.
fn event_loop(
    _session: &ssh2::Session,
    listener: &mut ssh2::Listener,
    alive: &Arc<AtomicBool>,
    local_x: &LocalXServerInfo,
) {
    let mut proxies: Vec<ActiveProxy> = Vec::new();

    while alive.load(Ordering::SeqCst) {
        // Accept new connections
        match listener.accept() {
            Ok(channel) => {
                debug!("X11 forwarding: accepted new channel");
                if let Some(proxy) = ActiveProxy::new(channel, local_x) {
                    proxies.push(proxy);
                }
            }
            Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                // EAGAIN / WouldBlock — no pending connections
            }
            Err(e) => {
                if alive.load(Ordering::SeqCst) {
                    warn!("X11 listener error: {}", e);
                }
                break;
            }
        }

        // Pump all active proxies, removing dead ones
        proxies.retain_mut(|proxy| proxy.pump());

        // Sleep briefly to avoid busy-spinning
        if proxies.is_empty() {
            std::thread::sleep(Duration::from_millis(50));
        } else {
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    // Clean up channels
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
