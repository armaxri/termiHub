//! Front relay for the embedded FTP server (#3996).
//!
//! libunftp 0.23 buffers a control-channel line without any bound, and it
//! offers no hook to cap it: `Server::service` takes a concrete `TcpStream` and
//! its `FtpCodec` has no length limit. So termiHub owns the public control
//! socket and relays to libunftp, which listens on loopback in its PROXY
//! protocol mode (the HAProxy deployment it is designed for):
//!
//! ```text
//! client ──control──▶ relay (public port) ──PROXY v1 + lines──▶ libunftp (127.0.0.1)
//! client ──data────▶ relay (passive port) ──PROXY v1 + bytes──▶ libunftp (same port)
//! ```
//!
//! * **Control-line cap.** The relay forwards only complete lines. A line with
//!   more than [`MAX_CONTROL_LINE`] bytes before its terminator gets `500` and
//!   the connection is closed — libunftp never sees it, and the relay never
//!   holds more than the cap plus one read chunk.
//! * **Client identity.** Each upstream connection starts with a PROXY v1
//!   header carrying the real client address, so libunftp's passive-port
//!   switchboard — keyed on the PROXY source IP — only hands a data connection
//!   to the session whose control connection came from the same IP.
//! * **Passive ports.** In proxy mode libunftp binds no passive ports: it
//!   reserves a port number, announces it in `227`, and expects the proxy to
//!   accept on that port and forward with a PROXY header whose destination port
//!   is the reserved one. The relay parses each plaintext `227` reply, opens a
//!   listener on demand (the reserved port if free, else another one in the
//!   range), rewrites the reply to announce the port it actually holds, and
//!   forwards the data connection with the reserved port in the header. Binding
//!   on demand keeps one listener per pending `PASV` instead of pre-binding the
//!   whole 16k-port range, and the rewrite removes any collision between a port
//!   libunftp reserved and one another process already holds.
//! * **EPSV.** libunftp answers `EPSV` with `502` in proxy mode, so the relay
//!   sends libunftp `PASV` instead and turns the `227` into a `229`.
//! * **Data source check.** The relay itself only forwards a data connection
//!   whose source IP matches the control connection's, and the PROXY header
//!   lets libunftp's switchboard check it again.
//! * **Relay-only backend.** libunftp serves on a loopback listener the
//!   relay bound and hands over, and accepts only connections from a socket
//!   the relay bound and recorded ([`BackendDialer`]). A local process that
//!   connects to the loopback port directly is closed before its PROXY header
//!   is read, and logged (#4100).
//!
//! The relay inspects plaintext. FTPS is not enabled today; enabling it later
//! means terminating TLS in the relay (and re-originating plaintext, or TLS, to
//! libunftp), because `AUTH TLS` would otherwise hide the `227` replies and the
//! line boundaries the cap needs. See `docs/architecture.md`, "Embedded FTP Server
//! Front Relay".

use std::collections::HashSet;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::ops::RangeInclusive;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::task::JoinSet;

use super::activity::{AccessRecord, ServerActivity};

/// Most control bytes the relay accepts before a line terminator (`\n`).
pub(super) const MAX_CONTROL_LINE: usize = 8 * 1024;
/// Bound on one reply line from libunftp (trusted, but never buffered unbounded).
const MAX_REPLY_LINE: usize = 64 * 1024;
/// Read size for both directions of the control relay.
const READ_CHUNK: usize = 4 * 1024;
/// Reply sent before closing a connection whose control line is too long.
const LINE_TOO_LONG_REPLY: &[u8] = b"500 Command line too long.\r\n";
/// Reply sent when the relay cannot open a passive data listener.
const NO_DATA_PORT_REPLY: &[u8] = b"425 Can't open data connection.\r\n";
/// How long a passive listener waits for the client (libunftp's own value).
const DATA_ACCEPT_TIMEOUT: Duration = Duration::from_secs(15);
/// After a `500` for an overlong line, how long the relay keeps discarding
/// client bytes so the close does not turn into a reset that drops the reply.
const OVERFLOW_DRAIN_TIME: Duration = Duration::from_millis(500);
/// Most client bytes discarded (never buffered) after an overlong line.
const OVERFLOW_DRAIN_BYTES: usize = 64 * 1024;
/// Ports tried for a passive listener before answering `425`.
const DATA_BIND_ATTEMPTS: u32 = 64;

