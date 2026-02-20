use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use ssh2::Session;

use super::config::{DynamicForwardConfig, TunnelStats};
use super::local_forward::ForwarderStats;

/// Manages a dynamic (SOCKS5) forwarding tunnel.
///
/// Binds a local TCP listener as a SOCKS5 proxy. For each incoming connection,
/// performs the SOCKS5 handshake (CONNECT only, no auth) and then relays
/// traffic through an SSH `channel_direct_tcpip`.
pub struct DynamicForwarder {
    shutdown: Arc<AtomicBool>,
    listener_thread: Option<thread::JoinHandle<()>>,
    stats: Arc<ForwarderStats>,
}

/// SOCKS5 constants.
const SOCKS5_VERSION: u8 = 0x05;
const SOCKS5_NO_AUTH: u8 = 0x00;
const SOCKS5_CMD_CONNECT: u8 = 0x01;
const SOCKS5_ATYP_IPV4: u8 = 0x01;
const SOCKS5_ATYP_DOMAIN: u8 = 0x03;
const SOCKS5_REP_SUCCESS: u8 = 0x00;
const SOCKS5_REP_GENERAL_FAILURE: u8 = 0x01;
const SOCKS5_REP_CMD_NOT_SUPPORTED: u8 = 0x07;

impl DynamicForwarder {
    /// Start a dynamic SOCKS5 forwarding tunnel.
    pub fn start(
        config: &DynamicForwardConfig,
        session: Arc<Mutex<Session>>,
    ) -> Result<Self, std::io::Error> {
        let addr = format!("{}:{}", config.local_host, config.local_port);
        let listener = TcpListener::bind(&addr)?;
        listener.set_nonblocking(true)?;

        let shutdown = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(ForwarderStats::new());

        let shutdown_clone = Arc::clone(&shutdown);
        let stats_clone = Arc::clone(&stats);

        let listener_thread = thread::spawn(move || {
            Self::accept_loop(listener, session, shutdown_clone, stats_clone);
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

    /// Stop the forwarder.
    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(handle) = self.listener_thread.take() {
            let _ = handle.join();
        }
    }

    fn accept_loop(
        listener: TcpListener,
        session: Arc<Mutex<Session>>,
        shutdown: Arc<AtomicBool>,
        stats: Arc<ForwarderStats>,
    ) {
        while !shutdown.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _addr)) => {
                    stats.increment_active();

                    let session = Arc::clone(&session);
                    let shutdown = Arc::clone(&shutdown);
                    let stats = Arc::clone(&stats);

                    thread::spawn(move || {
                        Self::handle_socks5(stream, session, &shutdown, &stats);
                        stats.decrement_active();
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    if !shutdown.load(Ordering::Relaxed) {
                        tracing::error!("SOCKS5 accept error: {}", e);
                    }
                    break;
                }
            }
        }
    }

