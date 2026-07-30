//! Minimal TFTP server (RFC 1350).
//!
//! Handles RRQ (read) and WRQ (write) requests over UDP.
//! Each transfer is served in its own thread using a newly bound ephemeral port.

use std::net::{SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};

use super::config::{AtomicServerStats, EmbeddedServerConfig};
use super::service::BindSignal;

// ─── TFTP opcodes (RFC 1350 §5) ──────────────────────────────────────────────

const OP_RRQ: u16 = 1;
const OP_WRQ: u16 = 2;
const OP_DATA: u16 = 3;
const OP_ACK: u16 = 4;
const OP_ERROR: u16 = 5;

const BLOCK_SIZE: usize = 512;

/// Maximum number of DATA (re)transmissions before an RRQ block is abandoned.
const MAX_RETRIES: u32 = 5;

// TFTP error codes (RFC 1350 §5).
const ERR_ACCESS: u16 = 2;
const ERR_ILLEGAL_OP: u16 = 4;

// ─── Public entry point ───────────────────────────────────────────────────────

/// Start the TFTP server in the current thread, blocking until the shutdown flag is set.
///
/// `ready` is signalled exactly once as soon as the listening UDP socket is
/// bound (or if binding fails), so the manager only reports `Running` after the
/// bind is confirmed (GAP G3, #1145).
pub fn start_tftp_server(
    config: &EmbeddedServerConfig,
    shutdown: Arc<AtomicBool>,
    stats: Arc<AtomicServerStats>,
    ready: BindSignal,
) -> Result<()> {
    let addr = format!("{}:{}", config.bind_host, config.port);
    let socket = match UdpSocket::bind(&addr)
        .with_context(|| format!("Failed to bind TFTP server to {addr}"))
    {
        Ok(socket) => socket,
        Err(e) => {
            ready.fail(&e.to_string());
            return Err(e);
        }
    };
    if let Err(e) = socket
        .set_read_timeout(Some(std::time::Duration::from_millis(100)))
        .context("Failed to set UDP read timeout")
    {
        ready.fail(&e.to_string());
        return Err(e);
    }

    // Bind confirmed — tell the manager it is safe to report Running.
    ready.confirm();

    let root = PathBuf::from(&config.root_directory);
    let read_only = config.read_only;
    let bind_host = config.bind_host.clone();

    tracing::info!(addr, "TFTP server listening");

    let mut buf = [0u8; 516]; // 4-byte header + 512-byte data

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }

        let (len, peer) = match socket.recv_from(&mut buf) {
            Ok(r) => r,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(e) => {
                tracing::error!("TFTP recv error: {e}");
                break;
            }
        };

        if len < 2 {
            continue;
        }

        let opcode = u16::from_be_bytes([buf[0], buf[1]]);
        let payload = &buf[2..len];

        let root = root.clone();
        let stats = Arc::clone(&stats);
        let bind_host = bind_host.clone();
        let shutdown = Arc::clone(&shutdown);

        match opcode {
            OP_RRQ => {
                if let Some((filename, _mode)) = parse_request(payload) {
                    std::thread::spawn(move || {
                        stats.active_connections.fetch_add(1, Ordering::Relaxed);
                        stats.total_connections.fetch_add(1, Ordering::Relaxed);
                        if let Err(e) =
                            handle_rrq(&root, &filename, peer, &bind_host, &stats, &shutdown)
                        {
                            tracing::debug!(%peer, "TFTP RRQ error: {e}");
                        }
                        stats.active_connections.fetch_sub(1, Ordering::Relaxed);
                    });
                }
            }
            OP_WRQ => {
                if read_only {
                    let _ = send_error(&socket, peer, ERR_ACCESS, "Server is read-only");
                } else if let Some((filename, _mode)) = parse_request(payload) {
                    std::thread::spawn(move || {
                        stats.active_connections.fetch_add(1, Ordering::Relaxed);
                        stats.total_connections.fetch_add(1, Ordering::Relaxed);
                        if let Err(e) =
                            handle_wrq(&root, &filename, peer, &bind_host, &stats, &shutdown)
                        {
                            tracing::debug!(%peer, "TFTP WRQ error: {e}");
                        }
                        stats.active_connections.fetch_sub(1, Ordering::Relaxed);
                    });
                }
            }
            _ => {
                let _ = send_error(&socket, peer, ERR_ILLEGAL_OP, "Unexpected opcode");
            }
        }
    }

    Ok(())
}

// ─── RRQ handler (server → client) ───────────────────────────────────────────

