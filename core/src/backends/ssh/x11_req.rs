//! X11 forwarding the OpenSSH way: an `x11-req` channel request (#5570).
//!
//! Before the shell starts, the session channel asks the server for X11
//! forwarding (RFC 4254 §6.3.1) with the `MIT-MAGIC-COOKIE-1` protocol and a
//! random **fake** cookie. sshd then sets `DISPLAY` and runs `xauth` with that
//! fake cookie itself, so nothing is typed into the shell. Each X client on the
//! host makes the server open an `x11` channel back to us; the handler accepts
//! it only while this module's [`X11ReqForwarder`] holds the connection's X11
//! grant (see [`ForwardedChannels`](super::handler::ForwardedChannels)).
//!
//! Each accepted channel starts with the X11 connection setup. Like OpenSSH's
//! `x11_open_helper`, [`rewrite_setup`] checks that it carries exactly the fake
//! cookie and swaps in the real local one before anything reaches the local X
//! server. A setup with another protocol, another cookie, a bad byte order or
//! one that does not arrive in time is refused: the channel is closed and the
//! local server never sees it. The real cookie never leaves this machine, and
//! neither cookie is ever logged.
//!
//! A server that refuses `x11-req` (`X11Forwarding no`, the OpenSSH default;
//! Win32-OpenSSH) gets the older `tcpip-forward` path in `x11.rs` instead, with
//! its typed `DISPLAY` / `xauth` setup.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rand::RngCore;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use super::handler::{ForwardedChannelRegistry, IncomingX11};
use super::x11::{LocalXConnection, LocalXServerInfo, ResolvedXServer};

/// The only X11 authorization protocol termiHub forwards.
pub const MIT_MAGIC_COOKIE_1: &str = "MIT-MAGIC-COOKIE-1";

/// Length of a `MIT-MAGIC-COOKIE-1` cookie, in bytes.
const COOKIE_LEN: usize = 16;

/// How long the server may take to answer `x11-req`. A server that does not
/// answer in time is treated as refusing it, and the typed fallback is used.
pub(crate) const X11_REQ_REPLY_TIMEOUT: Duration = Duration::from_secs(10);

/// How long an X client may take to send its connection setup over a new
/// `x11` channel. Real clients send it at once.
const SETUP_TIMEOUT: Duration = Duration::from_secs(15);

/// How often the forwarder checks that its session is still alive.
const ALIVE_POLL: Duration = Duration::from_millis(100);

/// Which way X11 forwarding runs for a session (#5570).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum X11Mode {
    /// The server accepted `x11-req`: sshd set `DISPLAY` and ran `xauth`, and
    /// nothing was typed into the shell.
    ChannelRequest,
    /// The server refused `x11-req`: a `tcpip-forward` listener plus typed
    /// `DISPLAY` / `xauth` setup (hidden where the shell allows it, #5555).
    TypedFallback,
}

impl X11Mode {
    /// A one-line, user-facing description for the connect status and log.
    pub fn describe(self) -> &'static str {
        match self {
            Self::ChannelRequest => "X11 forwarding: DISPLAY set by the SSH server (x11-req)",
            Self::TypedFallback => {
                "X11 forwarding: the server refused x11-req (X11Forwarding no); \
                 using the typed DISPLAY fallback"
            }
        }
    }
}

/// The cookies of one forwarded display. `Debug` prints neither.
pub struct X11Cookies {
    /// The fake cookie sent to the server; sshd hands it to remote clients.
    fake: Vec<u8>,
    /// The real local cookie, or `None` for a cookieless (`-ac`) server.
    real: Option<Vec<u8>>,
}