    /// Handle a single SOCKS5 connection: handshake, then relay.
    fn handle_socks5(
        mut stream: std::net::TcpStream,
        session: Arc<Mutex<Session>>,
        shutdown: &AtomicBool,
        stats: &ForwarderStats,
    ) {
        // Set blocking for handshake
        if stream.set_nonblocking(false).is_err() {
            return;
        }
        if stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .is_err()
        {
            return;
        }

        // --- SOCKS5 Greeting ---
        let mut header = [0u8; 2];
        if stream.read_exact(&mut header).is_err() {
            return;
        }
        if header[0] != SOCKS5_VERSION {
            return;
        }

        let nmethods = header[1] as usize;
        let mut methods = vec![0u8; nmethods];
        if stream.read_exact(&mut methods).is_err() {
            return;
        }

        // We only support no-auth
        if !methods.contains(&SOCKS5_NO_AUTH) {
            let _ = stream.write_all(&[SOCKS5_VERSION, 0xFF]);
            return;
        }
        if stream.write_all(&[SOCKS5_VERSION, SOCKS5_NO_AUTH]).is_err() {
            return;
        }

        // --- SOCKS5 Request ---
        let mut req = [0u8; 4];
        if stream.read_exact(&mut req).is_err() {
            return;
        }
        if req[0] != SOCKS5_VERSION {
            return;
        }
        if req[1] != SOCKS5_CMD_CONNECT {
            // Only CONNECT is supported
            let _ = Self::send_reply(&mut stream, SOCKS5_REP_CMD_NOT_SUPPORTED);
            return;
        }

        // Parse destination address
        let (dest_host, dest_port) = match req[3] {
            SOCKS5_ATYP_IPV4 => {
                let mut addr = [0u8; 4];
                if stream.read_exact(&mut addr).is_err() {
                    return;
                }
                let host = format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3]);
                let mut port_buf = [0u8; 2];
                if stream.read_exact(&mut port_buf).is_err() {
                    return;
                }
                let port = u16::from_be_bytes(port_buf);
                (host, port)
            }
            SOCKS5_ATYP_DOMAIN => {
                let mut len = [0u8; 1];
                if stream.read_exact(&mut len).is_err() {
                    return;
                }
                let mut domain = vec![0u8; len[0] as usize];
                if stream.read_exact(&mut domain).is_err() {
                    return;
                }
                let host = match String::from_utf8(domain) {
                    Ok(h) => h,
                    Err(_) => return,
                };
                let mut port_buf = [0u8; 2];
                if stream.read_exact(&mut port_buf).is_err() {
                    return;
                }
                let port = u16::from_be_bytes(port_buf);
                (host, port)
            }
            _ => {
                // IPv6 and other types not supported
                let _ = Self::send_reply(&mut stream, SOCKS5_REP_CMD_NOT_SUPPORTED);
                return;
            }
        };

        // Open SSH channel to destination
        let mut channel = {
            let sess = match session.lock() {
                Ok(s) => s,
                Err(_) => return,
            };
            match sess.channel_direct_tcpip(&dest_host, dest_port, None) {
                Ok(ch) => ch,
                Err(e) => {
                    tracing::debug!(
                        "SOCKS5 channel_direct_tcpip to {}:{} failed: {}",
                        dest_host,
                        dest_port,
                        e
                    );
                    let _ = Self::send_reply(&mut stream, SOCKS5_REP_GENERAL_FAILURE);
                    return;
                }
            }
        };

        // Send success reply
        if Self::send_reply(&mut stream, SOCKS5_REP_SUCCESS).is_err() {
            return;
        }

        // Relay data bidirectionally
        if stream.set_nonblocking(true).is_err() {
            return;
        }

        let mut buf = [0u8; 8192];
        let mut tcp_eof = false;
        let mut ssh_eof = false;

        while !shutdown.load(Ordering::Relaxed) && (!tcp_eof || !ssh_eof) {
            let mut did_work = false;

            // TCP -> SSH
            if !tcp_eof {
                match stream.read(&mut buf) {
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

            // SSH -> TCP
            if !ssh_eof {
                if let Ok(_sess) = session.lock() {
                    match channel.read(&mut buf) {
                        Ok(0) => ssh_eof = true,
                        Ok(n) => {
                            drop(_sess);
                            if stream.write_all(&buf[..n]).is_err() {
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

            if !did_work {
                thread::sleep(Duration::from_millis(10));
            }
        }

        let _ = channel.close();
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }

    /// Send a SOCKS5 reply with the given status code.
    fn send_reply(stream: &mut std::net::TcpStream, rep: u8) -> std::io::Result<()> {
        // Reply: VER REP RSV ATYP BND.ADDR BND.PORT
        let reply = [
            SOCKS5_VERSION,
            rep,
            0x00, // RSV
            SOCKS5_ATYP_IPV4,
            0,
            0,
            0,
            0, // BND.ADDR (0.0.0.0)
            0,
            0, // BND.PORT (0)
        ];
        stream.write_all(&reply)
    }
}

impl Drop for DynamicForwarder {
    fn drop(&mut self) {
        self.stop();
    }
}