fn handle_rrq(
    root: &Path,
    filename: &str,
    peer: SocketAddr,
    bind_host: &str,
    stats: &AtomicServerStats,
    shutdown: &Arc<AtomicBool>,
) -> Result<()> {
    let path = safe_path(root, filename).ok_or_else(|| anyhow::anyhow!("Access denied"))?;

    let data = std::fs::read(&path).with_context(|| format!("Cannot read {}", path.display()))?;

    // Bind an ephemeral port for this transfer.
    let transfer_addr = format!("{bind_host}:0");
    let socket = UdpSocket::bind(&transfer_addr).context("Cannot bind transfer socket")?;
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .context("Cannot set timeout")?;

    let blocks: Vec<&[u8]> = data.chunks(BLOCK_SIZE).collect();
    // A zero-length file still requires one empty DATA block.
    let total_blocks = blocks.len().max(1) as u16;

    for block_num in 1..=total_blocks {
        let block_data = if blocks.is_empty() {
            &[][..]
        } else {
            blocks[(block_num - 1) as usize]
        };

        // Send DATA packet.
        let mut packet = Vec::with_capacity(4 + block_data.len());
        packet.extend_from_slice(&OP_DATA.to_be_bytes());
        packet.extend_from_slice(&block_num.to_be_bytes());
        packet.extend_from_slice(block_data);

        stats
            .bytes_sent
            .fetch_add(block_data.len() as u64, Ordering::Relaxed);

        match wait_for_ack(&socket, peer, &packet, block_num, MAX_RETRIES, shutdown)? {
            AckOutcome::Acked => {}
            // Server was stopped mid-transfer: abort promptly instead of
            // burning the remaining retry budget (up to ~25s). (#1145 / G1)
            AckOutcome::Aborted => return Ok(()),
        }
    }

    Ok(())
}

/// Result of waiting for the ACK to a single RRQ DATA block.
#[derive(Debug)]
enum AckOutcome {
    /// The expected ACK arrived.
    Acked,
    /// The server shutdown flag was set; the transfer should stop.
    Aborted,
}

/// (Re)send `packet` to `peer` and wait for the ACK for `block_num`, retrying on
/// read timeout up to `max_retries` times.
///
/// Before each (re)transmit the `shutdown` flag is checked, so a stopped server
/// aborts an in-flight transfer promptly instead of running its full retry
/// budget. Returns [`AckOutcome::Aborted`] on shutdown, [`AckOutcome::Acked`] on
/// success, or an error if the retry budget is exhausted.
fn wait_for_ack(
    socket: &UdpSocket,
    peer: SocketAddr,
    packet: &[u8],
    block_num: u16,
    max_retries: u32,
    shutdown: &Arc<AtomicBool>,
) -> Result<AckOutcome> {
    let mut attempts = 0;
    loop {
        if shutdown.load(Ordering::Relaxed) {
            return Ok(AckOutcome::Aborted);
        }

        socket.send_to(packet, peer).context("Send DATA failed")?;

        // Wait for ACK.
        let mut ack_buf = [0u8; 4];
        match socket.recv_from(&mut ack_buf) {
            Ok((4, _)) => {
                let ack_op = u16::from_be_bytes([ack_buf[0], ack_buf[1]]);
                let ack_block = u16::from_be_bytes([ack_buf[2], ack_buf[3]]);
                if ack_op == OP_ACK && ack_block == block_num {
                    return Ok(AckOutcome::Acked);
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                attempts += 1;
                if attempts >= max_retries {
                    return Err(anyhow::anyhow!("ACK timeout after {attempts} retries"));
                }
                continue;
            }
            Err(e) => return Err(e.into()),
            _ => {}
        }
    }
}

// ─── WRQ handler (client → server) ───────────────────────────────────────────

fn handle_wrq(
    root: &Path,
    filename: &str,
    peer: SocketAddr,
    bind_host: &str,
    stats: &AtomicServerStats,
    shutdown: &Arc<AtomicBool>,
) -> Result<()> {
    let path = safe_path(root, filename).ok_or_else(|| anyhow::anyhow!("Access denied"))?;

    let transfer_addr = format!("{bind_host}:0");
    let socket = UdpSocket::bind(&transfer_addr).context("Cannot bind transfer socket")?;
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .context("Cannot set timeout")?;

    // Send initial ACK block 0.
    let ack0 = make_ack(0);
    socket
        .send_to(&ack0, peer)
        .context("Send initial ACK failed")?;

    let mut file_data: Vec<u8> = Vec::new();
    let mut buf = [0u8; 516];
    let mut expected_block: u16 = 1;

    loop {
        // Abort promptly if the server was stopped mid-transfer. (#1145 / G1)
        if shutdown.load(Ordering::Relaxed) {
            return Ok(());
        }

        let (len, _) = match socket.recv_from(&mut buf) {
            Ok(r) => r,
            // The read timeout lets us re-check the shutdown flag instead of
            // blocking indefinitely on a stalled client.
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(e) => return Err(anyhow::Error::new(e).context("Receive DATA failed")),
        };
        if len < 4 {
            continue;
        }
        let op = u16::from_be_bytes([buf[0], buf[1]]);
        let block_num = u16::from_be_bytes([buf[2], buf[3]]);

        if op != OP_DATA {
            break;
        }
        if block_num != expected_block {
            // Resend previous ACK.
            let ack = make_ack(expected_block.wrapping_sub(1));
            let _ = socket.send_to(&ack, peer);
            continue;
        }

        let data_slice = &buf[4..len];
        file_data.extend_from_slice(data_slice);
        stats
            .bytes_received
            .fetch_add(data_slice.len() as u64, Ordering::Relaxed);

        let ack = make_ack(block_num);
        socket.send_to(&ack, peer).context("Send ACK failed")?;

        expected_block = expected_block.wrapping_add(1);

        // Last block is < 512 bytes.
        if data_slice.len() < BLOCK_SIZE {
            break;
        }
    }

    std::fs::write(&path, &file_data)
        .with_context(|| format!("Cannot write {}", path.display()))?;

    Ok(())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Parse a TFTP RRQ/WRQ payload: `filename\0mode\0`.
fn parse_request(payload: &[u8]) -> Option<(String, String)> {
    let first_nul = payload.iter().position(|&b| b == 0)?;
    let filename = std::str::from_utf8(&payload[..first_nul]).ok()?;
    let rest = &payload[first_nul + 1..];
    let second_nul = rest.iter().position(|&b| b == 0)?;
    let mode = std::str::from_utf8(&rest[..second_nul]).ok()?;
    Some((filename.to_string(), mode.to_string()))
}

/// Resolve `filename` relative to `root`, rejecting any path traversal.
fn safe_path(root: &Path, filename: &str) -> Option<PathBuf> {
    let stripped = filename.trim_start_matches('/');
    let candidate = root.join(stripped);
    let normalised = normalise_path(&candidate);
    if normalised.starts_with(root) {
        Some(normalised)
    } else {
        None
    }
}

/// Normalise a path by resolving `.` and `..` without filesystem access.
fn normalise_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut components: Vec<Component> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(components.last(), Some(Component::Normal(_))) {
                    components.pop();
                }
            }
            other => components.push(other),
        }
    }
    components.iter().collect()
}

