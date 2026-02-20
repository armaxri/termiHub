use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use ssh2::Session;

use super::config::{LocalForwardConfig, TunnelStats};

/// Manages a local port forwarding tunnel.
///
/// Binds a local TCP listener and spawns relay threads for each incoming
/// connection, forwarding traffic through an SSH channel.
pub struct LocalForwarder {
    shutdown: Arc<AtomicBool>,
    listener_thread: Option<thread::JoinHandle<()>>,
    stats: Arc<ForwarderStats>,
}

/// Shared atomic counters for tracking tunnel statistics.
pub struct ForwarderStats {
    bytes_sent: AtomicU64,
    bytes_received: AtomicU64,
    active_connections: AtomicU32,
    total_connections: AtomicU64,
}

impl ForwarderStats {
    pub fn new() -> Self {
        Self {
            bytes_sent: AtomicU64::new(0),
            bytes_received: AtomicU64::new(0),
            active_connections: AtomicU32::new(0),
            total_connections: AtomicU64::new(0),
        }
    }

    pub fn to_tunnel_stats(&self) -> TunnelStats {
        TunnelStats {
            bytes_sent: self.bytes_sent.load(Ordering::Relaxed),
            bytes_received: self.bytes_received.load(Ordering::Relaxed),
            active_connections: self.active_connections.load(Ordering::Relaxed),
            total_connections: self.total_connections.load(Ordering::Relaxed),
        }
    }

    pub fn add_bytes_sent(&self, n: u64) {
        self.bytes_sent.fetch_add(n, Ordering::Relaxed);
    }

    pub fn add_bytes_received(&self, n: u64) {
        self.bytes_received.fetch_add(n, Ordering::Relaxed);
    }

    pub fn increment_active(&self) {
        self.active_connections.fetch_add(1, Ordering::Relaxed);
        self.total_connections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn decrement_active(&self) {
        self.active_connections.fetch_sub(1, Ordering::Relaxed);
    }
}

impl LocalForwarder {
    /// Start a local port forwarding tunnel.
    ///
    /// Binds to `config.local_host:config.local_port` and for each incoming
    /// connection, opens an SSH `channel_direct_tcpip` to
    /// `config.remote_host:config.remote_port` and relays data bidirectionally.
    pub fn start(
        config: &LocalForwardConfig,
        session: Arc<Mutex<Session>>,
    ) -> Result<Self, std::io::Error> {
        let addr = format!("{}:{}", config.local_host, config.local_port);
        let listener = TcpListener::bind(&addr)?;
        listener.set_nonblocking(true)?;

        let shutdown = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(ForwarderStats::new());

        let remote_host = config.remote_host.clone();
        let remote_port = config.remote_port;
        let shutdown_clone = Arc::clone(&shutdown);
        let stats_clone = Arc::clone(&stats);

        let listener_thread = thread::spawn(move || {
            Self::accept_loop(
                listener,
                session,
                &remote_host,
                remote_port,
                shutdown_clone,
                stats_clone,
            );
        });

        Ok(Self {
            shutdown,
            listener_thread: Some(listener_thread),
            stats,
        })
    }

    /// Get current tunnel statistics.
    pub fn get_stats(&self) -> TunnelStats {
        self.stats.to_tunnel_stats()
    }

    /// Stop the forwarder and wait for the listener thread to finish.
    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(handle) = self.listener_thread.take() {
            let _ = handle.join();
        }
    }

    fn accept_loop(
        listener: TcpListener,
        session: Arc<Mutex<Session>>,
        remote_host: &str,
        remote_port: u16,
        shutdown: Arc<AtomicBool>,
        stats: Arc<ForwarderStats>,
    ) {
        while !shutdown.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _addr)) => {
                    stats.increment_active();

                    let session = Arc::clone(&session);
                    let remote_host = remote_host.to_string();
                    let shutdown = Arc::clone(&shutdown);
                    let stats = Arc::clone(&stats);

                    // Each connection gets its own thread that owns the SSH channel.
                    // The session lock is held briefly to create the channel, then released.
                    thread::spawn(move || {
                        Self::relay_connection(
                            stream,
                            session,
                            &remote_host,
                            remote_port,
                            &shutdown,
                            &stats,
                        );
                        stats.decrement_active();
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    if !shutdown.load(Ordering::Relaxed) {
                        tracing::error!("Local forward accept error: {}", e);
                    }
                    break;
                }
            }
        }
    }

    /// Relay data between a TCP connection and an SSH channel.
    ///
    /// Uses a single-threaded polling approach because `ssh2::Channel` is `!Send`.
    /// Both the TCP stream and SSH session are set to non-blocking, and we poll
    /// both directions in a loop with a small sleep to avoid busy-waiting.
    fn relay_connection(
        mut tcp_stream: std::net::TcpStream,
        session: Arc<Mutex<Session>>,
        remote_host: &str,
        remote_port: u16,
        shutdown: &AtomicBool,
        stats: &ForwarderStats,
    ) {
        // Set TCP stream to non-blocking for polling
        if tcp_stream.set_nonblocking(true).is_err() {
            return;
        }

        // Open SSH channel — briefly lock session
        let mut channel = {
            let sess = match session.lock() {
                Ok(s) => s,
                Err(_) => return,
            };
            // Set session to non-blocking for the relay
            sess.set_blocking(false);
            match sess.channel_direct_tcpip(remote_host, remote_port, None) {
                Ok(ch) => ch,
                Err(e) => {
                    tracing::error!("Failed to open direct-tcpip channel: {}", e);
                    // Restore blocking mode
                    sess.set_blocking(true);
                    return;
                }
            }
        };
        // Session lock released here

        let mut buf = [0u8; 8192];
        let mut tcp_eof = false;
        let mut ssh_eof = false;

        while !shutdown.load(Ordering::Relaxed) && (!tcp_eof || !ssh_eof) {
            let mut did_work = false;

            // TCP -> SSH
            if !tcp_eof {
                match tcp_stream.read(&mut buf) {
                    Ok(0) => {
                        tcp_eof = true;
                        let _ = channel.send_eof();
                    }
                    Ok(n) => {
                        // Lock session briefly for channel write
                        if let Ok(_sess) = session.lock() {
                            if channel.write_all(&buf[..n]).is_err() {
                                break;
                            }
                            stats.add_bytes_sent(n as u64);
                            did_work = true;
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(_) => {
                        tcp_eof = true;
                        let _ = channel.send_eof();
                    }
                }
            }

            // SSH -> TCP
            if !ssh_eof {
                // Lock session briefly for channel read
                if let Ok(_sess) = session.lock() {
                    match channel.read(&mut buf) {
                        Ok(0) => {
                            ssh_eof = true;
                        }
                        Ok(n) => {
                            drop(_sess);
                            if tcp_stream.write_all(&buf[..n]).is_err() {
                                break;
                            }
                            stats.add_bytes_received(n as u64);
                            did_work = true;
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(_) => {
                            ssh_eof = true;
                        }
                    }
                }
            }

            if !did_work {
                thread::sleep(Duration::from_millis(10));
            }
        }

        // Clean up
        let _ = channel.close();
        let _ = tcp_stream.shutdown(std::net::Shutdown::Both);
    }
}

impl Drop for LocalForwarder {
    fn drop(&mut self) {
        self.stop();
    }
}
