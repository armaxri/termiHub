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

// ─── TFTP opcodes (RFC 1350 §5) ──────────────────────────────────────────────

const OP_RRQ: u16 = 1;
const OP_WRQ: u16 = 2;
const OP_DATA: u16 = 3;
const OP_ACK: u16 = 4;
const OP_ERROR: u16 = 5;

const BLOCK_SIZE: usize = 512;

// TFTP error codes (RFC 1350 §5).
const ERR_ACCESS: u16 = 2;
const ERR_ILLEGAL_OP: u16 = 4;

// ─── Public entry point ───────────────────────────────────────────────────────

/// Start the TFTP server in the current thread, blocking until the shutdown flag is set.
pub fn start_tftp_server(
    config: &EmbeddedServerConfig,
    shutdown: Arc<AtomicBool>,
    stats: Arc<AtomicServerStats>,
) -> Result<()> {
    let addr = format!("{}:{}", config.bind_host, config.port);
    let socket =
        UdpSocket::bind(&addr).with_context(|| format!("Failed to bind TFTP server to {addr}"))?;
    socket
        .set_read_timeout(Some(std::time::Duration::from_millis(100)))
        .context("Failed to set UDP read timeout")?;

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

        match opcode {
            OP_RRQ => {
                if let Some((filename, _mode)) = parse_request(payload) {
                    std::thread::spawn(move || {
                        stats.active_connections.fetch_add(1, Ordering::Relaxed);
                        stats.total_connections.fetch_add(1, Ordering::Relaxed);
                        if let Err(e) = handle_rrq(&root, &filename, peer, &bind_host, &stats) {
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
                        if let Err(e) = handle_wrq(&root, &filename, peer, &bind_host, &stats) {
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

        // Retry up to 5 times on timeout.
        let mut attempts = 0;
        loop {
            socket.send_to(&packet, peer).context("Send DATA failed")?;
            stats
                .bytes_sent
                .fetch_add(block_data.len() as u64, Ordering::Relaxed);

            // Wait for ACK.
            let mut ack_buf = [0u8; 4];
            match socket.recv_from(&mut ack_buf) {
                Ok((4, _)) => {
                    let ack_op = u16::from_be_bytes([ack_buf[0], ack_buf[1]]);
                    let ack_block = u16::from_be_bytes([ack_buf[2], ack_buf[3]]);
                    if ack_op == OP_ACK && ack_block == block_num {
                        break;
                    }
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    attempts += 1;
                    if attempts >= 5 {
                        return Err(anyhow::anyhow!("ACK timeout after {attempts} retries"));
                    }
                    continue;
                }
                Err(e) => return Err(e.into()),
                _ => {}
            }
        }
    }

    Ok(())
}

// ─── WRQ handler (client → server) ───────────────────────────────────────────

fn handle_wrq(
    root: &Path,
    filename: &str,
    peer: SocketAddr,
    bind_host: &str,
    stats: &AtomicServerStats,
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
        let (len, _) = socket.recv_from(&mut buf).context("Receive DATA failed")?;
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
}