// ─── Control-line framing ─────────────────────────────────────────────────────

/// A line exceeded the framer's cap before its terminator arrived.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct LineTooLong;

/// Splits a byte stream into `\n`-terminated lines, holding at most `cap`
/// bytes of an unfinished line.
#[derive(Debug)]
pub(super) struct LineFramer {
    pending: Vec<u8>,
    cap: usize,
}

impl LineFramer {
    pub(super) fn new(cap: usize) -> Self {
        Self {
            pending: Vec::new(),
            cap,
        }
    }

    /// Bytes of the unfinished line currently held.
    #[cfg(test)]
    pub(super) fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Feed `chunk`, returning every line it completes (terminator included).
    /// Fails as soon as a line's content (the bytes before `\n`) exceeds the
    /// cap, without holding more than the cap.
    pub(super) fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, LineTooLong> {
        let mut lines = Vec::new();
        let mut rest = chunk;
        while let Some(pos) = rest.iter().position(|&b| b == b'\n') {
            if self.pending.len() + pos > self.cap {
                return Err(LineTooLong);
            }
            let (line, tail) = rest.split_at(pos + 1);
            self.pending.extend_from_slice(line);
            lines.push(std::mem::take(&mut self.pending));
            rest = tail;
        }
        if self.pending.len() + rest.len() > self.cap {
            return Err(LineTooLong);
        }
        self.pending.extend_from_slice(rest);
        Ok(lines)
    }
}

// ─── PROXY v1 header and passive replies ──────────────────────────────────────

/// The IPv4 address the PROXY header carries for `ip`. libunftp accepts only
/// `TCP4` headers, so an IPv4-mapped address is unmapped and a real IPv6
/// address becomes `0.0.0.0` (the relay enforces the source check for it).
pub(super) fn proxy_ipv4(ip: IpAddr) -> Ipv4Addr {
    match ip.to_canonical() {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(_) => Ipv4Addr::UNSPECIFIED,
    }
}

/// A PROXY protocol v1 header for a connection from `source` to `destination`.
pub(super) fn proxy_v1_header(source: SocketAddr, destination: SocketAddr) -> String {
    format!(
        "PROXY TCP4 {} {} {} {}\r\n",
        proxy_ipv4(source.ip()),
        proxy_ipv4(destination.ip()),
        source.port(),
        destination.port()
    )
}

/// The port of a `227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)` reply line.
pub(super) fn parse_pasv_port(line: &[u8]) -> Option<u16> {
    let text = std::str::from_utf8(line).ok()?;
    if !text.starts_with("227") {
        return None;
    }
    let inner = &text[text.find('(')? + 1..text.rfind(')')?];
    let nums: Vec<u8> = inner
        .split(',')
        .map(|n| n.trim().parse::<u8>())
        .collect::<Result<_, _>>()
        .ok()?;
    match nums.as_slice() {
        [_, _, _, _, p1, p2] => Some(u16::from(*p1) << 8 | u16::from(*p2)),
        _ => None,
    }
}

/// A `227` reply announcing `ip:port`.
pub(super) fn pasv_reply(ip: Ipv4Addr, port: u16) -> Vec<u8> {
    let [a, b, c, d] = ip.octets();
    format!(
        "227 Entering Passive Mode ({a},{b},{c},{d},{},{})\r\n",
        port >> 8,
        port & 0xff
    )
    .into_bytes()
}

/// A `229` reply announcing `port`.
pub(super) fn epsv_reply(port: u16) -> Vec<u8> {
    format!("229 Entering Extended Passive Mode (|||{port}|)\r\n").into_bytes()
}

/// Whether `line` is an `EPSV` request the relay serves via `PASV` (bare, or
/// with a protocol argument). `EPSV ALL` is passed through unchanged.
pub(super) fn is_epsv_request(line: &[u8]) -> bool {
    let text = String::from_utf8_lossy(line);
    let mut words = text.split_whitespace();
    matches!(words.next(), Some(cmd) if cmd.eq_ignore_ascii_case("EPSV"))
        && matches!(words.next(), None | Some("1") | Some("2"))
        && words.next().is_none()
}

/// Tracks reply framing (multi-line replies) on the server-to-client stream.
#[derive(Debug, Default)]
struct ReplyTracker {
    /// Code of the multi-line reply in progress, if any.
    multiline: Option<u16>,
}

