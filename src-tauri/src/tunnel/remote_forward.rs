use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::thread;

use ssh2::Session;

use super::config::{RemoteForwardConfig, TunnelStats};
use super::local_forward::ForwarderStats;

/// Manages a remote port forwarding tunnel.
///
/// Binds a port on the SSH server and forwards incoming connections
/// to a local target.
pub struct RemoteForwarder {
    shutdown: Arc<AtomicBool>,
    listener_thread: Option<thread::JoinHandle<()>>,
    stats: Arc<ForwarderStats>,
}

impl RemoteForwarder {
    /// Start a remote port forwarding tunnel.
    pub fn start(
        config: &RemoteForwardConfig,
        session: Arc<Mutex<Session>>,
    ) -> Result<Self, std::io::Error> {
        let shutdown = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(ForwarderStats::new());

        let local_host = config.local_host.clone();
        let local_port = config.local_port;
        let remote_host = config.remote_host.clone();
        let remote_port = config.remote_port;
        let shutdown_clone = Arc::clone(&shutdown);
        let stats_clone = Arc::clone(&stats);

        let listener_thread = thread::spawn(move || {
            Self::forward_loop(
                session,
                &remote_host,
                remote_port,
                &local_host,
                local_port,
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

    /// Stop the forwarder and wait for the thread to finish.
    pub fn stop(&mut self) {
        self.shutdown
            .store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(handle) = self.listener_thread.take() {
            let _ = handle.join();
        }
    }

    fn forward_loop(
        session: Arc<Mutex<Session>>,
        remote_host: &str,
        remote_port: u16,
        local_host: &str,
        local_port: u16,
        shutdown: Arc<AtomicBool>,
        stats: Arc<ForwarderStats>,
    ) {
        // Request remote port forwarding from SSH server.
        // The ssh2 Listener must be kept alive to accept connections.
        let mut listener = {
            let sess = match session.lock() {
                Ok(s) => s,
                Err(_) => return,
            };
            match sess.channel_forward_listen(remote_port, Some(remote_host), None) {
                Ok((listener, port)) => {
                    tracing::info!(
                        "Remote forward listening on {}:{} (bound port {})",
                        remote_host,
                        remote_port,
                        port
                    );
                    listener
                }
                Err(e) => {
                    tracing::error!("Failed to request remote forwarding: {}", e);
                    return;
                }
            }
        };

        // Accept forwarded connections from the SSH server
        while !shutdown.load(std::sync::atomic::Ordering::Relaxed) {
            // Set session to non-blocking so accept doesn't hang forever
            {
                if let Ok(sess) = session.lock() {
                    sess.set_blocking(false);
                }
            }

            let channel = match listener.accept() {
                Ok(ch) => {
                    if let Ok(sess) = session.lock() {
                        sess.set_blocking(true);
                    }
                    Some(ch)
                }
                Err(_) => {
                    if let Ok(sess) = session.lock() {
                        sess.set_blocking(true);
                    }
                    None
                }
            };

            if let Some(mut channel) = channel {
                stats.increment_active();
                let local_addr = format!("{}:{}", local_host, local_port);
                let stats_clone = Arc::clone(&stats);
                let session_clone = Arc::clone(&session);
                let shutdown_clone = Arc::clone(&shutdown);

                thread::spawn(move || {
                    Self::relay_to_local(
                        &mut channel,
                        session_clone,
                        &local_addr,
                        &shutdown_clone,
                        &stats_clone,
                    );
                    stats_clone.decrement_active();
                });
            } else {
                thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }

    fn relay_to_local(
        channel: &mut ssh2::Channel,
        session: Arc<Mutex<Session>>,
        local_addr: &str,
        shutdown: &AtomicBool,
        stats: &ForwarderStats,
    ) {
        use std::io::{Read, Write};

        let mut tcp_stream = match std::net::TcpStream::connect(local_addr) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("Failed to connect to local target {}: {}", local_addr, e);
                return;
            }
        };

        if tcp_stream.set_nonblocking(true).is_err() {
            return;
        }

        let mut buf = [0u8; 8192];
        let mut tcp_eof = false;
        let mut ssh_eof = false;

        while !shutdown.load(std::sync::atomic::Ordering::Relaxed) && (!tcp_eof || !ssh_eof) {
            let mut did_work = false;

            // SSH -> TCP (from remote server to local target)
            if !ssh_eof {
                if let Ok(_sess) = session.lock() {
                    match channel.read(&mut buf) {
                        Ok(0) => ssh_eof = true,
                        Ok(n) => {
                            drop(_sess);
                            if tcp_stream.write_all(&buf[..n]).is_err() {
                                break;
                            }
                            stats.add_bytes_received(n as u64);
                            did_work = true;
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(_) => ssh_eof = true,
                    }
                }
            }

            // TCP -> SSH (from local target back to remote server)
            if !tcp_eof {
                match tcp_stream.read(&mut buf) {
                    Ok(0) => {
                        tcp_eof = true;
                        let _ = channel.send_eof();
                    }
                    Ok(n) => {
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

            if !did_work {
                thread::sleep(std::time::Duration::from_millis(10));
            }
        }

        let _ = channel.close();
        let _ = tcp_stream.shutdown(std::net::Shutdown::Both);
    }
}

impl Drop for RemoteForwarder {
    fn drop(&mut self) {
        self.stop();
    }
}
