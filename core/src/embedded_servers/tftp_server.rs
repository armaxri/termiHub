//! Minimal TFTP server (RFC 1350).
//!
//! Handles RRQ (read) and WRQ (write) requests over UDP. Each transfer is served
//! on its own newly bound ephemeral port.
//!
//! The server runs on a single-threaded tokio runtime: the accept loop and every
//! in-flight transfer are async tasks whose socket receives are `select!`ed
//! against the [`ShutdownSignal`]. Stopping the server therefore wakes all of them
//! at once — there is no fixed read-timeout poll re-checking a flag (WA-RS-001,
//! #2782). The only remaining timer is the RFC 1350 retransmit timeout while an
//! RRQ waits for an ACK (and a WRQ waits for the next DATA block), which is
//! protocol behaviour, not shutdown polling.
//!
//! Every RRQ/WRQ — including refused ones — is recorded in the server's access
//! log (PROD-034) and listed as a current transfer while in flight.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::UdpSocket;
use tokio::task::JoinSet;

use super::activity::{AccessRecord, TransferGuard};
use super::config::{AtomicServerStats, EmbeddedServerConfig};
use super::service::BindSignal;
use super::shutdown::ShutdownSignal;

// ─── TFTP opcodes (RFC 1350 §5) ──────────────────────────────────────────────

const OP_RRQ: u16 = 1;
const OP_WRQ: u16 = 2;
const OP_DATA: u16 = 3;
const OP_ACK: u16 = 4;
const OP_ERROR: u16 = 5;

const BLOCK_SIZE: usize = 512;

/// Maximum number of DATA (re)transmissions before an RRQ block is abandoned.
const MAX_RETRIES: u32 = 5;

/// How long an RRQ waits for the ACK to one DATA block (and a WRQ for the next
/// DATA block) before retransmitting (RFC 1350 retransmit timeout). Shutdown
/// does not wait on this: every receive is `select!`ed against the
/// [`ShutdownSignal`] and aborts the instant it fires.
const ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// Default ceiling on the size of a single TFTP transfer when the server config
/// does not specify one. TFTP is unauthenticated, so an uncapped WRQ lets any
/// client stream an arbitrarily large file and OOM/fill the host (CORE-021);
/// this default bounds a single transfer to 100 MiB, comfortably above typical
/// firmware/config payloads while still preventing an unbounded write.
const DEFAULT_MAX_TRANSFER_BYTES: u64 = 100 * 1024 * 1024;

/// Maximum number of transfers served concurrently. Each accepted RRQ/WRQ runs
/// as its own task with its own socket; without a cap an unauthenticated client
/// can flood the server with datagrams and open transfers without bound
/// (CORE-022). Requests arriving while this many transfers are already in flight
/// are rejected with a TFTP ERROR rather than starting another transfer.
const MAX_CONCURRENT_TRANSFERS: usize = 64;

// TFTP error codes (RFC 1350 §5).
const ERR_NOT_DEFINED: u16 = 0;
const ERR_ACCESS: u16 = 2;
const ERR_DISK_FULL: u16 = 3;
const ERR_ILLEGAL_OP: u16 = 4;
const ERR_UNKNOWN_TID: u16 = 5;