impl ReplyTracker {
    /// The reply code when `line` ends a reply, `None` for a continuation.
    fn final_code(&mut self, line: &[u8]) -> Option<u16> {
        let code = line
            .get(..3)
            .filter(|d| d.iter().all(u8::is_ascii_digit))
            .and_then(|d| std::str::from_utf8(d).ok())
            .and_then(|d| d.parse::<u16>().ok());
        let sep = line.get(3).copied();
        match (self.multiline, code, sep) {
            (Some(open), Some(c), Some(b' ')) if c == open => {
                self.multiline = None;
                Some(c)
            }
            (Some(_), _, _) => None,
            (None, Some(c), Some(b'-')) => {
                self.multiline = Some(c);
                None
            }
            (None, Some(c), _) => Some(c),
            (None, None, _) => None,
        }
    }
}

// ─── Relay-only backend connections ───────────────────────────────────────────

/// Opens the relay's connections to one session's libunftp listener and tells
/// that listener which connections are the relay's (#4100).
///
/// libunftp trusts the PROXY header each connection starts with, and its
/// loopback port is reachable by every local process. So the relay binds each
/// outbound socket itself, records the local address before connecting, and
/// libunftp's peer filter ([`Self::peer_filter`]) serves only accepted
/// connections from a recorded address — each one once. Every other
/// connection is closed before libunftp reads a byte, so a local process
/// cannot spoof a client IP or passive-data key, or skip the control-line cap.
///
/// The recorded address cannot be reused by another process while the relay's
/// socket holds it: the socket is bound without `SO_REUSEADDR`/`SO_REUSEPORT`.
#[derive(Clone)]
pub(super) struct BackendDialer {
    backend: SocketAddr,
    expected: Arc<Mutex<HashSet<SocketAddr>>>,
    activity: Arc<ServerActivity>,
}

impl BackendDialer {
    pub(super) fn new(backend: SocketAddr, activity: Arc<ServerActivity>) -> Self {
        Self {
            backend,
            expected: Arc::default(),
            activity,
        }
    }

    /// The libunftp listener this dialer connects to.
    #[cfg(test)]
    pub(super) fn backend(&self) -> SocketAddr {
        self.backend
    }

    /// Connect to the backend from a socket the relay bound, after recording
    /// its local address for [`Self::peer_filter`].
    pub(super) async fn connect(&self) -> io::Result<TcpStream> {
        let socket = if self.backend.is_ipv4() {
            TcpSocket::new_v4()?
        } else {
            TcpSocket::new_v6()?
        };
        socket.bind(SocketAddr::new(self.backend.ip(), 0))?;
        let local = socket.local_addr()?;
        lock(&self.expected).insert(local);
        let connected = socket.connect(self.backend).await;
        if connected.is_err() {
            lock(&self.expected).remove(&local);
        }
        connected
    }

    /// The accept filter for libunftp's PROXY-mode listener: allows a peer
    /// once if the relay recorded it, and logs and refuses every other one.
    pub(super) fn peer_filter(&self) -> impl Fn(SocketAddr) -> bool + Send + Sync + 'static {
        let expected = Arc::clone(&self.expected);
        let activity = Arc::clone(&self.activity);
        move |peer| {
            if lock(&expected).remove(&peer) {
                return true;
            }
            tracing::warn!(%peer, "FTP backend connection not opened by the relay refused");
            activity.record(
                AccessRecord::new("CONTROL", "rejected", false)
                    .client(peer.ip())
                    .detail("loopback backend connection not opened by the relay"),
            );
            false
        }
    }
}

/// Lock the expected-peer set. Every critical section is a single set
/// operation, so a poisoned lock still holds a consistent set.
fn lock(set: &Mutex<HashSet<SocketAddr>>) -> std::sync::MutexGuard<'_, HashSet<SocketAddr>> {
    set.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ─── Session relay ────────────────────────────────────────────────────────────

/// One relayed FTP control connection and its passive data connections.
pub(super) struct RelaySession {
    /// The client's control connection, accepted on the public port.
    pub client: TcpStream,
    /// The client's address. For a real connection this is the accepted peer
    /// address; it is a parameter so tests can present a non-loopback client.
    pub peer: SocketAddr,
    /// A connection to the session's libunftp proxy-mode listener.
    pub upstream: TcpStream,
    /// Opens the data connections to that libunftp listener (#4100).
    pub dialer: BackendDialer,
    /// The public control port (libunftp's `external_control_port`).
    pub public_port: u16,
    /// The range passive listeners are bound in.
    pub passive_ports: RangeInclusive<u16>,
    /// The server's access log, for rejected connections.
    pub activity: Arc<ServerActivity>,
}