impl std::fmt::Debug for X11Cookies {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("X11Cookies")
            .field("fake", &"<redacted>")
            .field("real", &self.real.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl X11Cookies {
    /// A fresh random fake cookie for the real local `real_hex` cookie, as
    /// long as the real one (16 bytes when there is none).
    ///
    /// A real cookie that is not hex is dropped with a warning: it cannot be
    /// a `MIT-MAGIC-COOKIE-1`, and the local server then decides on its own.
    pub fn generate(real_hex: Option<&str>) -> Self {
        let real = real_hex.and_then(|hex_str| match hex::decode(hex_str.trim()) {
            Ok(bytes) if !bytes.is_empty() => Some(bytes),
            _ => {
                warn!("X11 forwarding: the local xauth cookie is not hex; forwarding without it");
                None
            }
        });
        let mut fake = vec![0u8; real.as_ref().map_or(COOKIE_LEN, Vec::len)];
        rand::rngs::OsRng.fill_bytes(&mut fake);
        Self { fake, real }
    }

    /// Build from known cookies (tests).
    #[cfg(test)]
    pub(crate) fn from_parts(fake: Vec<u8>, real: Option<Vec<u8>>) -> Self {
        Self { fake, real }
    }

    /// The fake cookie as hex, as the `x11-req` request carries it.
    fn fake_hex(&self) -> String {
        hex::encode(&self.fake)
    }
}

/// Why an X11 connection setup was refused. Carries no cookie bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupRejection {
    /// The first byte is neither `B` (MSB first) nor `l` (LSB first).
    BadByteOrder,
    /// Another authorization protocol than `MIT-MAGIC-COOKIE-1` (or none).
    WrongProtocol,
    /// The cookie is not the fake one handed to the server.
    WrongCookie,
    /// The channel ended before the whole setup arrived.
    Truncated,
    /// The setup did not arrive within the setup timeout.
    TimedOut,
}

/// What [`rewrite_setup`] made of the bytes read so far.
#[derive(Debug, PartialEq, Eq)]
pub enum SetupRewrite {
    /// The setup is not complete yet; read more.
    Incomplete,
    /// Refuse the connection.
    Rejected(SetupRejection),
    /// The setup to send to the local server instead of the first `consumed`
    /// bytes; any bytes after those follow unchanged.
    Rewritten { setup: Vec<u8>, consumed: usize },
}

/// Round up to a multiple of four (X11 pads every string to 4 bytes).
fn pad4(n: usize) -> usize {
    (n + 3) & !3
}

/// Compare without an early exit on the first differing byte.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Check the X11 connection setup a remote client sent over an `x11`
/// channel and swap its fake cookie for the real local one (#5570).
///
/// The setup is `byte-order(1) unused(1) major(2) minor(2) name-len(2)
/// data-len(2) unused(2)` followed by the protocol name and the cookie, each
/// padded to four bytes; the lengths use the byte order of the first byte.
/// It must carry `MIT-MAGIC-COOKIE-1` and exactly `cookies.fake`; anything else
/// is [`SetupRewrite::Rejected`] (fail closed). The rewritten setup carries the
/// real cookie, or no authorization at all for a cookieless local server.
pub fn rewrite_setup(buf: &[u8], cookies: &X11Cookies) -> SetupRewrite {
    let Some(&order) = buf.first() else {
        return SetupRewrite::Incomplete;
    };
    let big_endian = match order {
        b'B' => true,
        b'l' => false,
        _ => return SetupRewrite::Rejected(SetupRejection::BadByteOrder),
    };
    if buf.len() < 12 {
        return SetupRewrite::Incomplete;
    }
    let read_u16 = |at: usize| {
        let bytes = [buf[at], buf[at + 1]];
        usize::from(if big_endian {
            u16::from_be_bytes(bytes)
        } else {
            u16::from_le_bytes(bytes)
        })
    };
    let name_len = read_u16(6);
    let data_len = read_u16(8);
    let data_at = 12 + pad4(name_len);
    let consumed = data_at + pad4(data_len);
    if buf.len() < consumed {
        return SetupRewrite::Incomplete;
    }
    if &buf[12..12 + name_len] != MIT_MAGIC_COOKIE_1.as_bytes() {
        return SetupRewrite::Rejected(SetupRejection::WrongProtocol);
    }
    if !constant_time_eq(&buf[data_at..data_at + data_len], &cookies.fake) {
        return SetupRewrite::Rejected(SetupRejection::WrongCookie);
    }

    let (name, data): (&[u8], &[u8]) = match &cookies.real {
        Some(real) => (MIT_MAGIC_COOKIE_1.as_bytes(), real),
        None => (&[], &[]),
    };
    // Both fit in u16: the name is a constant, and a cookie is hex-decoded
    // from an `xauth` line (a real one is 16 bytes).
    let encode = |n: usize| {
        let n = u16::try_from(n).unwrap_or(u16::MAX);
        if big_endian {
            n.to_be_bytes()
        } else {
            n.to_le_bytes()
        }
    };
    let mut setup = Vec::with_capacity(12 + pad4(name.len()) + pad4(data.len()));
    setup.extend_from_slice(&buf[..6]);
    setup.extend_from_slice(&encode(name.len()));
    setup.extend_from_slice(&encode(data.len()));
    setup.extend_from_slice(&buf[10..12]);
    setup.extend_from_slice(name);
    setup.resize(12 + pad4(name.len()), 0);
    setup.extend_from_slice(data);
    setup.resize(12 + pad4(name.len()) + pad4(data.len()), 0);
    SetupRewrite::Rewritten { setup, consumed }
}

/// Read the connection setup from `remote` and return the rewritten setup
/// plus any bytes the client sent after it.
async fn read_setup<S: AsyncRead + Unpin>(
    remote: &mut S,
    cookies: &X11Cookies,
) -> Result<(Vec<u8>, Vec<u8>), SetupRejection> {
    let mut buf = Vec::with_capacity(64);
    let mut chunk = [0u8; 4096];
    loop {
        match rewrite_setup(&buf, cookies) {
            SetupRewrite::Incomplete => {}
            SetupRewrite::Rejected(why) => return Err(why),
            SetupRewrite::Rewritten { setup, consumed } => {
                return Ok((setup, buf.split_off(consumed)));
            }
        }
        match remote.read(&mut chunk).await {
            Ok(0) | Err(_) => return Err(SetupRejection::Truncated),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

/// Serve one forwarded X11 connection: check and rewrite its setup, then
/// connect to the local X server and relay both ways until either side ends.
///
/// A refused setup closes `remote` without the local server ever being
/// contacted. Returns the refusal, if any, for the caller's log and tests.
pub async fn serve_x11_connection<S>(
    mut remote: S,
    cookies: &X11Cookies,
    local: &LocalXServerInfo,
) -> Result<(), SetupRejection>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let setup = tokio::time::timeout(SETUP_TIMEOUT, read_setup(&mut remote, cookies))
        .await
        .unwrap_or(Err(SetupRejection::TimedOut));
    let (setup, rest) = match setup {
        Ok(parts) => parts,
        Err(why) => {
            // Never the cookie: only why it was refused.
            warn!(reason = ?why, "X11 forwarding: refused a forwarded X11 connection");
            let _ = remote.shutdown().await;
            return Err(why);
        }
    };
    match &local.connection {
        #[cfg(unix)]
        LocalXConnection::UnixSocket(path) => match tokio::net::UnixStream::connect(path).await {
            Ok(local_stream) => relay(remote, local_stream, &setup, &rest).await,
            Err(e) => warn!("X11 forwarding: cannot reach the local X server at {path}: {e}"),
        },
        LocalXConnection::Tcp(host, port) => {
            match tokio::net::TcpStream::connect((host.as_str(), *port)).await {
                Ok(local_stream) => relay(remote, local_stream, &setup, &rest).await,
                Err(e) => {
                    warn!("X11 forwarding: cannot reach the local X server {host}:{port}: {e}")
                }
            }
        }
    }
    Ok(())
}

/// Send the rewritten setup and what followed it, then copy both ways.
async fn relay<R, L>(mut remote: R, mut local: L, setup: &[u8], rest: &[u8])
where
    R: AsyncRead + AsyncWrite + Unpin,
    L: AsyncRead + AsyncWrite + Unpin,
{
    if local.write_all(setup).await.is_err() || local.write_all(rest).await.is_err() {
        debug!("X11 forwarding: the local X server closed during the setup");
        return;
    }
    if let Err(e) = tokio::io::copy_bidirectional(&mut remote, &mut local).await {
        debug!("X11 forwarding: forwarded X11 connection ended with error: {e}");
    }
}

/// The `x11-req` forwarder of one session (#5570).
///
/// Holds the connection's X11 grant: while it lives, the handler accepts the
/// server's `x11` channels and hands them here. Dropping it (the session
/// ended) revokes the grant, so every later `x11` open is refused, and stops
/// the connections it is relaying. The grant also lapses once the session's
/// `alive` flag clears.
pub struct X11ReqForwarder {
    registry: ForwardedChannelRegistry,
    grant: tokio::sync::mpsc::UnboundedSender<IncomingX11>,
    stop: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl X11ReqForwarder {
    /// Hold the X11 grant on `registry` and serve each accepted `x11` channel
    /// against `local` with `cookies`, until dropped or `alive` clears.
    pub(crate) fn start(
        registry: ForwardedChannelRegistry,
        local: LocalXServerInfo,
        cookies: X11Cookies,
        alive: Arc<AtomicBool>,
    ) -> Self {
        let (grant, mut channels) = tokio::sync::mpsc::unbounded_channel::<IncomingX11>();
        registry.grant_x11(grant.clone());
        let stop = CancellationToken::new();
        let local = Arc::new(local);
        let cookies = Arc::new(cookies);
        let task_stop = stop.clone();
        let task_registry = registry.clone();
        let task_grant = grant.clone();
        let task = tokio::spawn(async move {
            loop {
                let incoming = tokio::select! {
                    biased;
                    _ = task_stop.cancelled() => break,
                    incoming = channels.recv() => incoming,
                    _ = tokio::time::sleep(ALIVE_POLL) => {
                        if alive.load(Ordering::SeqCst) {
                            continue;
                        }
                        break;
                    }
                };
                let Some(incoming) = incoming else { break };
                if !alive.load(Ordering::SeqCst) {
                    // Dropping the channel closes it.
                    break;
                }
                debug!(
                    originator = %incoming.originator_address,
                    port = incoming.originator_port,
                    "X11 forwarding: serving a forwarded X11 connection"
                );
                let local = local.clone();
                let cookies = cookies.clone();
                let stop = task_stop.clone();
                tokio::spawn(async move {
                    let stream = incoming.channel.into_stream();
                    tokio::select! {
                        _ = stop.cancelled() => {}
                        _ = serve_x11_connection(stream, &cookies, &local) => {}
                    }
                });
            }
            // Session over: refuse any later `x11` open.
            task_registry.revoke_x11(&task_grant);
            debug!("X11 forwarding: x11-req forwarder stopped");
        });
        Self {
            registry,
            grant,
            stop,
            task: Some(task),
        }
    }
}

impl Drop for X11ReqForwarder {
    fn drop(&mut self) {
        self.registry.revoke_x11(&self.grant);
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
        info!("X11 forwarding: x11-req forwarder stopped");
    }
}

/// Why the server's answer to `x11-req` means "use the fallback".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum X11ReqRefusal {
    /// The server answered `SSH_MSG_CHANNEL_FAILURE` (e.g. `X11Forwarding no`).
    Refused,
    /// No answer within [`X11_REQ_REPLY_TIMEOUT`].
    NoReply,
    /// The request could not be sent, or the channel ended.
    ChannelGone,
}

/// Ask the server for X11 forwarding on `channel` (before `shell`) and wait
/// for its answer (#5570).
///
/// On success the connection's X11 grant is held by the returned forwarder,
/// and any other channel messages read while waiting are returned for the
/// caller to process as if they had just arrived. On a refusal nothing is
/// granted: every `x11` channel stays refused and the caller falls back.
pub(crate) async fn request_x11_forwarding(
    channel: &mut russh::Channel<russh::client::Msg>,
    registry: &ForwardedChannelRegistry,
    server: &ResolvedXServer,
    alive: Arc<AtomicBool>,
    cancel: Option<&CancellationToken>,
) -> Result<(X11ReqForwarder, VecDeque<russh::ChannelMsg>), X11ReqRefusal> {
    use russh::ChannelMsg;

    let cookies = X11Cookies::generate(server.cookie.as_deref());
    if channel
        .request_x11(true, false, MIT_MAGIC_COOKIE_1, cookies.fake_hex(), 0)
        .await
        .is_err()
    {
        return Err(X11ReqRefusal::ChannelGone);
    }
    let never = CancellationToken::new();
    let cancel = cancel.unwrap_or(&never);
    let deadline = tokio::time::Instant::now() + X11_REQ_REPLY_TIMEOUT;
    let mut other = VecDeque::new();
    loop {
        let msg = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(X11ReqRefusal::ChannelGone),
            msg = tokio::time::timeout_at(deadline, channel.wait()) => msg,
        };
        match msg {
            Err(_) => return Err(X11ReqRefusal::NoReply),
            Ok(None) | Ok(Some(ChannelMsg::Eof)) | Ok(Some(ChannelMsg::Close)) => {
                return Err(X11ReqRefusal::ChannelGone)
            }
            Ok(Some(ChannelMsg::Failure)) => return Err(X11ReqRefusal::Refused),
            Ok(Some(ChannelMsg::Success)) => break,
            Ok(Some(msg)) => other.push_back(msg),
        }
    }
    let forwarder = X11ReqForwarder::start(registry.clone(), server.info.clone(), cookies, alive);
    Ok((forwarder, other))
}

#[cfg(test)]
#[path = "x11_req_tests.rs"]
mod tests;
