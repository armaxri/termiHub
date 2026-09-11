//! Minimal TFTP server (RFC 1350).
//!
//! Handles RRQ (read) and WRQ (write) requests over UDP.
//! Each transfer is served in its own thread using a newly bound ephemeral port.

use std::io::{Read, Write};
use std::net::{SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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

/// Default ceiling on the size of a single TFTP transfer when the server config
/// does not specify one. TFTP is unauthenticated, so an uncapped WRQ lets any
/// client stream an arbitrarily large file and OOM/fill the host (CORE-021);
/// this default bounds a single transfer to 100 MiB, comfortably above typical
/// firmware/config payloads while still preventing an unbounded write.
const DEFAULT_MAX_TRANSFER_BYTES: u64 = 100 * 1024 * 1024;

/// Maximum number of transfers served concurrently. Each accepted RRQ/WRQ runs
/// on its own thread; without a cap an unauthenticated client can flood the
/// server with datagrams and spawn threads without bound (CORE-022). Requests
/// arriving while this many transfers are already in flight are rejected with a
/// TFTP ERROR rather than spawning another thread.
const MAX_CONCURRENT_TRANSFERS: usize = 64;

// TFTP error codes (RFC 1350 §5).
const ERR_NOT_DEFINED: u16 = 0;
const ERR_ACCESS: u16 = 2;
const ERR_DISK_FULL: u16 = 3;
const ERR_ILLEGAL_OP: u16 = 4;
const ERR_UNKNOWN_TID: u16 = 5;

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
    let max_bytes = config
        .max_transfer_bytes
        .unwrap_or(DEFAULT_MAX_TRANSFER_BYTES);

    // In-flight transfer counter, used to cap concurrency (CORE-022). Only the
    // accept loop increments it (single-threaded), so the reserve check below
    // cannot overshoot the cap; worker threads decrement it on completion.
    let in_flight = Arc::new(AtomicUsize::new(0));

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

        let in_flight = Arc::clone(&in_flight);

        match opcode {
            OP_RRQ => {
                if let Some((filename, _mode)) = parse_request(payload) {
                    if !try_reserve_slot(&in_flight, MAX_CONCURRENT_TRANSFERS) {
                        let _ = send_error(
                            &socket,
                            peer,
                            ERR_NOT_DEFINED,
                            "Server busy: too many concurrent transfers",
                        );
                        continue;
                    }
                    std::thread::spawn(move || {
                        stats.active_connections.fetch_add(1, Ordering::Relaxed);
                        stats.total_connections.fetch_add(1, Ordering::Relaxed);
                        if let Err(e) = handle_rrq(
                            &root, &filename, peer, &bind_host, max_bytes, &stats, &shutdown,
                        ) {
                            tracing::debug!(%peer, "TFTP RRQ error: {e}");
                        }
                        stats.active_connections.fetch_sub(1, Ordering::Relaxed);
                        in_flight.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            }
            OP_WRQ => {
                if read_only {
                    let _ = send_error(&socket, peer, ERR_ACCESS, "Server is read-only");
                } else if let Some((filename, _mode)) = parse_request(payload) {
                    if !try_reserve_slot(&in_flight, MAX_CONCURRENT_TRANSFERS) {
                        let _ = send_error(
                            &socket,
                            peer,
                            ERR_NOT_DEFINED,
                            "Server busy: too many concurrent transfers",
                        );
                        continue;
                    }
                    std::thread::spawn(move || {
                        stats.active_connections.fetch_add(1, Ordering::Relaxed);
                        stats.total_connections.fetch_add(1, Ordering::Relaxed);
                        if let Err(e) = handle_wrq(
                            &root, &filename, peer, &bind_host, max_bytes, &stats, &shutdown,
                        ) {
                            tracing::debug!(%peer, "TFTP WRQ error: {e}");
                        }
                        stats.active_connections.fetch_sub(1, Ordering::Relaxed);
                        in_flight.fetch_sub(1, Ordering::SeqCst);
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
    max_bytes: u64,
    stats: &AtomicServerStats,
    shutdown: &Arc<AtomicBool>,
) -> Result<()> {
    let path = safe_path(root, filename).ok_or_else(|| anyhow::anyhow!("Access denied"))?;

    // Open the file and stream it block-by-block rather than reading the whole
    // thing into memory, so a large served file cannot balloon host memory
    // (CORE-021, read side).
    let file =
        std::fs::File::open(&path).with_context(|| format!("Cannot read {}", path.display()))?;

    // Bind an ephemeral port for this transfer.
    let transfer_addr = format!("{bind_host}:0");
    let socket = UdpSocket::bind(&transfer_addr).context("Cannot bind transfer socket")?;
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .context("Cannot set timeout")?;

    // Reject oversized files up front so we never start streaming something that
    // would exceed the configured cap.
    let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file_len > max_bytes {
        let _ = send_error(
            &socket,
            peer,
            ERR_DISK_FULL,
            "File exceeds maximum transfer size",
        );
        return Ok(());
    }

    let mut reader = std::io::BufReader::new(file);
    stream_file(&socket, peer, &mut reader, 1, stats, shutdown)
}

/// Stream `reader` to `peer` as TFTP DATA packets, starting at block number
/// `start_block` and waiting for each block's ACK before sending the next.
///
/// Two RFC 1350 correctness properties this guarantees (CORE-023):
///
/// * **Block-number rollover.** The `u16` block counter is advanced with
///   [`u16::wrapping_add`], so it wraps `65535 → 0` instead of overflowing.
///   A transfer larger than `65535 × 512` (~32 MiB) therefore keeps
///   progressing rather than corrupting or stalling. `start_block` exists so
///   the wrap boundary can be exercised deterministically in tests without
///   moving 32 MiB over the socket; production always starts at block 1.
/// * **Terminating block for exact multiples.** The DATA packet is sent
///   *before* the "is this the last block?" check, so a file whose size is an
///   exact multiple of [`BLOCK_SIZE`] (including a zero-length file) still
///   emits an explicit final empty DATA block. Without it the client would
///   wait forever for EOF.
fn stream_file<R: Read>(
    socket: &UdpSocket,
    peer: SocketAddr,
    reader: &mut R,
    start_block: u16,
    stats: &AtomicServerStats,
    shutdown: &Arc<AtomicBool>,
) -> Result<()> {
    let mut block_num = start_block;

    loop {
        let mut block = [0u8; BLOCK_SIZE];
        let n = read_block(reader, &mut block).context("Cannot read file block")?;
        let block_data = &block[..n];

        // Send DATA packet.
        let mut packet = Vec::with_capacity(4 + block_data.len());
        packet.extend_from_slice(&OP_DATA.to_be_bytes());
        packet.extend_from_slice(&block_num.to_be_bytes());
        packet.extend_from_slice(block_data);

        stats
            .bytes_sent
            .fetch_add(block_data.len() as u64, Ordering::Relaxed);

        match wait_for_ack(socket, peer, &packet, block_num, MAX_RETRIES, shutdown)? {
            AckOutcome::Acked => {}
            // Server was stopped mid-transfer: abort promptly instead of
            // burning the remaining retry budget (up to ~25s). (#1145 / G1)
            AckOutcome::Aborted => return Ok(()),
        }

        // A short block (including the empty block for a zero-length file, and
        // the explicit empty terminator after an exact-multiple-of-512 file) is
        // the last one per RFC 1350.
        if n < BLOCK_SIZE {
            break;
        }

        // Wrap at u16::MAX per RFC 1350 so transfers > ~32 MiB do not stall.
        block_num = block_num.wrapping_add(1);
    }

    Ok(())
}

/// Fill `buf` from `reader`, returning the number of bytes read. Returns fewer
/// than `buf.len()` bytes only at end of file, coalescing short reads so a
/// non-final TFTP DATA block is always a full [`BLOCK_SIZE`].
fn read_block<R: Read>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Try to reserve one of the [`MAX_CONCURRENT_TRANSFERS`] in-flight slots.
///
/// Increments `in_flight` and returns `true` if a slot was free; otherwise undoes
/// the increment and returns `false`. Only the single-threaded accept loop calls
/// this, so the increment cannot overshoot the cap. The caller must decrement
/// `in_flight` when its transfer finishes.
fn try_reserve_slot(in_flight: &AtomicUsize, max: usize) -> bool {
    let prev = in_flight.fetch_add(1, Ordering::SeqCst);
    if prev >= max {
        in_flight.fetch_sub(1, Ordering::SeqCst);
        false
    } else {
        true
    }
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
            Ok((4, src)) => {
                // Enforce the transfer's TID (RFC 1350 §4, CORE-024): only the
                // peer that started the transfer may ACK it. A datagram from any
                // other source is a stray/spoofed packet — reply with ERROR
                // "unknown transfer ID" to that sender and ignore it, without
                // disturbing the in-flight transfer with the legitimate peer.
                if src != peer {
                    let _ = send_error(socket, src, ERR_UNKNOWN_TID, "Unknown transfer ID");
                    continue;
                }
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
    max_bytes: u64,
    stats: &AtomicServerStats,
    shutdown: &Arc<AtomicBool>,
) -> Result<()> {
    let path = safe_path(root, filename).ok_or_else(|| anyhow::anyhow!("Access denied"))?;

    let transfer_addr = format!("{bind_host}:0");
    let socket = UdpSocket::bind(&transfer_addr).context("Cannot bind transfer socket")?;
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .context("Cannot set timeout")?;

    // Stream each received DATA block straight to disk instead of buffering the
    // whole upload in memory, so an unauthenticated client cannot OOM the host
    // (CORE-021). The transfer is capped at `max_bytes`; a partial file is
    // discarded if the transfer aborts.
    let mut file =
        std::fs::File::create(&path).with_context(|| format!("Cannot write {}", path.display()))?;

    // Send initial ACK block 0.
    let ack0 = make_ack(0);
    socket
        .send_to(&ack0, peer)
        .context("Send initial ACK failed")?;

    let mut buf = [0u8; 516];
    let mut expected_block: u16 = 1;
    let mut total_written: u64 = 0;

    loop {
        // Abort promptly if the server was stopped mid-transfer. (#1145 / G1)
        if shutdown.load(Ordering::Relaxed) {
            discard_partial(&path);
            return Ok(());
        }

        let (len, src) = match socket.recv_from(&mut buf) {
            Ok(r) => r,
            // The read timeout lets us re-check the shutdown flag instead of
            // blocking indefinitely on a stalled client.
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(e) => {
                discard_partial(&path);
                return Err(anyhow::Error::new(e).context("Receive DATA failed"));
            }
        };
        // Enforce the transfer's TID (RFC 1350 §4, CORE-024): only the peer that
        // issued the WRQ may send DATA for it. A datagram from any other source
        // is a stray/spoofed packet — reply with ERROR "unknown transfer ID" to
        // that sender and drop it, so it can neither be written to disk nor
        // advance/corrupt the legitimate transfer's state.
        if src != peer {
            let _ = send_error(&socket, src, ERR_UNKNOWN_TID, "Unknown transfer ID");
            continue;
        }
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

        // Enforce the maximum transfer size before writing this block. Once the
        // cap would be exceeded, send a TFTP ERROR, discard the partial file and
        // stop — never keep buffering/writing (CORE-021).
        if total_written + data_slice.len() as u64 > max_bytes {
            let _ = send_error(
                &socket,
                peer,
                ERR_DISK_FULL,
                "Upload exceeds maximum transfer size",
            );
            discard_partial(&path);
            return Ok(());
        }

        file.write_all(data_slice)
            .with_context(|| format!("Cannot write {}", path.display()))?;
        total_written += data_slice.len() as u64;
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

    file.flush()
        .with_context(|| format!("Cannot flush {}", path.display()))?;

    Ok(())
}

/// Best-effort removal of a partially-written upload after an aborted WRQ, so a
/// cancelled or over-limit transfer never leaves a truncated file behind.
fn discard_partial(path: &Path) {
    let _ = std::fs::remove_file(path);
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

    // ── read_block ────────────────────────────────────────────────────────────

    #[test]
    fn read_block_fills_full_blocks_and_reports_eof() {
        use std::io::Cursor;
        // BLOCK_SIZE + a short trailing chunk exercises: a full block, a short
        // final block, then the empty (EOF) read.
        let mut cursor = Cursor::new(vec![7u8; BLOCK_SIZE + 100]);
        let mut buf = [0u8; BLOCK_SIZE];

        assert_eq!(read_block(&mut cursor, &mut buf).unwrap(), BLOCK_SIZE);
        assert_eq!(read_block(&mut cursor, &mut buf).unwrap(), 100);
        assert_eq!(read_block(&mut cursor, &mut buf).unwrap(), 0);
    }

    // ── Concurrency cap (CORE-022) ─────────────────────────────────────────────

    #[test]
    fn try_reserve_slot_enforces_cap() {
        // The concurrency cap must admit exactly `cap` in-flight transfers and
        // refuse the rest without inflating the counter, so an unauthenticated
        // flood cannot spawn threads without bound (CORE-022).
        let in_flight = AtomicUsize::new(0);
        let cap = 3;

        for i in 0..cap {
            assert!(
                try_reserve_slot(&in_flight, cap),
                "reservation {i} within the cap should succeed"
            );
        }

        // Cap reached: further reservations are refused and leave the count at
        // the cap (the failed increment is undone).
        assert!(!try_reserve_slot(&in_flight, cap));
        assert!(!try_reserve_slot(&in_flight, cap));
        assert_eq!(in_flight.load(Ordering::SeqCst), cap);

        // Releasing one slot lets exactly one more transfer in.
        in_flight.fetch_sub(1, Ordering::SeqCst);
        assert!(try_reserve_slot(&in_flight, cap));
        assert!(!try_reserve_slot(&in_flight, cap));
        assert_eq!(in_flight.load(Ordering::SeqCst), cap);
    }

    // ── WRQ streaming + size cap (CORE-021) ────────────────────────────────────

    /// Spawn `handle_wrq` for `filename` under `root` and act as the TFTP client:
    /// returns the bound client socket, the server's transfer address (learned
    /// from the source of ACK 0), and the server thread's join handle.
    fn start_wrq(
        root: PathBuf,
        filename: &str,
        max_bytes: u64,
    ) -> (UdpSocket, SocketAddr, std::thread::JoinHandle<Result<()>>) {
        let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .expect("set client timeout");
        let peer = client.local_addr().expect("client addr");

        let filename = filename.to_string();
        let stats = AtomicServerStats::new();
        let shutdown = Arc::new(AtomicBool::new(false));
        let handle = std::thread::spawn(move || {
            handle_wrq(
                &root,
                &filename,
                peer,
                "127.0.0.1",
                max_bytes,
                &stats,
                &shutdown,
            )
        });

        // The server opens with ACK block 0; its source address is the transfer
        // port the client must send DATA to.
        let mut buf = [0u8; 516];
        let (n, server_addr) = client.recv_from(&mut buf).expect("recv ACK 0");
        assert_eq!(&buf[..n], &make_ack(0), "expected initial ACK 0");
        (client, server_addr, handle)
    }

    fn data_packet(block: u16, payload: &[u8]) -> Vec<u8> {
        let mut pkt = Vec::with_capacity(4 + payload.len());
        pkt.extend_from_slice(&OP_DATA.to_be_bytes());
        pkt.extend_from_slice(&block.to_be_bytes());
        pkt.extend_from_slice(payload);
        pkt
    }

    #[test]
    fn wrq_normal_upload_is_streamed_to_disk() {
        // A normal (within-cap) upload must still be written correctly.
        let dir = tempfile::tempdir().expect("temp dir");
        let (client, server_addr, handle) = start_wrq(dir.path().to_path_buf(), "up.bin", 1024);

        let payload = b"hello world"; // < BLOCK_SIZE => single, final block
        client
            .send_to(&data_packet(1, payload), server_addr)
            .expect("send DATA 1");

        let mut buf = [0u8; 516];
        let (n, _) = client.recv_from(&mut buf).expect("recv ACK 1");
        assert_eq!(&buf[..n], &make_ack(1), "expected ACK for block 1");

        let result = handle.join().expect("server thread");
        assert!(result.is_ok(), "handle_wrq errored: {result:?}");

        let written = std::fs::read(dir.path().join("up.bin")).expect("read uploaded file");
        assert_eq!(written, payload, "uploaded contents should match");
    }

    #[test]
    fn wrq_oversize_upload_is_aborted_and_discarded() {
        // Regression for CORE-021: an upload exceeding the cap must be aborted
        // with a TFTP ERROR and must NOT be buffered/written to disk.
        let dir = tempfile::tempdir().expect("temp dir");
        let (client, server_addr, handle) = start_wrq(dir.path().to_path_buf(), "big.bin", 10);

        // A single 512-byte block already exceeds the 10-byte cap.
        let payload = [0xABu8; BLOCK_SIZE];
        client
            .send_to(&data_packet(1, &payload), server_addr)
            .expect("send oversized DATA 1");

        let mut buf = [0u8; 516];
        let (n, _) = client.recv_from(&mut buf).expect("recv server reply");
        assert!(n >= 2, "reply too short");
        let op = u16::from_be_bytes([buf[0], buf[1]]);
        assert_eq!(
            op, OP_ERROR,
            "oversize upload should be rejected with ERROR"
        );

        let result = handle.join().expect("server thread");
        assert!(result.is_ok(), "handle_wrq errored: {result:?}");

        // The partial file must have been discarded, not left on disk.
        assert!(
            !dir.path().join("big.bin").exists(),
            "oversize upload must not leave a file behind"
        );
    }

    // ── RRQ streaming + size cap (CORE-021, read side) ─────────────────────────

    #[test]
    fn rrq_normal_download_is_streamed() {
        // A within-cap download must still stream correctly.
        let dir = tempfile::tempdir().expect("temp dir");
        let content = b"read me";
        std::fs::write(dir.path().join("dl.bin"), content).expect("write served file");

        let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .expect("set client timeout");
        let peer = client.local_addr().expect("client addr");

        let root = dir.path().to_path_buf();
        let stats = AtomicServerStats::new();
        let shutdown = Arc::new(AtomicBool::new(false));
        let handle = std::thread::spawn(move || {
            handle_rrq(&root, "dl.bin", peer, "127.0.0.1", 1024, &stats, &shutdown)
        });

        let mut buf = [0u8; 516];
        let (n, server_addr) = client.recv_from(&mut buf).expect("recv DATA 1");
        assert_eq!(u16::from_be_bytes([buf[0], buf[1]]), OP_DATA);
        assert_eq!(u16::from_be_bytes([buf[2], buf[3]]), 1);
        assert_eq!(&buf[4..n], content, "downloaded block should match file");

        // ACK the final block so the server completes.
        client
            .send_to(&make_ack(1), server_addr)
            .expect("send ACK 1");

        let result = handle.join().expect("server thread");
        assert!(result.is_ok(), "handle_rrq errored: {result:?}");
    }

    #[test]
    fn rrq_oversize_file_is_rejected() {
        // A served file larger than the cap must be rejected up front with a
        // TFTP ERROR rather than read into memory (CORE-021, read side).
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("huge.bin"), vec![0u8; 100]).expect("write served file");

        let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .expect("set client timeout");
        let peer = client.local_addr().expect("client addr");

        let root = dir.path().to_path_buf();
        let stats = AtomicServerStats::new();
        let shutdown = Arc::new(AtomicBool::new(false));
        let handle = std::thread::spawn(move || {
            handle_rrq(&root, "huge.bin", peer, "127.0.0.1", 10, &stats, &shutdown)
        });

        let mut buf = [0u8; 516];
        let (n, _) = client.recv_from(&mut buf).expect("recv server reply");
        assert!(n >= 2, "reply too short");
        assert_eq!(
            u16::from_be_bytes([buf[0], buf[1]]),
            OP_ERROR,
            "oversize download should be rejected with ERROR"
        );

        let result = handle.join().expect("server thread");
        assert!(result.is_ok(), "handle_rrq errored: {result:?}");
    }
}