/// A passive data connection accepted from the right client, ready to forward.
struct AcceptedData {
    stream: TcpStream,
    from: SocketAddr,
    /// The data port libunftp reserved (the PROXY destination port).
    reserved_port: u16,
}

impl RelaySession {
    /// Relay until either side closes the control connection.
    pub(super) async fn run(self) -> io::Result<()> {
        let local = self.client.local_addr()?;
        let mut upstream = self.upstream;
        let header = proxy_v1_header(self.peer, SocketAddr::new(local.ip(), self.public_port));
        upstream.write_all(header.as_bytes()).await?;

        let ctx = DataContext {
            client_ip: self.peer.ip().to_canonical(),
            local_ip: local.ip().to_canonical(),
            dialer: self.dialer,
            passive_ports: self.passive_ports,
        };
        let (mut client_rx, mut client_tx) = self.client.into_split();
        let (mut up_rx, mut up_tx) = upstream.into_split();
        let mut commands = LineFramer::new(MAX_CONTROL_LINE);
        let mut replies = LineFramer::new(MAX_REPLY_LINE);
        let mut tracker = ReplyTracker::default();
        let mut epsv_pending = false;
        let mut client_open = true;
        let mut listeners: JoinSet<Option<AcceptedData>> = JoinSet::new();
        let mut forwarders: JoinSet<()> = JoinSet::new();
        let mut cbuf = [0u8; READ_CHUNK];
        let mut ubuf = [0u8; READ_CHUNK];

        loop {
            tokio::select! {
                read = client_rx.read(&mut cbuf), if client_open => {
                    let n = read?;
                    if n == 0 {
                        // Half-close: let libunftp see EOF, keep relaying its replies.
                        client_open = false;
                        let _ = up_tx.shutdown().await;
                        continue;
                    }
                    match commands.push(&cbuf[..n]) {
                        Ok(lines) => {
                            for line in lines {
                                if is_epsv_request(&line) {
                                    epsv_pending = true;
                                    up_tx.write_all(b"PASV\r\n").await?;
                                } else {
                                    up_tx.write_all(&line).await?;
                                }
                            }
                        }
                        Err(LineTooLong) => {
                            tracing::warn!(peer = %self.peer, "FTP control line exceeds the cap; closing");
                            self.activity.record(
                                AccessRecord::new("CONTROL", "rejected", false)
                                    .client(self.peer.ip())
                                    .detail("control line too long"),
                            );
                            reject_overlong(client_rx, client_tx).await;
                            return Ok(());
                        }
                    }
                }
                read = up_rx.read(&mut ubuf) => {
                    let n = read?;
                    if n == 0 {
                        break;
                    }
                    let lines = replies
                        .push(&ubuf[..n])
                        .map_err(|_| io::Error::other("FTP reply line from libunftp too long"))?;
                    for line in lines {
                        let code = tracker.final_code(&line);
                        let out = match code {
                            Some(227) => match parse_pasv_port(&line) {
                                Some(reserved) => {
                                    let epsv = std::mem::take(&mut epsv_pending);
                                    open_passive(&ctx, reserved, epsv, &mut listeners).await
                                }
                                None => line,
                            },
                            Some(c) if c >= 200 => {
                                epsv_pending = false;
                                line
                            }
                            _ => line,
                        };
                        client_tx.write_all(&out).await?;
                    }
                }
                Some(joined) = listeners.join_next(), if !listeners.is_empty() => {
                    if let Ok(Some(accepted)) = joined {
                        let dialer = ctx.dialer.clone();
                        let local_ip = ctx.local_ip;
                        forwarders.spawn(async move {
                            if let Err(e) = forward_data(accepted, local_ip, &dialer).await {
                                tracing::debug!(error = %e, "FTP data relay ended with an error");
                            }
                        });
                    }
                }
                Some(_) = forwarders.join_next(), if !forwarders.is_empty() => {}
            }
        }
        let _ = client_tx.shutdown().await;
        Ok(())
    }
}

/// What the passive-port handling needs from the session.
struct DataContext {
    client_ip: IpAddr,
    local_ip: IpAddr,
    dialer: BackendDialer,
    passive_ports: RangeInclusive<u16>,
}

