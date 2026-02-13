//! X11 forwarding via SSH reverse port tunnel.
//!
//! Uses a dedicated SSH session (same pattern as SFTP) with
//! `channel_forward_listen()` to accept X11 connections on the remote
//! host and proxy them to the local X server.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tracing::{debug, error, info, warn};

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;
use crate::utils::x11_detect::{detect_local_x_server, LocalXConnection, LocalXServerInfo};

/// Manages X11 forwarding over an SSH tunnel.
pub struct X11Forwarder {
    alive: Arc<AtomicBool>,
    listener_handle: Option<std::thread::JoinHandle<()>>,
}

impl X11Forwarder {
    /// Start X11 forwarding using a new SSH session.
    ///
    /// Returns the forwarder and the remote display number that should
    /// be set as DISPLAY on the remote host.
    pub fn start(config: &SshConfig, alive: Arc<AtomicBool>) -> Result<(Self, u32), TerminalError> {
        let local_x = detect_local_x_server().ok_or_else(|| {
            TerminalError::SshError("No local X server detected. Set DISPLAY or start an X server (XQuartz on macOS).".to_string())
        })?;

        info!("X11 forwarding: detected local X server at display :{}", local_x.display_number);

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
            .name("x11-listener".to_string())
            .spawn(move || {
                listener_thread(&session, &mut listener, &alive_clone, &local_x);
            })
            .map_err(|e| TerminalError::SshError(format!("Failed to spawn X11 listener: {}", e)))?;

        Ok((
            Self {
                alive,
                listener_handle: Some(listener_handle),
            },
            display_number,
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

/// Accept incoming X11 channels and spawn proxy threads for each.
fn listener_thread(
    _session: &ssh2::Session,
    listener: &mut ssh2::Listener,
    alive: &Arc<AtomicBool>,
    local_x: &LocalXServerInfo,
) {
    while alive.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok(channel) => {
                debug!("X11 forwarding: accepted new channel");
                let local_x = local_x.clone();
                let alive = alive.clone();
                if let Err(e) = std::thread::Builder::new()
                    .name("x11-proxy".to_string())
                    .spawn(move || {
                        proxy_x11(channel, &local_x, &alive);
                    })
                {
                    error!("Failed to spawn X11 proxy thread: {}", e);
                }
            }
            Err(ref e) if e.code() == ssh2::ErrorCode::Session(-37) => {
                // EAGAIN / WouldBlock — no pending connections
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                if alive.load(Ordering::SeqCst) {
                    warn!("X11 listener error: {}", e);
                }
                break;
            }
        }
    }
}

/// Bidirectional proxy between an SSH channel and the local X server.
fn proxy_x11(
    mut channel: ssh2::Channel,
    local_x: &LocalXServerInfo,
    alive: &Arc<AtomicBool>,
) {
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
                        error!("X11 proxy: failed to connect to Unix socket {}: {}", path, e);
                        return;
                    }
                }
            }
            #[cfg(not(unix))]
            {
                error!("X11 proxy: Unix sockets not supported on this platform, socket path: {}", path);
                return;
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
                    return;
                }
            }
        }
    };

    let mut buf_ch = [0u8; 16384];
    let mut buf_local = [0u8; 16384];

    loop {
        if !alive.load(Ordering::SeqCst) {
            break;
        }

        let mut did_work = false;

        // channel → local
        match channel.read(&mut buf_ch) {
            Ok(0) => break,
            Ok(n) => {
                if local_stream.write_all(&buf_ch[..n]).is_err() {
                    break;
                }
                did_work = true;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }

        // local → channel
        match local_stream.read(&mut buf_local) {
            Ok(0) => break,
            Ok(n) => {
                if channel.write_all(&buf_local[..n]).is_err() {
                    break;
                }
                did_work = true;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }

        if !did_work {
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    let _ = channel.send_eof();
    let _ = channel.close();
    debug!("X11 proxy thread finished");
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

    fn write_all(&self, buf: &[u8]) -> std::io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(s) => (&*s).write_all(buf),
            Self::Tcp(s) => (&*s).write_all(buf),
        }
    }
}