/// Build a 4-byte ACK packet.
fn make_ack(block: u16) -> [u8; 4] {
    let [o1, o2] = OP_ACK.to_be_bytes();
    let [b1, b2] = block.to_be_bytes();
    [o1, o2, b1, b2]
}

/// Send a TFTP ERROR packet.
fn send_error(socket: &UdpSocket, peer: SocketAddr, code: u16, msg: &str) -> std::io::Result<()> {
    let mut packet = Vec::with_capacity(5 + msg.len());
    packet.extend_from_slice(&OP_ERROR.to_be_bytes());
    packet.extend_from_slice(&code.to_be_bytes());
    packet.extend_from_slice(msg.as_bytes());
    packet.push(0);
    socket.send_to(&packet, peer)?;
    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_request_valid() {
        let payload = b"firmware.bin\0octet\0";
        let (filename, mode) = parse_request(payload).unwrap();
        assert_eq!(filename, "firmware.bin");
        assert_eq!(mode, "octet");
    }

    #[test]
    fn parse_request_missing_nul() {
        let payload = b"firmware.bin";
        assert!(parse_request(payload).is_none());
    }

    #[test]
    fn make_ack_correct_bytes() {
        let ack = make_ack(3);
        assert_eq!(ack, [0, 4, 0, 3]);
    }

    /// Bind a UDP socket to an ephemeral loopback port with the same short read
    /// timeout the transfer helpers use, so the ACK-wait loop hits a timeout on
    /// every attempt (no peer ever replies).
    fn test_socket() -> UdpSocket {
        let socket = UdpSocket::bind("127.0.0.1:0").expect("bind test socket");
        socket
            .set_read_timeout(Some(std::time::Duration::from_millis(50)))
            .expect("set timeout");
        socket
    }

    #[test]
    fn wait_for_ack_aborts_immediately_when_shutdown_set() {
        // Regression for #1145 (G1): an in-flight transfer must abort promptly
        // when the server is stopped, instead of burning its full retry budget.
        let socket = test_socket();
        let peer: SocketAddr = "127.0.0.1:9".parse().expect("parse peer");
        let shutdown = Arc::new(AtomicBool::new(true));

        let start = std::time::Instant::now();
        let outcome = wait_for_ack(&socket, peer, &[0, 3, 0, 1], 1, MAX_RETRIES, &shutdown);
        let elapsed = start.elapsed();

        assert!(
            matches!(outcome, Ok(AckOutcome::Aborted)),
            "expected Aborted, got {outcome:?}"
        );
        // Must not have waited even a single full 50ms read timeout, let alone
        // the 5 × 5s budget of the real server.
        assert!(
            elapsed < std::time::Duration::from_millis(40),
            "aborted too slowly: {elapsed:?}"
        );
    }

    #[test]
    fn wait_for_ack_times_out_after_retry_budget_without_shutdown() {
        // Without shutdown, the loop must exhaust its retry budget (no peer ever
        // ACKs), proving the shutdown check is what changes the outcome above.
        let socket = test_socket();
        let peer: SocketAddr = "127.0.0.1:9".parse().expect("parse peer");
        let shutdown = Arc::new(AtomicBool::new(false));

        let outcome = wait_for_ack(&socket, peer, &[0, 3, 0, 1], 1, 2, &shutdown);
        assert!(outcome.is_err(), "expected timeout error, got {outcome:?}");
    }
}