/// Open a listener for libunftp's `reserved` passive port and return the reply
/// to send the client in place of libunftp's `227`. A new passive request
/// replaces any listener still waiting from an earlier one.
async fn open_passive(
    ctx: &DataContext,
    reserved: u16,
    epsv: bool,
    listeners: &mut JoinSet<Option<AcceptedData>>,
) -> Vec<u8> {
    let listener = match bind_data_listener(ctx.local_ip, reserved, &ctx.passive_ports) {
        Ok(listener) => listener,
        Err(e) => {
            tracing::warn!(error = %e, "FTP relay could not open a passive listener");
            return NO_DATA_PORT_REPLY.to_vec();
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(_) => return NO_DATA_PORT_REPLY.to_vec(),
    };
    listeners.abort_all();
    listeners.spawn(accept_data(listener, ctx.client_ip, reserved));
    if epsv {
        epsv_reply(port)
    } else {
        pasv_reply(proxy_ipv4(ctx.local_ip), port)
    }
}

/// Bind a passive listener on `ip`, trying `preferred` first and then the
/// following ports of `range` (wrapping), up to [`DATA_BIND_ATTEMPTS`].
fn bind_data_listener(
    ip: IpAddr,
    preferred: u16,
    range: &RangeInclusive<u16>,
) -> io::Result<TcpListener> {
    let (start, end) = (u32::from(*range.start()), u32::from(*range.end()));
    let span = end - start + 1;
    let first = u32::from(preferred).clamp(start, end) - start;
    let mut last_err = io::Error::new(io::ErrorKind::AddrInUse, "no free passive port");
    for i in 0..DATA_BIND_ATTEMPTS.min(span) {
        let port = (start + (first + i) % span) as u16;
        match std::net::TcpListener::bind(SocketAddr::new(ip, port)) {
            Ok(std_listener) => {
                std_listener.set_nonblocking(true)?;
                return TcpListener::from_std(std_listener);
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

/// Wait for the client's data connection. A connection from any other source
/// IP is closed (and the listener keeps waiting for the right one); after the
/// first valid connection, or the timeout, the listener is closed.
async fn accept_data(
    listener: TcpListener,
    client_ip: IpAddr,
    reserved_port: u16,
) -> Option<AcceptedData> {
    let deadline = tokio::time::Instant::now() + DATA_ACCEPT_TIMEOUT;
    loop {
        let (stream, from) = match tokio::time::timeout_at(deadline, listener.accept()).await {
            Ok(Ok(accepted)) => accepted,
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "FTP passive accept failed");
                return None;
            }
            Err(_) => return None,
        };
        if from.ip().to_canonical() != client_ip {
            tracing::warn!(%from, %client_ip, "FTP data connection from a different IP rejected");
            drop(stream);
            continue;
        }
        return Some(AcceptedData {
            stream,
            from,
            reserved_port,
        });
    }
}

/// Forward one data connection to libunftp, announcing the reserved port.
async fn forward_data(
    accepted: AcceptedData,
    local_ip: IpAddr,
    dialer: &BackendDialer,
) -> io::Result<()> {
    let AcceptedData {
        mut stream,
        from,
        reserved_port,
    } = accepted;
    let mut upstream = dialer.connect().await?;
    let header = proxy_v1_header(from, SocketAddr::new(local_ip, reserved_port));
    upstream.write_all(header.as_bytes()).await?;
    tokio::io::copy_bidirectional(&mut stream, &mut upstream).await?;
    Ok(())
}

/// Answer an overlong control line with `500` and close. The relay keeps
/// reading briefly, discarding every byte, so the client's in-flight data does
/// not make the kernel reset the connection and drop the reply.
async fn reject_overlong(mut client_rx: OwnedReadHalf, mut client_tx: OwnedWriteHalf) {
    let _ = client_tx.write_all(LINE_TOO_LONG_REPLY).await;
    let _ = client_tx.shutdown().await;
    let mut scratch = [0u8; READ_CHUNK];
    let mut discarded = 0usize;
    let _ = tokio::time::timeout(OVERFLOW_DRAIN_TIME, async {
        while discarded < OVERFLOW_DRAIN_BYTES {
            match client_rx.read(&mut scratch).await {
                Ok(0) | Err(_) => break,
                Ok(n) => discarded += n,
            }
        }
    })
    .await;
}

#[cfg(test)]
#[path = "ftp_relay_tests.rs"]
mod tests;