/// How a single RRQ/WRQ transfer ended (other than with an I/O error).
#[derive(Debug, Clone, PartialEq, Eq)]
enum TransferEnd {
    /// The whole file was transferred.
    Completed,
    /// The server was stopped mid-transfer.
    Aborted,
    /// The request was refused before any data moved (bad path).
    Denied(&'static str),
    /// The transfer was refused or cut off by the size cap.
    Rejected(&'static str),
    /// The client went silent past the retransmit budget.
    TimedOut,
}

/// Map a transfer's result onto its access-log record.
fn transfer_record(kind: &str, result: &Result<TransferEnd>) -> AccessRecord {
    match result {
        Ok(TransferEnd::Completed) => AccessRecord::new(kind, "ok", true),
        Ok(TransferEnd::Aborted) => {
            AccessRecord::new(kind, "aborted", false).detail("server stopped")
        }
        Ok(TransferEnd::Denied(why)) => AccessRecord::new(kind, "denied", false).detail(*why),
        Ok(TransferEnd::Rejected(why)) => AccessRecord::new(kind, "rejected", false).detail(*why),
        Ok(TransferEnd::TimedOut) => {
            AccessRecord::new(kind, "timeout", false).detail("client stopped responding")
        }
        Err(e) => AccessRecord::new(kind, "error", false).detail(e.to_string()),
    }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/// Start the TFTP server in the current thread, blocking until `shutdown` fires.
///
/// Internally this creates a single-threaded tokio runtime so the event-driven
/// server can run inside the OS thread the `EmbeddedServerManager` already
/// spawned. `ready` is signalled exactly once as soon as the listening UDP socket
/// is bound (or if binding fails), so the manager only reports `Running` after
/// the bind is confirmed (GAP G3, #1145).
pub fn start_tftp_server(
    config: &EmbeddedServerConfig,
    shutdown: ShutdownSignal,
    stats: Arc<AtomicServerStats>,
    ready: BindSignal,
) -> Result<()> {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("Failed to build tokio runtime for TFTP server")
    {
        Ok(rt) => rt,
        Err(e) => {
            ready.fail(&e.to_string());
            return Err(e);
        }
    };

    rt.block_on(run_tftp_server(config, shutdown, stats, ready))
}

async fn run_tftp_server(
    config: &EmbeddedServerConfig,
    shutdown: ShutdownSignal,
    stats: Arc<AtomicServerStats>,
    ready: BindSignal,
) -> Result<()> {
    let addr = format!("{}:{}", config.bind_host, config.port);
    let socket = match UdpSocket::bind(&addr)
        .await
        .with_context(|| format!("Failed to bind TFTP server to {addr}"))
    {
        Ok(socket) => socket,
        Err(e) => {
            ready.fail(&e.to_string());
            return Err(e);
        }
    };

    // Bind confirmed — tell the manager it is safe to report Running.
    ready.confirm();

    let root = PathBuf::from(&config.root_directory);
    let read_only = config.read_only;
    let bind_host = config.bind_host.clone();
    let max_bytes = config
        .max_transfer_bytes
        .unwrap_or(DEFAULT_MAX_TRANSFER_BYTES);

    // In-flight transfer counter, used to cap concurrency (CORE-022). Only the
    // accept loop increments it (single task), so the reserve check below cannot
    // overshoot the cap; each transfer releases its slot when it finishes.
    let in_flight = Arc::new(AtomicUsize::new(0));
    let mut transfers: JoinSet<()> = JoinSet::new();

    tracing::info!(addr, "TFTP server listening");

    let mut buf = [0u8; 516]; // 4-byte header + 512-byte data

    loop {
        let (len, peer) = tokio::select! {
            // Event-driven shutdown: wakes the instant the signal fires.
            _ = shutdown.wait() => break,
            // Reap finished transfers so the set does not grow without bound.
            Some(_) = transfers.join_next(), if !transfers.is_empty() => continue,
            // Windows ICMP resets are skipped inside `recv_skipping_resets`, so a
            // client that went away cannot tear the server down.
            received = recv_skipping_resets(&socket, &mut buf) => match received {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!("TFTP recv error: {e}");
                    break;
                }
            },
        };

        if len < 2 {
            continue;
        }

        let opcode = u16::from_be_bytes([buf[0], buf[1]]);
        let payload = &buf[2..len];

        match opcode {
            OP_RRQ | OP_WRQ => {
                let is_write = opcode == OP_WRQ;
                let kind = if is_write { "WRQ" } else { "RRQ" };
                let Some((filename, _mode)) = parse_request(payload) else {
                    continue;
                };
                let refuse = |status: &str, detail: &str| {
                    stats.activity.record(
                        AccessRecord::new(kind, status, false)
                            .client(peer.ip())
                            .path(filename.clone())
                            .detail(detail),
                    );
                };
                if is_write && read_only {
                    refuse("denied", "server is read-only");
                    let _ = send_error(&socket, peer, ERR_ACCESS, "Server is read-only").await;
                    continue;
                }
                let Some(slot) = TransferSlot::reserve(&in_flight, &stats) else {
                    refuse("busy", "too many concurrent transfers");
                    let _ = send_error(
                        &socket,
                        peer,
                        ERR_NOT_DEFINED,
                        "Server busy: too many concurrent transfers",
                    )
                    .await;
                    continue;
                };

                let root = root.clone();
                let bind_host = bind_host.clone();
                let stats = Arc::clone(&stats);
                let shutdown = shutdown.clone();
                transfers.spawn(async move {
                    // Held for the transfer's lifetime; releases the slot and the
                    // active-connection count on every exit path.
                    let _slot = slot;
                    let started = Instant::now();
                    let progress =
                        stats
                            .activity
                            .begin_transfer(kind, Some(peer.ip()), Some(&filename));
                    let result = if is_write {
                        handle_wrq(
                            &root, &filename, peer, &bind_host, max_bytes, &stats, &progress,
                            &shutdown,
                        )
                        .await
                    } else {
                        handle_rrq(
                            &root, &filename, peer, &bind_host, max_bytes, &stats, &progress,
                            &shutdown,
                        )
                        .await
                    };
                    if let Err(e) = &result {
                        tracing::debug!(%peer, "TFTP {kind} error: {e}");
                    }
                    stats.activity.record(
                        transfer_record(kind, &result)
                            .client(peer.ip())
                            .path(filename)
                            .bytes(progress.bytes())
                            .elapsed_since(started),
                    );
                });
            }
            _ => {
                let _ = send_error(&socket, peer, ERR_ILLEGAL_OP, "Unexpected opcode").await;
            }
        }
    }

    // Let in-flight transfers observe the signal and unwind on their own — they
    // wake at once and, for an upload, discard the partial file — instead of
    // being cancelled mid-write when the runtime is dropped.
    while transfers.join_next().await.is_some() {}

    Ok(())
}

/// One reserved concurrent-transfer slot (CORE-022).
///
/// Reserving bumps the in-flight and connection counters; dropping the guard
/// releases the slot and the active-connection count, so a transfer that errors,
/// panics or is cancelled can never leak a slot.
struct TransferSlot {
    in_flight: Arc<AtomicUsize>,
    stats: Arc<AtomicServerStats>,
}

impl TransferSlot {
    fn reserve(in_flight: &Arc<AtomicUsize>, stats: &Arc<AtomicServerStats>) -> Option<Self> {
        if !try_reserve_slot(in_flight, MAX_CONCURRENT_TRANSFERS) {
            return None;
        }
        stats.active_connections.fetch_add(1, Ordering::Relaxed);
        stats.total_connections.fetch_add(1, Ordering::Relaxed);
        Some(Self {
            in_flight: Arc::clone(in_flight),
            stats: Arc::clone(stats),
        })
    }
}

impl Drop for TransferSlot {
    fn drop(&mut self) {
        self.stats
            .active_connections
            .fetch_sub(1, Ordering::Relaxed);
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

// ─── RRQ handler (server → client) ───────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn handle_rrq(
    root: &Path,
    filename: &str,
    peer: SocketAddr,
    bind_host: &str,
    max_bytes: u64,
    stats: &AtomicServerStats,
    progress: &TransferGuard,
    shutdown: &ShutdownSignal,
) -> Result<TransferEnd> {
    let Some(path) = safe_path(root, filename) else {
        return Ok(TransferEnd::Denied("path outside the served root"));
    };

    // Open the file and stream it block-by-block rather than reading the whole
    // thing into memory, so a large served file cannot balloon host memory
    // (CORE-021, read side).
    let file = tokio::fs::File::open(&path)
        .await
        .with_context(|| format!("Cannot read {}", path.display()))?;

    // Bind an ephemeral port for this transfer.
    let transfer_addr = format!("{bind_host}:0");
    let socket = UdpSocket::bind(&transfer_addr)
        .await
        .context("Cannot bind transfer socket")?;

    // Reject oversized files up front so we never start streaming something that
    // would exceed the configured cap.
    let file_len = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    if file_len > max_bytes {
        let _ = send_error(
            &socket,
            peer,
            ERR_DISK_FULL,
            "File exceeds maximum transfer size",
        )
        .await;
        return Ok(TransferEnd::Rejected("file exceeds maximum transfer size"));
    }

    let mut reader = tokio::io::BufReader::new(file);
    stream_file(
        &socket,
        peer,
        &mut reader,
        1,
        ACK_TIMEOUT,
        stats,
        progress,
        shutdown,
    )
    .await
}

/// Stream `reader` to `peer` as TFTP DATA packets, starting at block number
/// `start_block` and waiting (up to `ack_timeout` per attempt) for each block's
/// ACK before sending the next.
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
#[allow(clippy::too_many_arguments)]
async fn stream_file<R: AsyncRead + Unpin>(
    socket: &UdpSocket,
    peer: SocketAddr,
    reader: &mut R,
    start_block: u16,
    ack_timeout: Duration,
    stats: &AtomicServerStats,
    progress: &TransferGuard,
    shutdown: &ShutdownSignal,
) -> Result<TransferEnd> {
    let mut block_num = start_block;

    loop {
        let mut block = [0u8; BLOCK_SIZE];
        let n = read_block(reader, &mut block)
            .await
            .context("Cannot read file block")?;
        let block_data = &block[..n];

        // Send DATA packet.
        let mut packet = Vec::with_capacity(4 + block_data.len());
        packet.extend_from_slice(&OP_DATA.to_be_bytes());
        packet.extend_from_slice(&block_num.to_be_bytes());
        packet.extend_from_slice(block_data);

        stats
            .bytes_sent
            .fetch_add(block_data.len() as u64, Ordering::Relaxed);
        progress.add_bytes(block_data.len() as u64);

        match wait_for_ack(
            socket,
            peer,
            &packet,
            block_num,
            MAX_RETRIES,
            ack_timeout,
            shutdown,
        )
        .await?
        {
            AckOutcome::Acked => {}
            // Server was stopped mid-transfer: abort at once instead of burning
            // the remaining retry budget (up to ~25s). (#1145 / G1, #2782)
            AckOutcome::Aborted => return Ok(TransferEnd::Aborted),
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

    Ok(TransferEnd::Completed)
}

/// Fill `buf` from `reader`, returning the number of bytes read. Returns fewer
/// than `buf.len()` bytes only at end of file, coalescing short reads so a
/// non-final TFTP DATA block is always a full [`BLOCK_SIZE`].
async fn read_block<R: AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut [u8],
) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]).await {
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
/// the increment and returns `false`. Only the single accept-loop task calls
/// this, so the increment cannot overshoot the cap. The caller must decrement
/// `in_flight` when its transfer finishes (see [`TransferSlot`]).
fn try_reserve_slot(in_flight: &AtomicUsize, max: usize) -> bool {
    let prev = in_flight.fetch_add(1, Ordering::SeqCst);
    if prev >= max {
        in_flight.fetch_sub(1, Ordering::SeqCst);
        false
    } else {
        true
    }
}

/// Whether a UDP receive error is transient and the socket is still usable.
///
/// On Windows, when a datagram this socket sent is answered with an ICMP "port
/// unreachable" (e.g. DATA/ERROR sent to a client that already went away, or a
/// stray reply to a spoofed source), the *next* `recv_from` fails with
/// `WSAECONNRESET` (os error 10054, [`std::io::ErrorKind::ConnectionReset`]). It
/// says nothing about the datagram being waited for — UDP has no connection to
/// reset — so the receive should simply be retried. Other platforms never report
/// it on an unconnected UDP socket, so treating it as transient is harmless.
fn is_transient_recv_error(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::ConnectionReset
}

/// `recv_from` that retries past transient errors (see
/// [`is_transient_recv_error`]) and returns the first real datagram or the first
/// fatal error.
///
/// Cancel-safe: it holds no state between iterations and `UdpSocket::recv_from`
/// is itself cancel-safe, so it can be raced in `select!` / `timeout` freely.
/// Callers bound it with their own deadline, so a peer that only ever triggers
/// resets still times out.
async fn recv_skipping_resets(
    socket: &UdpSocket,
    buf: &mut [u8],
) -> std::io::Result<(usize, SocketAddr)> {
    loop {
        match socket.recv_from(buf).await {
            Err(e) if is_transient_recv_error(&e) => {
                tracing::debug!("TFTP: ignoring transient UDP receive error: {e}");
            }
            other => return other,
        }
    }
}

/// Result of waiting for the ACK to a single RRQ DATA block.
#[derive(Debug)]
enum AckOutcome {
    /// The expected ACK arrived.
    Acked,
    /// The shutdown signal fired; the transfer should stop.
    Aborted,
}

/// (Re)send `packet` to `peer` and wait for the ACK for `block_num`,
/// retransmitting after each `ack_timeout` up to `max_retries` times.
///
/// Each wait is `select!`ed against `shutdown`, so a stopped server aborts an
/// in-flight transfer the instant the signal fires rather than after the current
/// retransmit timeout (#1145 / G1, #2782). Returns [`AckOutcome::Aborted`] on
/// shutdown, [`AckOutcome::Acked`] on success, or an error if the retry budget is
/// exhausted.
async fn wait_for_ack(
    socket: &UdpSocket,
    peer: SocketAddr,
    packet: &[u8],
    block_num: u16,
    max_retries: u32,
    ack_timeout: Duration,
    shutdown: &ShutdownSignal,
) -> Result<AckOutcome> {
    let mut attempts = 0;
    loop {
        if shutdown.is_triggered() {
            return Ok(AckOutcome::Aborted);
        }

        socket
            .send_to(packet, peer)
            .await
            .context("Send DATA failed")?;

        // Wait for ACK, or for shutdown — whichever comes first.
        let mut ack_buf = [0u8; 4];
        let received = tokio::select! {
            _ = shutdown.wait() => return Ok(AckOutcome::Aborted),
            // Transient Windows ICMP resets are retried inside the *same*
            // timeout, so they neither abort the transfer nor extend the
            // deadline: a client that is really gone still times out.
            received = tokio::time::timeout(ack_timeout, recv_skipping_resets(socket, &mut ack_buf)) => received,
        };
        match received {
            Ok(Ok((4, src))) => {
                // Enforce the transfer's TID (RFC 1350 §4, CORE-024): only the
                // peer that started the transfer may ACK it. A datagram from any
                // other source is a stray/spoofed packet — reply with ERROR
                // "unknown transfer ID" to that sender and ignore it, without
                // disturbing the in-flight transfer with the legitimate peer.
                if src != peer {
                    let _ = send_error(socket, src, ERR_UNKNOWN_TID, "Unknown transfer ID").await;
                    continue;
                }
                let ack_op = u16::from_be_bytes([ack_buf[0], ack_buf[1]]);
                let ack_block = u16::from_be_bytes([ack_buf[2], ack_buf[3]]);
                if ack_op == OP_ACK && ack_block == block_num {
                    return Ok(AckOutcome::Acked);
                }
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(e.into()),
            // Retransmit timeout elapsed with no ACK.
            Err(_elapsed) => {
                attempts += 1;
                if attempts >= max_retries {
                    return Err(anyhow::anyhow!("ACK timeout after {attempts} retries"));
                }
            }
        }
    }
}

// ─── WRQ handler (client → server) ───────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn handle_wrq(
    root: &Path,
    filename: &str,
    peer: SocketAddr,
    bind_host: &str,
    max_bytes: u64,
    stats: &AtomicServerStats,
    progress: &TransferGuard,
    shutdown: &ShutdownSignal,
) -> Result<TransferEnd> {
    let Some(path) = safe_path(root, filename) else {
        return Ok(TransferEnd::Denied("path outside the served root"));
    };

    let transfer_addr = format!("{bind_host}:0");
    let socket = UdpSocket::bind(&transfer_addr)
        .await
        .context("Cannot bind transfer socket")?;

    // Stream each received DATA block straight to disk instead of buffering the
    // whole upload in memory, so an unauthenticated client cannot OOM the host
    // (CORE-021). The transfer is capped at `max_bytes`; a partial file is
    // discarded if the transfer aborts.
    let mut file = tokio::fs::File::create(&path)
        .await
        .with_context(|| format!("Cannot write {}", path.display()))?;

    // Send initial ACK block 0.
    let mut last_ack = make_ack(0);
    socket
        .send_to(&last_ack, peer)
        .await
        .context("Send initial ACK failed")?;

    let mut buf = [0u8; 516];
    let mut expected_block: u16 = 1;
    let mut total_written: u64 = 0;
    // Retransmit budget for a silent client (#3306): the deadline only moves on
    // real progress from the transfer's peer, so neither stray datagrams nor
    // duplicate blocks can keep a stalled upload (and its slot) alive forever.
    let mut deadline = tokio::time::Instant::now() + ACK_TIMEOUT;
    let mut retries: u32 = 0;

    loop {
        let received = tokio::select! {
            // Abort the instant the server is stopped mid-transfer, even while
            // parked on a stalled client. (#1145 / G1, #2782)
            _ = shutdown.wait() => {
                discard_partial(file, &path).await;
                return Ok(TransferEnd::Aborted);
            }
            // Transient Windows ICMP resets are skipped, not fatal.
            received = tokio::time::timeout_at(deadline, recv_skipping_resets(&socket, &mut buf)) => received,
        };
        let (len, src) = match received {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                discard_partial(file, &path).await;
                return Err(anyhow::Error::new(e).context("Receive DATA failed"));
            }
            // No DATA within the retransmit timeout: re-send the last ACK, and
            // give up once the retry budget is spent (RFC 1350, #3306).
            Err(_elapsed) => {
                retries += 1;
                if retries >= MAX_RETRIES {
                    discard_partial(file, &path).await;
                    return Ok(TransferEnd::TimedOut);
                }
                let _ = socket.send_to(&last_ack, peer).await;
                deadline = tokio::time::Instant::now() + ACK_TIMEOUT;
                continue;
            }
        };
        // Enforce the transfer's TID (RFC 1350 §4, CORE-024): only the peer that
        // issued the WRQ may send DATA for it. A datagram from any other source
        // is a stray/spoofed packet — reply with ERROR "unknown transfer ID" to
        // that sender and drop it, so it can neither be written to disk nor
        // advance/corrupt the legitimate transfer's state.
        if src != peer {
            let _ = send_error(&socket, src, ERR_UNKNOWN_TID, "Unknown transfer ID").await;
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
            let _ = socket.send_to(&last_ack, peer).await;
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
            )
            .await;
            discard_partial(file, &path).await;
            return Ok(TransferEnd::Rejected(
                "upload exceeds maximum transfer size",
            ));
        }

        file.write_all(data_slice)
            .await
            .with_context(|| format!("Cannot write {}", path.display()))?;
        total_written += data_slice.len() as u64;
        stats
            .bytes_received
            .fetch_add(data_slice.len() as u64, Ordering::Relaxed);
        progress.add_bytes(data_slice.len() as u64);

        last_ack = make_ack(block_num);
        socket
            .send_to(&last_ack, peer)
            .await
            .context("Send ACK failed")?;

        expected_block = expected_block.wrapping_add(1);
        retries = 0;
        deadline = tokio::time::Instant::now() + ACK_TIMEOUT;

        // Last block is < 512 bytes.
        if data_slice.len() < BLOCK_SIZE {
            break;
        }
    }

    // `tokio::fs::File` completes writes in the background; flushing waits for
    // them so the upload is fully on disk before the transfer reports success.
    file.flush()
        .await
        .with_context(|| format!("Cannot flush {}", path.display()))?;

    Ok(TransferEnd::Completed)
}

/// Best-effort removal of a partially-written upload after an aborted WRQ, so a
/// cancelled or over-limit transfer never leaves a truncated file behind.
///
/// Settles any in-flight background write and closes the handle *before*
/// unlinking, so the removal never races a pending write (and on Windows is not
/// deferred behind an open handle).
async fn discard_partial(mut file: tokio::fs::File, path: &Path) {
    let _ = file.flush().await;
    drop(file);
    let _ = tokio::fs::remove_file(path).await;
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
async fn send_error(
    socket: &UdpSocket,
    peer: SocketAddr,
    code: u16,
    msg: &str,
) -> std::io::Result<()> {
    let mut packet = Vec::with_capacity(5 + msg.len());
    packet.extend_from_slice(&OP_ERROR.to_be_bytes());
    packet.extend_from_slice(&code.to_be_bytes());
    packet.extend_from_slice(msg.as_bytes());
    packet.push(0);
    socket.send_to(&packet, peer).await?;
    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    // The test *clients* are plain blocking sockets; the server side runs on its
    // own runtime thread (see `on_runtime`), exactly as in production.
    use std::net::UdpSocket as StdUdpSocket;

    /// Run `fut` to completion on a fresh current-thread runtime on its own OS
    /// thread, so a test can drive the async server with blocking client sockets.
    fn on_runtime<F>(fut: F) -> std::thread::JoinHandle<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build test runtime")
                .block_on(fut)
        })
    }

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

    /// Short retransmit timeout for the ACK-wait tests (no peer ever replies).
    const TEST_ACK_TIMEOUT: Duration = Duration::from_millis(50);

    async fn test_socket() -> UdpSocket {
        UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("bind test socket")
    }

    /// A loopback address with (almost certainly) no listener: bind an ephemeral
    /// port and release it. DATA sent there is never ACKed, and on Windows it
    /// draws an ICMP "port unreachable" that surfaces as `WSAECONNRESET` on the
    /// transfer socket's next receive — so the ACK-wait tests below also prove
    /// that reset is tolerated rather than aborting the transfer.
    fn closed_peer() -> SocketAddr {
        let probe = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind probe socket");
        probe.local_addr().expect("probe local addr")
    }

    #[test]
    fn connection_reset_is_a_transient_recv_error() {
        use std::io::{Error, ErrorKind};
        // The Windows ICMP-unreachable surfacing (os error 10054) must be
        // retried, not treated as a dead socket.
        assert!(is_transient_recv_error(&Error::from(
            ErrorKind::ConnectionReset
        )));
        // Real failures stay fatal.
        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::NotConnected,
            ErrorKind::InvalidInput,
            ErrorKind::Other,
        ] {
            assert!(
                !is_transient_recv_error(&Error::from(kind)),
                "{kind:?} must not be treated as transient"
            );
        }
    }

    #[tokio::test]
    async fn wait_for_ack_aborts_immediately_when_shutdown_set() {
        // Regression for #1145 (G1): an in-flight transfer must abort promptly
        // when the server is stopped, instead of burning its full retry budget.
        let socket = test_socket().await;
        let peer = closed_peer();
        let shutdown = ShutdownSignal::new();
        shutdown.trigger();

        let start = std::time::Instant::now();
        let outcome = wait_for_ack(
            &socket,
            peer,
            &[0, 3, 0, 1],
            1,
            MAX_RETRIES,
            TEST_ACK_TIMEOUT,
            &shutdown,
        )
        .await;
        let elapsed = start.elapsed();

        assert!(
            matches!(outcome, Ok(AckOutcome::Aborted)),
            "expected Aborted, got {outcome:?}"
        );
        // Must not have waited even a single full 50ms timeout, let alone the
        // 5 × 5s budget of the real server.
        assert!(
            elapsed < Duration::from_millis(40),
            "aborted too slowly: {elapsed:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn wait_for_ack_wakes_on_shutdown_mid_wait_without_a_timer_tick() {
        // #2782: a transfer parked waiting for an ACK must abort the instant the
        // signal fires — not when its retransmit timeout next elapses. Under a
        // paused clock the (huge) timeout can only fire if virtual time advances,
        // so an unchanged clock proves the wake was event-driven.
        let socket = test_socket().await;
        let peer = closed_peer();
        let shutdown = ShutdownSignal::new();

        let wait = wait_for_ack(
            &socket,
            peer,
            &[0, 3, 0, 1],
            1,
            MAX_RETRIES,
            Duration::from_secs(3600),
            &shutdown,
        );
        tokio::pin!(wait);

        // Drive the wait until it has sent DATA and parked on the receive.
        for _ in 0..50 {
            tokio::select! {
                biased;
                outcome = &mut wait => panic!("wait ended before shutdown: {outcome:?}"),
                _ = tokio::task::yield_now() => {}
            }
        }

        let start = tokio::time::Instant::now();
        shutdown.trigger();
        let outcome = wait.await;
        assert!(
            matches!(outcome, Ok(AckOutcome::Aborted)),
            "expected Aborted, got {outcome:?}"
        );
        assert_eq!(
            tokio::time::Instant::now() - start,
            Duration::ZERO,
            "shutdown must wake the ACK wait directly, not via its timeout"
        );
    }

    #[tokio::test]
    async fn wait_for_ack_times_out_after_retry_budget_without_shutdown() {
        // Without shutdown, the loop must exhaust its retry budget (no peer ever
        // ACKs), proving the shutdown check is what changes the outcome above.
        let socket = test_socket().await;
        let peer = closed_peer();
        let shutdown = ShutdownSignal::new();

        let outcome = wait_for_ack(
            &socket,
            peer,
            &[0, 3, 0, 1],
            1,
            2,
            TEST_ACK_TIMEOUT,
            &shutdown,
        )
        .await;
        assert!(outcome.is_err(), "expected timeout error, got {outcome:?}");
    }

    // ── read_block ────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn read_block_fills_full_blocks_and_reports_eof() {
        use std::io::Cursor;
        // BLOCK_SIZE + a short trailing chunk exercises: a full block, a short
        // final block, then the empty (EOF) read.
        let mut cursor = Cursor::new(vec![7u8; BLOCK_SIZE + 100]);
        let mut buf = [0u8; BLOCK_SIZE];

        assert_eq!(read_block(&mut cursor, &mut buf).await.unwrap(), BLOCK_SIZE);
        assert_eq!(read_block(&mut cursor, &mut buf).await.unwrap(), 100);
        assert_eq!(read_block(&mut cursor, &mut buf).await.unwrap(), 0);
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
    /// from the source of ACK 0), the transfer's shutdown signal, and the server
    /// thread's join handle.
    fn start_wrq(
        root: PathBuf,
        filename: &str,
        max_bytes: u64,
    ) -> (
        StdUdpSocket,
        SocketAddr,
        ShutdownSignal,
        std::thread::JoinHandle<Result<TransferEnd>>,
    ) {
        let client = StdUdpSocket::bind("127.0.0.1:0").expect("bind client");
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set client timeout");
        let peer = client.local_addr().expect("client addr");

        let filename = filename.to_string();
        let stats = AtomicServerStats::new();
        let shutdown = ShutdownSignal::new();
        let server_shutdown = shutdown.clone();
        let handle = on_runtime(async move {
            let progress = stats.activity.begin_transfer("WRQ", None, None);
            handle_wrq(
                &root,
                &filename,
                peer,
                "127.0.0.1",
                max_bytes,
                &stats,
                &progress,
                &server_shutdown,
            )
            .await
        });

        // The server opens with ACK block 0; its source address is the transfer
        // port the client must send DATA to.
        let mut buf = [0u8; 516];
        let (n, server_addr) = client.recv_from(&mut buf).expect("recv ACK 0");
        assert_eq!(&buf[..n], &make_ack(0), "expected initial ACK 0");
        (client, server_addr, shutdown, handle)
    }

    /// Bind a blocking client socket for an RRQ test and return it with its
    /// address (the transfer's peer).
    fn rrq_client() -> (StdUdpSocket, SocketAddr) {
        let client = StdUdpSocket::bind("127.0.0.1:0").expect("bind client");
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set client timeout");
        let peer = client.local_addr().expect("client addr");
        (client, peer)
    }

    /// Spawn `handle_rrq` for `filename` under `root` towards `peer`, returning
    /// the transfer's shutdown signal and the server thread's join handle.
    fn start_rrq(
        root: PathBuf,
        filename: &str,
        peer: SocketAddr,
        max_bytes: u64,
    ) -> (ShutdownSignal, std::thread::JoinHandle<Result<TransferEnd>>) {
        let filename = filename.to_string();
        let stats = AtomicServerStats::new();
        let shutdown = ShutdownSignal::new();
        let server_shutdown = shutdown.clone();
        let handle = on_runtime(async move {
            let progress = stats.activity.begin_transfer("RRQ", None, None);
            handle_rrq(
                &root,
                &filename,
                peer,
                "127.0.0.1",
                max_bytes,
                &stats,
                &progress,
                &server_shutdown,
            )
            .await
        });
        (shutdown, handle)
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
        let (client, server_addr, _shutdown, handle) =
            start_wrq(dir.path().to_path_buf(), "up.bin", 1024);

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
        let (client, server_addr, _shutdown, handle) =
            start_wrq(dir.path().to_path_buf(), "big.bin", 10);

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

        let (client, peer) = rrq_client();
        let (_shutdown, handle) = start_rrq(dir.path().to_path_buf(), "dl.bin", peer, 1024);

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

        let (client, peer) = rrq_client();
        let (_shutdown, handle) = start_rrq(dir.path().to_path_buf(), "huge.bin", peer, 10);

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

    // ── CORE-023: block-number rollover + exact-multiple EOF ───────────────────

    #[test]
    fn rrq_exact_multiple_file_sends_empty_terminating_block() {
        // Regression for CORE-023: a file whose size is an exact multiple of
        // BLOCK_SIZE must be followed by an explicit empty DATA block so the
        // client sees EOF instead of waiting forever.
        let dir = tempfile::tempdir().expect("temp dir");
        let content = vec![0x5Au8; BLOCK_SIZE]; // exactly one full block
        std::fs::write(dir.path().join("exact.bin"), &content).expect("write served file");

        let (client, peer) = rrq_client();
        let (_shutdown, handle) = start_rrq(dir.path().to_path_buf(), "exact.bin", peer, 1024);

        // Block 1: the full 512-byte block.
        let mut buf = [0u8; 516];
        let (n, server_addr) = client.recv_from(&mut buf).expect("recv DATA 1");
        assert_eq!(u16::from_be_bytes([buf[0], buf[1]]), OP_DATA);
        assert_eq!(u16::from_be_bytes([buf[2], buf[3]]), 1, "first block is #1");
        assert_eq!(n - 4, BLOCK_SIZE, "block 1 should be a full block");
        assert_eq!(&buf[4..n], &content[..], "block 1 contents should match");
        client
            .send_to(&make_ack(1), server_addr)
            .expect("send ACK 1");

        // Block 2: the explicit empty terminating block.
        let (n2, _) = client.recv_from(&mut buf).expect("recv terminating DATA 2");
        assert_eq!(u16::from_be_bytes([buf[0], buf[1]]), OP_DATA);
        assert_eq!(
            u16::from_be_bytes([buf[2], buf[3]]),
            2,
            "terminator is block #2"
        );
        assert_eq!(n2, 4, "terminating block must carry zero data bytes");
        client
            .send_to(&make_ack(2), server_addr)
            .expect("send ACK 2");

        let result = handle.join().expect("server thread");
        assert!(result.is_ok(), "handle_rrq errored: {result:?}");
    }

    #[test]
    fn stream_file_wraps_block_number_past_u16_max() {
        // Regression for CORE-023: the u16 block counter must wrap 65535 -> 0
        // so a transfer larger than 65535 x 512 (~32 MiB) keeps progressing.
        // Rather than move 32 MiB over the socket, start the counter near the
        // boundary via stream_file's injectable start block and verify the
        // sequence wraps and the payload arrives intact.
        use std::io::Cursor;

        let client = StdUdpSocket::bind("127.0.0.1:0").expect("bind client");
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set client timeout");
        let peer = client.local_addr().expect("client addr");

        // 3 full blocks + a short final block => 4 DATA packets crossing the wrap.
        let mut payload = vec![0u8; BLOCK_SIZE * 3 + 50];
        for (i, b) in payload.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        let payload_for_thread = payload.clone();

        let stats = AtomicServerStats::new();
        let shutdown = ShutdownSignal::new();
        let handle = on_runtime(async move {
            let server = UdpSocket::bind("127.0.0.1:0").await.expect("bind server");
            let mut reader = Cursor::new(payload_for_thread);
            let progress = stats.activity.begin_transfer("RRQ", None, None);
            stream_file(
                &server,
                peer,
                &mut reader,
                65534,
                Duration::from_secs(2),
                &stats,
                &progress,
                &shutdown,
            )
            .await
        });

        // Block numbers must wrap 65534, 65535, 0, 1 (not overflow/stall).
        let expected_blocks = [65534u16, 65535, 0, 1];
        let mut received = Vec::new();
        let mut buf = [0u8; 516];
        for &expected in &expected_blocks {
            let (n, from) = client.recv_from(&mut buf).expect("recv DATA");
            assert_eq!(u16::from_be_bytes([buf[0], buf[1]]), OP_DATA);
            assert_eq!(
                u16::from_be_bytes([buf[2], buf[3]]),
                expected,
                "block number sequence must wrap at u16::MAX"
            );
            received.extend_from_slice(&buf[4..n]);
            client.send_to(&make_ack(expected), from).expect("send ACK");
        }

        assert_eq!(
            received, payload,
            "payload must survive the block-number wrap"
        );
        let result = handle.join().expect("server thread");
        assert!(result.is_ok(), "stream_file errored: {result:?}");
    }

    // ── CORE-024: peer TID validation ──────────────────────────────────────────

    #[test]
    fn wrq_data_from_wrong_tid_is_rejected() {
        // Regression for CORE-024: a DATA datagram from a source other than the
        // transfer's peer must be answered with ERROR and dropped, never written
        // or ACKed, while the legitimate peer's upload still completes.
        let dir = tempfile::tempdir().expect("temp dir");
        let (client, server_addr, _shutdown, handle) =
            start_wrq(dir.path().to_path_buf(), "up.bin", 1024);

        // A stray sender (different TID) injects DATA for block 1.
        let attacker = StdUdpSocket::bind("127.0.0.1:0").expect("bind attacker");
        attacker
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set attacker timeout");
        attacker
            .send_to(&data_packet(1, b"evil payload"), server_addr)
            .expect("send stray DATA");

        // The stray sender must get an ERROR "unknown transfer ID"; the server
        // must not ACK it. (recv blocks until the reply arrives, so this also
        // orders the stray strictly before the legitimate DATA below.)
        let mut abuf = [0u8; 516];
        let (an, _) = attacker
            .recv_from(&mut abuf)
            .expect("stray sender should get a reply");
        assert!(an >= 4, "reply too short");
        assert_eq!(u16::from_be_bytes([abuf[0], abuf[1]]), OP_ERROR);
        assert_eq!(u16::from_be_bytes([abuf[2], abuf[3]]), ERR_UNKNOWN_TID);

        // The legitimate client's transfer still completes normally.
        let payload = b"good payload"; // < BLOCK_SIZE => single final block
        client
            .send_to(&data_packet(1, payload), server_addr)
            .expect("send legit DATA 1");
        let mut buf = [0u8; 516];
        let (n, _) = client.recv_from(&mut buf).expect("recv ACK 1");
        assert_eq!(&buf[..n], &make_ack(1), "legit peer should be ACKed");

        let result = handle.join().expect("server thread");
        assert!(result.is_ok(), "handle_wrq errored: {result:?}");

        let written = std::fs::read(dir.path().join("up.bin")).expect("read uploaded file");
        assert_eq!(
            written, payload,
            "only the legitimate peer's bytes may be written"
        );
    }

    #[test]
    fn rrq_ack_from_wrong_tid_is_rejected() {
        // Regression for CORE-024: an ACK from a source other than the transfer's
        // peer must be answered with ERROR and ignored — it must not complete or
        // advance the transfer — while the legitimate peer's download still
        // completes.
        let dir = tempfile::tempdir().expect("temp dir");
        let content = b"single block payload"; // < BLOCK_SIZE => one final block
        std::fs::write(dir.path().join("dl.bin"), content).expect("write served file");

        let (client, peer) = rrq_client();
        let (_shutdown, handle) = start_rrq(dir.path().to_path_buf(), "dl.bin", peer, 1024);

        // Server sends DATA block 1; client learns the transfer address.
        let mut buf = [0u8; 516];
        let (n, server_addr) = client.recv_from(&mut buf).expect("recv DATA 1");
        assert_eq!(u16::from_be_bytes([buf[2], buf[3]]), 1);
        assert_eq!(&buf[4..n], content, "block 1 contents should match");

        // A stray sender ACKs block 1; it must be rejected with ERROR, not taken
        // as the transfer's ACK.
        let attacker = StdUdpSocket::bind("127.0.0.1:0").expect("bind attacker");
        attacker
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set attacker timeout");
        attacker
            .send_to(&make_ack(1), server_addr)
            .expect("send stray ACK");
        let mut abuf = [0u8; 516];
        let (an, _) = attacker
            .recv_from(&mut abuf)
            .expect("stray sender should get a reply");
        assert!(an >= 4, "reply too short");
        assert_eq!(u16::from_be_bytes([abuf[0], abuf[1]]), OP_ERROR);
        assert_eq!(u16::from_be_bytes([abuf[2], abuf[3]]), ERR_UNKNOWN_TID);

        // Only the legitimate peer's ACK completes the transfer. (The server
        // resent DATA 1 after rejecting the stray; the duplicate sitting in the
        // client's buffer is harmless and left undrained.)
        client
            .send_to(&make_ack(1), server_addr)
            .expect("send legit ACK 1");

        let result = handle.join().expect("server thread");
        assert!(result.is_ok(), "handle_rrq errored: {result:?}");
    }

    // ── Event-driven shutdown (WA-RS-001 / #2782) ──────────────────────────────

    /// Generous bound for the wall-clock shutdown tests. The old blocking design
    /// only re-checked the flag after its 5 s transfer read timeout, so a stalled
    /// transfer took up to 5 s to notice a stop; the event-driven one wakes in
    /// well under a millisecond. 1 s cleanly separates the two without being
    /// sensitive to CI scheduling jitter.
    const PROMPT_SHUTDOWN: Duration = Duration::from_secs(1);

    fn tftp_test_config(root: &Path, port: u16) -> EmbeddedServerConfig {
        use crate::embedded_servers::config::ServerType;
        EmbeddedServerConfig {
            id: "test-tftp-shutdown".to_string(),
            name: "test".to_string(),
            server_type: ServerType::Tftp,
            root_directory: root.to_string_lossy().into_owned(),
            bind_host: "127.0.0.1".to_string(),
            port,
            auto_start: false,
            read_only: false,
            directory_listing: None,
            ftp_auth: None,
            http_auth: None,
            max_transfer_bytes: None,
        }
    }

    #[test]
    fn wrq_stalled_client_aborts_promptly_on_shutdown_and_discards_partial() {
        // #2782: a WRQ parked on a client that stopped sending must abort the
        // moment the server is stopped (the old loop only re-checked after its
        // 5 s read timeout) and must not leave the partial upload behind.
        let dir = tempfile::tempdir().expect("temp dir");
        let (client, server_addr, shutdown, handle) =
            start_wrq(dir.path().to_path_buf(), "partial.bin", 1024 * 1024);

        // One full block, so the transfer is genuinely mid-upload…
        client
            .send_to(&data_packet(1, &[0x11u8; BLOCK_SIZE]), server_addr)
            .expect("send DATA 1");
        let mut buf = [0u8; 516];
        let (n, _) = client.recv_from(&mut buf).expect("recv ACK 1");
        assert_eq!(&buf[..n], &make_ack(1), "expected ACK for block 1");

        // …then the client stalls and the server is stopped.
        let start = std::time::Instant::now();
        shutdown.trigger();
        let result = handle.join().expect("server thread");
        let elapsed = start.elapsed();

        assert!(result.is_ok(), "handle_wrq errored: {result:?}");
        assert!(
            elapsed < PROMPT_SHUTDOWN,
            "stalled WRQ took {elapsed:?} to stop; shutdown must be event-driven"
        );
        assert!(
            !dir.path().join("partial.bin").exists(),
            "an upload aborted by shutdown must not leave a partial file"
        );
    }

    #[test]
    fn rrq_stalled_client_aborts_promptly_on_shutdown() {
        // #2782: an RRQ waiting on an ACK that never comes must abort the moment
        // the server is stopped, not after its 5 s retransmit timeout.
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("dl.bin"), vec![0x22u8; BLOCK_SIZE * 4])
            .expect("write served file");

        let (client, peer) = rrq_client();
        let (shutdown, handle) = start_rrq(dir.path().to_path_buf(), "dl.bin", peer, 1024 * 1024);

        // Receive DATA 1 but never ACK it.
        let mut buf = [0u8; 516];
        let (_, _) = client.recv_from(&mut buf).expect("recv DATA 1");
        assert_eq!(u16::from_be_bytes([buf[2], buf[3]]), 1);

        let start = std::time::Instant::now();
        shutdown.trigger();
        let result = handle.join().expect("server thread");
        let elapsed = start.elapsed();

        assert!(result.is_ok(), "handle_rrq errored: {result:?}");
        assert!(
            elapsed < PROMPT_SHUTDOWN,
            "stalled RRQ took {elapsed:?} to stop; shutdown must be event-driven"
        );
    }

    /// The accept loop must observe shutdown without any timer firing: under a
    /// paused tokio clock a timed poll (the old 100 ms read timeout) would have
    /// to advance virtual time before noticing, whereas the event-driven wait
    /// wakes with the clock standing still. Deterministic — no wall-clock bound.
    #[tokio::test(start_paused = true)]
    async fn accept_loop_observes_shutdown_without_a_timer_tick() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config = tftp_test_config(dir.path(), 0);
        let shutdown = ShutdownSignal::new();
        let (ready, ready_rx) = BindSignal::for_test();

        let server = run_tftp_server(&config, shutdown.clone(), AtomicServerStats::new(), ready);
        tokio::pin!(server);

        // Drive the server (without idling, so the paused clock never advances)
        // until it confirms its bind and parks in its accept `select!`.
        let mut bound = false;
        let mut polls_after_bind = 0;
        for _ in 0..1_000_000 {
            tokio::select! {
                biased;
                res = &mut server => panic!("server exited before shutdown: {res:?}"),
                _ = tokio::task::yield_now() => {}
            }
            if bound {
                polls_after_bind += 1;
                if polls_after_bind >= 50 {
                    break;
                }
            } else if let Ok(bind) = ready_rx.try_recv() {
                assert!(bind.is_ok(), "bind should succeed, got {bind:?}");
                bound = true;
            }
        }
        assert!(bound, "server never confirmed its bind");

        let start = tokio::time::Instant::now();
        shutdown.trigger();
        let result = server.await;
        assert!(result.is_ok(), "server exited with error: {result:?}");
        assert_eq!(
            tokio::time::Instant::now() - start,
            Duration::ZERO,
            "shutdown must be event-driven, not observed by a timed poll"
        );
    }

    /// Start a real TFTP server thread on a free loopback port. Returns the
    /// server address, its shutdown signal and the thread's join handle.
    ///
    /// The port is found by binding an ephemeral socket and releasing it; if
    /// another process grabs it in between, the bind failure is reported via the
    /// ready signal and we simply retry on a fresh port.
    fn start_real_tftp(
        root: &Path,
    ) -> (
        SocketAddr,
        ShutdownSignal,
        std::thread::JoinHandle<Result<()>>,
    ) {
        let (addr, shutdown, handle, _stats) = start_real_tftp_with(root, false);
        (addr, shutdown, handle)
    }

    /// As [`start_real_tftp`], optionally read-only, also returning the stats
    /// (and access log) the server records into.
    fn start_real_tftp_with(
        root: &Path,
        read_only: bool,
    ) -> (
        SocketAddr,
        ShutdownSignal,
        std::thread::JoinHandle<Result<()>>,
        Arc<AtomicServerStats>,
    ) {
        for _ in 0..5 {
            let port = StdUdpSocket::bind("127.0.0.1:0")
                .and_then(|s| s.local_addr())
                .expect("find free port")
                .port();
            let mut config = tftp_test_config(root, port);
            config.read_only = read_only;
            let shutdown = ShutdownSignal::new();
            let stats = AtomicServerStats::new();
            let (ready, ready_rx) = BindSignal::for_test();
            let server_shutdown = shutdown.clone();
            let server_stats = Arc::clone(&stats);
            let handle = std::thread::spawn(move || {
                start_tftp_server(&config, server_shutdown, server_stats, ready)
            });
            match ready_rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(())) => {
                    let addr = SocketAddr::from(([127, 0, 0, 1], port));
                    return (addr, shutdown, handle, stats);
                }
                _ => {
                    let _ = handle.join();
                }
            }
        }
        panic!("could not start a TFTP server on a free port");
    }

    #[test]
    fn shutdown_stops_server_and_in_flight_upload_promptly() {
        // End-to-end (#2782): with an upload stalled mid-transfer, stopping the
        // real server must wake the accept loop *and* the transfer task at once,
        // let the transfer discard its partial file, and return cleanly.
        let dir = tempfile::tempdir().expect("temp dir");
        let (server_addr, shutdown, handle) = start_real_tftp(dir.path());

        // Open a WRQ and send one full block, then stall.
        let (client, _) = rrq_client();
        let mut wrq = OP_WRQ.to_be_bytes().to_vec();
        wrq.extend_from_slice(b"stalled.bin\0octet\0");
        client.send_to(&wrq, server_addr).expect("send WRQ");
        let mut buf = [0u8; 516];
        let (n, transfer_addr) = client.recv_from(&mut buf).expect("recv ACK 0");
        assert_eq!(&buf[..n], &make_ack(0), "expected initial ACK 0");
        client
            .send_to(&data_packet(1, &[0x33u8; BLOCK_SIZE]), transfer_addr)
            .expect("send DATA 1");
        let (n, _) = client.recv_from(&mut buf).expect("recv ACK 1");
        assert_eq!(&buf[..n], &make_ack(1), "expected ACK for block 1");
        assert!(
            dir.path().join("stalled.bin").exists(),
            "upload in progress"
        );

        let start = std::time::Instant::now();
        shutdown.trigger();
        let result = handle.join().expect("server thread should not panic");
        let elapsed = start.elapsed();

        assert!(result.is_ok(), "server exited with error: {result:?}");
        assert!(
            elapsed < PROMPT_SHUTDOWN,
            "server with a stalled upload took {elapsed:?} to stop"
        );
        assert!(
            !dir.path().join("stalled.bin").exists(),
            "the in-flight upload must be discarded on shutdown, not left partial"
        );
    }

    // ── Access log (PROD-034) ──────────────────────────────────────────────────

    /// Poll the access log until `n` entries are present (the entry is written
    /// by the transfer task right after the last packet).
    fn wait_for_entries(
        stats: &AtomicServerStats,
        n: usize,
    ) -> Vec<crate::embedded_servers::activity::AccessLogEntry> {
        let mut entries = Vec::new();
        for _ in 0..100 {
            entries = stats.activity.snapshot(None, &stats.snapshot()).entries;
            if entries.len() >= n {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        entries
    }

    #[test]
    fn rrq_is_recorded_in_access_log() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("fw.bin"), b"firmware image").expect("write");
        let (server_addr, shutdown, handle, stats) = start_real_tftp_with(dir.path(), false);

        let (client, _) = rrq_client();
        let mut rrq = OP_RRQ.to_be_bytes().to_vec();
        rrq.extend_from_slice(b"fw.bin\0octet\0");
        client.send_to(&rrq, server_addr).expect("send RRQ");
        let mut buf = [0u8; 516];
        let (n, transfer_addr) = client.recv_from(&mut buf).expect("recv DATA 1");
        assert_eq!(&buf[4..n], b"firmware image");
        client
            .send_to(&make_ack(1), transfer_addr)
            .expect("send ACK 1");

        let entries = wait_for_entries(&stats, 1);
        shutdown.trigger();
        let _ = handle.join();

        assert_eq!(entries.len(), 1, "entries: {entries:?}");
        let e = &entries[0];
        assert_eq!(e.method, "RRQ");
        assert_eq!(e.path.as_deref(), Some("fw.bin"));
        assert_eq!(e.client.as_deref(), Some("127.0.0.1"));
        assert_eq!(e.status, "ok");
        assert!(e.success);
        assert_eq!(e.bytes, 14);
    }

    #[test]
    fn wrq_to_read_only_server_is_recorded_as_denied() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (server_addr, shutdown, handle, stats) = start_real_tftp_with(dir.path(), true);

        let (client, _) = rrq_client();
        let mut wrq = OP_WRQ.to_be_bytes().to_vec();
        wrq.extend_from_slice(b"evil.bin\0octet\0");
        client.send_to(&wrq, server_addr).expect("send WRQ");
        let mut buf = [0u8; 516];
        let (_, _) = client.recv_from(&mut buf).expect("recv ERROR");
        assert_eq!(u16::from_be_bytes([buf[0], buf[1]]), OP_ERROR);

        let entries = wait_for_entries(&stats, 1);
        shutdown.trigger();
        let _ = handle.join();

        assert_eq!(entries[0].method, "WRQ");
        assert_eq!(entries[0].status, "denied");
        assert!(!entries[0].success);
        let snap = stats.activity.snapshot(None, &stats.snapshot());
        assert_eq!(snap.stats.errors, 1);
    }

    #[test]
    fn transfer_record_maps_every_outcome() {
        let status = |r: Result<TransferEnd>| {
            let rec = transfer_record("RRQ", &r);
            let activity = crate::embedded_servers::activity::ServerActivity::new();
            activity.record(rec);
            let e = activity
                .snapshot(None, &Default::default())
                .entries
                .remove(0);
            (e.status, e.success)
        };
        assert_eq!(status(Ok(TransferEnd::Completed)), ("ok".into(), true));
        assert_eq!(status(Ok(TransferEnd::Aborted)), ("aborted".into(), false));
        assert_eq!(
            status(Ok(TransferEnd::Denied("x"))),
            ("denied".into(), false)
        );
        assert_eq!(
            status(Ok(TransferEnd::Rejected("x"))),
            ("rejected".into(), false)
        );
        assert_eq!(status(Ok(TransferEnd::TimedOut)), ("timeout".into(), false));
        assert_eq!(
            status(Err(anyhow::anyhow!("boom"))),
            ("error".into(), false)
        );
    }

    // ── #3306: a stalled WRQ gives up after the retransmit budget ──────────────

    /// A client that sends a WRQ and then goes silent must not hold its transfer
    /// (slot + partial file) forever: after `MAX_RETRIES` retransmit timeouts the
    /// WRQ is abandoned, the partial file removed and the transfer released.
    /// Paused clock: the 5 × 5 s budget elapses in virtual time, deterministically.
    #[tokio::test(start_paused = true)]
    async fn stalled_wrq_times_out_after_retry_budget_and_discards_partial() {
        let dir = tempfile::tempdir().expect("temp dir");
        let client = UdpSocket::bind("127.0.0.1:0").await.expect("bind client");
        let peer = client.local_addr().expect("client addr");
        let stats = AtomicServerStats::new();
        let shutdown = ShutdownSignal::new();

        let started = tokio::time::Instant::now();
        let outcome = {
            let progress = stats.activity.begin_transfer("WRQ", None, None);
            // While in flight the upload is listed as a current transfer.
            assert_eq!(
                stats
                    .activity
                    .snapshot(None, &stats.snapshot())
                    .stats
                    .current_transfers
                    .len(),
                1
            );
            handle_wrq(
                dir.path(),
                "stalled.bin",
                peer,
                "127.0.0.1",
                1024 * 1024,
                &stats,
                &progress,
                &shutdown,
            )
            .await
        };

        assert!(
            matches!(outcome, Ok(TransferEnd::TimedOut)),
            "expected TimedOut, got {outcome:?}"
        );
        assert!(
            tokio::time::Instant::now() - started >= ACK_TIMEOUT * MAX_RETRIES,
            "gave up before the retransmit budget was spent"
        );
        assert!(
            !dir.path().join("stalled.bin").exists(),
            "a timed-out upload must not leave a partial file"
        );
        assert!(
            stats
                .activity
                .snapshot(None, &stats.snapshot())
                .stats
                .current_transfers
                .is_empty(),
            "the timed-out transfer must be released"
        );

        // The client saw ACK 0 plus one retransmission per timeout but the last.
        let mut acks = 0;
        let mut buf = [0u8; 16];
        while let Ok((n, _)) = client.try_recv_from(&mut buf) {
            assert_eq!(&buf[..n], &make_ack(0));
            acks += 1;
        }
        assert_eq!(acks, MAX_RETRIES as usize);
    }
}
