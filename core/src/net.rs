//! Shared low-level networking helpers for TCP-based backends.
//!
//! Centralises socket tuning that must be identical across backends. The main
//! concern is **half-open connection detection**: a TCP peer that vanishes
//! silently (cable pull, NAT timeout, crashed host) never sends a FIN or RST,
//! so a plain blocking `read` waits forever and the session appears "connected"
//! indefinitely. Enabling TCP keepalive lets the OS probe the dead peer and
//! eventually fail the socket, which surfaces to the reader as an error and
//! drives the normal disconnect path (`terminal-exit` -> disconnect overlay).
//!
//! # Per-backend liveness/keepalive policy (PARITY-012)
//!
//! Liveness detection is deliberately **not** identical across every backend —
//! different transports need different mechanisms — but the shared surface and
//! defaults live here so the policy is consistent and discoverable:
//!
//! - **Telnet** and **SSH** (raw TCP stream transports): OS-level TCP keepalive
//!   via [`TcpKeepalivePolicy`] / [`enable_tcp_keepalive`]. A dead peer is torn
//!   down by the kernel and surfaces as a read error.
//! - **FTP**: an application-level periodic `NOOP` on the control connection
//!   (`FtpConfig::keep_alive_secs`, default 60 s) rather than TCP keepalive —
//!   idle FTP control connections are commonly dropped by servers, so a
//!   protocol-level probe is required.
//! - **Serial / local shell / Docker / WSL**: no network liveness probe applies
//!   (no remote TCP peer to detect).

use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use socket2::TcpKeepalive;

use crate::errors::{ConnectFailureKind, SessionError};

/// Shared TCP keepalive/liveness policy for raw-TCP stream backends.
///
/// The single source of truth for the socket-level keepalive tuning applied by
/// every backend that owns a raw TCP stream — currently the **telnet** and
/// **SSH** transports, which both call [`enable_tcp_keepalive`] on their
/// connected socket. Probe after a short idle period, retry a couple of times,
/// then give up so a half-open connection is torn down promptly rather than
/// hanging. See the module docs for the per-backend mechanism map.
pub struct TcpKeepalivePolicy;

impl TcpKeepalivePolicy {
    /// Idle time before the first keepalive probe is sent.
    pub const IDLE: Duration = Duration::from_secs(2);

    /// Interval between keepalive probes once probing has started.
    pub const INTERVAL: Duration = Duration::from_secs(2);

    /// Number of unanswered probes before the connection is considered dead.
    ///
    /// Not configurable on Windows (the platform derives the retry count from
    /// the registry), so the `.with_retries` call is gated accordingly.
    #[cfg(not(target_os = "windows"))]
    pub const RETRIES: u32 = 1;

    /// Build the [`socket2::TcpKeepalive`] configuration for this policy.
    fn to_socket2() -> TcpKeepalive {
        let base = TcpKeepalive::new()
            .with_time(Self::IDLE)
            .with_interval(Self::INTERVAL);
        #[cfg(not(target_os = "windows"))]
        let base = base.with_retries(Self::RETRIES);
        base
    }
}

/// Enable TCP keepalive on a connected socket so half-open connections are
/// detected and torn down instead of hanging forever.
///
/// Applies the shared [`TcpKeepalivePolicy`]. Accepts anything convertible to a
/// [`socket2::SockRef`] (e.g. a [`std::net::TcpStream`] or
/// [`tokio::net::TcpStream`]). Failure is logged and swallowed: keepalive is a
/// robustness improvement, not a hard requirement for the connection to
/// function.
pub fn enable_tcp_keepalive<'s, S>(stream: &'s S)
where
    socket2::SockRef<'s>: From<&'s S>,
{
    let ka = TcpKeepalivePolicy::to_socket2();
    if let Err(e) = socket2::SockRef::from(stream).set_tcp_keepalive(&ka) {
        tracing::warn!("TCP keepalive setup failed: {e}");
    }
}

/// Resolve `host:port` via DNS and open a blocking TCP connection, applying
/// `timeout` to each resolved address in turn.
///
/// [`TcpStream::connect_timeout`] requires an already-resolved
/// [`SocketAddr`](std::net::SocketAddr) and `str::parse::<SocketAddr>` only
/// accepts numeric IP literals — so connecting to a hostname (`router.local`,
/// `bbs.example.com`) needs an explicit DNS step first. `(host, port)`
/// implements [`ToSocketAddrs`], which performs that resolution (handling both
/// hostnames and bare IPs), yielding one or more candidate addresses (e.g. IPv4
/// and IPv6). Each is tried in order with the given `timeout`; the first
/// successful connection wins. Resolution failure and exhausted-candidate
/// failure both surface as a clean [`io::Error`] rather than a panic.
pub fn connect_timeout_resolved(host: &str, port: u16, timeout: Duration) -> io::Result<TcpStream> {
    connect_timeout_resolved_reporting(host, port, timeout, |_| {})
}

/// [`connect_timeout_resolved`], calling `on_connecting` with each candidate
/// address right before its TCP connect is attempted — so a caller can report
/// the resolve → connect transition (#5068).
pub fn connect_timeout_resolved_reporting(
    host: &str,
    port: u16,
    timeout: Duration,
    mut on_connecting: impl FnMut(&std::net::SocketAddr),
) -> io::Result<TcpStream> {
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| {
            io::Error::new(
                io::ErrorKind::NotFound,
                DnsResolveError(format!("Failed to resolve host '{host}': {e}")),
            )
        })?
        .collect();

    if addrs.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            DnsResolveError(format!("Host '{host}' resolved to no addresses")),
        ));
    }

    let mut last_err: Option<io::Error> = None;
    for addr in addrs {
        on_connecting(&addr);
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => return Ok(stream),
            Err(e) => last_err = Some(e),
        }
    }

    Err(last_err.unwrap_or_else(|| {
        io::Error::other(format!(
            "Could not connect to any address for host '{host}'"
        ))
    }))
}

/// Payload of the [`io::Error`] that [`connect_timeout_resolved`] returns when
/// the host name could not be resolved, so [`classify_connect_error`] can tell
/// a DNS failure apart structurally — the error kind alone (`NotFound`) is not
/// specific, and the message text is OS-localized (#5183).
#[derive(Debug)]
struct DnsResolveError(String);

impl std::fmt::Display for DnsResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DnsResolveError {}

/// Winsock error codes, for the raw-code fallback of
/// [`classify_connect_error`]. Values from `winerror.h`.
#[cfg(windows)]
mod wsa {
    pub const ENETDOWN: i32 = 10050;
    pub const ENETUNREACH: i32 = 10051;
    pub const ETIMEDOUT: i32 = 10060;
    pub const ECONNREFUSED: i32 = 10061;
    pub const EHOSTDOWN: i32 = 10064;
    pub const EHOSTUNREACH: i32 = 10065;
    pub const HOST_NOT_FOUND: i32 = 11001;
    pub const TRY_AGAIN: i32 = 11002;
    pub const NO_RECOVERY: i32 = 11003;
    pub const NO_DATA: i32 = 11004;
}

/// Classify a TCP connect / name-resolution [`io::Error`] into a typed,
/// locale-independent [`ConnectFailureKind`] (#5183), or `None` when it is
/// none of the curated categories.
///
/// Decided from the [`io::ErrorKind`] first — the standard library already maps
/// `ECONNREFUSED` / `WSAECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH` and the
/// timeouts on every platform — then from the raw OS error code for the codes
/// it leaves uncategorized (`EHOSTDOWN`, `ENETDOWN`, the Winsock resolver
/// codes). Never from the message text, which the OS localizes.
pub fn classify_connect_error(err: &io::Error) -> Option<ConnectFailureKind> {
    if err
        .get_ref()
        .is_some_and(|inner| inner.is::<DnsResolveError>())
    {
        return Some(ConnectFailureKind::Dns);
    }
    match err.kind() {
        io::ErrorKind::ConnectionRefused => return Some(ConnectFailureKind::Refused),
        io::ErrorKind::TimedOut => return Some(ConnectFailureKind::Timeout),
        io::ErrorKind::HostUnreachable | io::ErrorKind::NetworkUnreachable => {
            return Some(ConnectFailureKind::Unreachable)
        }
        _ => {}
    }
    classify_raw_os_error(err.raw_os_error()?)
}

/// The raw-code fallback of [`classify_connect_error`] on Unix.
#[cfg(unix)]
fn classify_raw_os_error(code: i32) -> Option<ConnectFailureKind> {
    match code {
        libc::ECONNREFUSED => Some(ConnectFailureKind::Refused),
        libc::ETIMEDOUT => Some(ConnectFailureKind::Timeout),
        libc::EHOSTUNREACH | libc::ENETUNREACH | libc::EHOSTDOWN | libc::ENETDOWN => {
            Some(ConnectFailureKind::Unreachable)
        }
        _ => None,
    }
}

/// The raw-code fallback of [`classify_connect_error`] on Windows (Winsock).
#[cfg(windows)]
fn classify_raw_os_error(code: i32) -> Option<ConnectFailureKind> {
    match code {
        wsa::ECONNREFUSED => Some(ConnectFailureKind::Refused),
        wsa::ETIMEDOUT => Some(ConnectFailureKind::Timeout),
        wsa::EHOSTUNREACH | wsa::ENETUNREACH | wsa::EHOSTDOWN | wsa::ENETDOWN => {
            Some(ConnectFailureKind::Unreachable)
        }
        wsa::HOST_NOT_FOUND | wsa::TRY_AGAIN | wsa::NO_RECOVERY | wsa::NO_DATA => {
            Some(ConnectFailureKind::Dns)
        }
        _ => None,
    }
}

/// No raw-code table on other targets: the [`io::ErrorKind`] mapping applies.
#[cfg(not(any(unix, windows)))]
fn classify_raw_os_error(_code: i32) -> Option<ConnectFailureKind> {
    None
}

/// The [`SessionError`] for a failed TCP connect to `host:port` (#5183): a
/// [`SessionError::Classified`] carrying the [`classify_connect_error`] kind,
/// whose message names the target and keeps the OS detail, or `fallback(err)`
/// when the error is none of the curated kinds.
pub fn connect_failure(
    host: &str,
    port: u16,
    err: &io::Error,
    fallback: impl FnOnce(&io::Error) -> SessionError,
) -> SessionError {
    match classify_connect_error(err) {
        // A resolver error already names the host (`Failed to resolve host …`).
        Some(ConnectFailureKind::Dns) => {
            SessionError::classified(ConnectFailureKind::Dns, err.to_string())
        }
        Some(kind) => SessionError::classified(kind, format!("{host}:{port}: {err}")),
        None => fallback(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// The shared policy exposes the documented liveness defaults (PARITY-012).
    #[test]
    fn tcp_keepalive_policy_has_expected_defaults() {
        assert_eq!(TcpKeepalivePolicy::IDLE, Duration::from_secs(2));
        assert_eq!(TcpKeepalivePolicy::INTERVAL, Duration::from_secs(2));
        #[cfg(not(target_os = "windows"))]
        assert_eq!(TcpKeepalivePolicy::RETRIES, 1);
    }

    /// A connected socket has keepalive enabled after calling the helper.
    #[test]
    fn enable_tcp_keepalive_turns_keepalive_on() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        let stream = TcpStream::connect(addr).expect("connect");
        let _peer = listener.accept().expect("accept");

        // Sanity: a freshly connected socket has keepalive off by default.
        let before = socket2::SockRef::from(&stream)
            .keepalive()
            .expect("read keepalive");
        assert!(!before, "expected keepalive off before enabling");

        enable_tcp_keepalive(&stream);

        let after = socket2::SockRef::from(&stream)
            .keepalive()
            .expect("read keepalive");
        assert!(after, "expected keepalive on after enabling");
    }

    /// Connecting by **hostname** succeeds — the helper resolves `localhost`
    /// via DNS before connecting, which the old `str::parse::<SocketAddr>`
    /// shortcut could not do (it only accepted numeric IP literals).
    #[test]
    fn connect_timeout_resolved_connects_by_hostname() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("local_addr").port();

        let stream = connect_timeout_resolved("localhost", port, Duration::from_secs(5))
            .expect("hostname connect should resolve and succeed");
        let _peer = listener.accept().expect("accept");

        // The connection landed on the loopback address the listener is bound to.
        assert!(stream.peer_addr().expect("peer_addr").ip().is_loopback());
    }

    /// A bare IP literal still works (resolution is a no-op passthrough).
    #[test]
    fn connect_timeout_resolved_connects_by_ip() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("local_addr").port();

        let stream = connect_timeout_resolved("127.0.0.1", port, Duration::from_secs(5))
            .expect("ip connect should succeed");
        let _peer = listener.accept().expect("accept");
        assert_eq!(stream.peer_addr().expect("peer_addr").port(), port);
    }

    /// An unresolvable hostname returns a clean `NotFound` error, never a panic.
    #[test]
    fn connect_timeout_resolved_reports_unresolvable_host() {
        let err = connect_timeout_resolved(
            "nonexistent.host.invalid.termihub.test",
            23,
            Duration::from_secs(2),
        )
        .expect_err("an unresolvable host must error, not connect");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    /// The `io::ErrorKind`s std maps the connect errnos to on every platform
    /// classify as their typed kind; anything else stays unclassified (#5183).
    #[test]
    fn classify_connect_error_maps_error_kinds() {
        use ConnectFailureKind as K;
        let kind = |k: io::ErrorKind| classify_connect_error(&io::Error::from(k));
        assert_eq!(kind(io::ErrorKind::ConnectionRefused), Some(K::Refused));
        assert_eq!(kind(io::ErrorKind::TimedOut), Some(K::Timeout));
        assert_eq!(kind(io::ErrorKind::HostUnreachable), Some(K::Unreachable));
        assert_eq!(
            kind(io::ErrorKind::NetworkUnreachable),
            Some(K::Unreachable)
        );
        assert_eq!(kind(io::ErrorKind::ConnectionReset), None);
        assert_eq!(kind(io::ErrorKind::Other), None);
        // A NotFound that is not a resolver failure is not a DNS error.
        assert_eq!(kind(io::ErrorKind::NotFound), None);
    }

    /// Raw Unix errnos classify the same, including the ones std leaves
    /// uncategorized (`EHOSTDOWN`, `ENETDOWN`).
    #[cfg(unix)]
    #[test]
    fn classify_connect_error_maps_unix_errnos() {
        use ConnectFailureKind as K;
        let raw = |c: i32| classify_connect_error(&io::Error::from_raw_os_error(c));
        assert_eq!(raw(libc::ECONNREFUSED), Some(K::Refused));
        assert_eq!(raw(libc::ETIMEDOUT), Some(K::Timeout));
        assert_eq!(raw(libc::EHOSTUNREACH), Some(K::Unreachable));
        assert_eq!(raw(libc::ENETUNREACH), Some(K::Unreachable));
        assert_eq!(raw(libc::EHOSTDOWN), Some(K::Unreachable));
        assert_eq!(raw(libc::ENETDOWN), Some(K::Unreachable));
        assert_eq!(raw(libc::EACCES), None);
    }

    /// Winsock codes classify the same, and the resolver codes are DNS.
    #[cfg(windows)]
    #[test]
    fn classify_connect_error_maps_winsock_codes() {
        use ConnectFailureKind as K;
        let raw = |c: i32| classify_connect_error(&io::Error::from_raw_os_error(c));
        assert_eq!(raw(wsa::ECONNREFUSED), Some(K::Refused));
        assert_eq!(raw(wsa::ETIMEDOUT), Some(K::Timeout));
        assert_eq!(raw(wsa::EHOSTUNREACH), Some(K::Unreachable));
        assert_eq!(raw(wsa::ENETUNREACH), Some(K::Unreachable));
        assert_eq!(raw(wsa::EHOSTDOWN), Some(K::Unreachable));
        assert_eq!(raw(wsa::ENETDOWN), Some(K::Unreachable));
        assert_eq!(raw(wsa::HOST_NOT_FOUND), Some(K::Dns));
        assert_eq!(raw(wsa::NO_DATA), Some(K::Dns));
        assert_eq!(raw(wsa::TRY_AGAIN), Some(K::Dns));
    }

    /// A connect to a closed local port is a typed `Refused` failure whose
    /// message names the target once, with no stacked `failed:` prefixes.
    #[test]
    fn connect_to_closed_port_is_classified_refused() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("local_addr").port();
        drop(listener);

        let err = connect_timeout_resolved("127.0.0.1", port, Duration::from_secs(5))
            .expect_err("nothing listens on a just-closed port");
        assert_eq!(
            classify_connect_error(&err),
            Some(ConnectFailureKind::Refused)
        );
        let session = connect_failure("127.0.0.1", port, &err, |_| unreachable!());
        assert_eq!(
            session.connect_failure_kind(),
            Some(ConnectFailureKind::Refused)
        );
        let SessionError::Classified { message, .. } = &session else {
            panic!("expected a classified error, got {session:?}");
        };
        assert!(
            message.starts_with(&format!("127.0.0.1:{port}: ")),
            "{message}"
        );
        assert!(!message.to_lowercase().contains("failed:"), "{message}");
    }

    /// An unresolvable host name classifies as `Dns` structurally (the
    /// resolver error's payload type), whatever the localized message says.
    #[test]
    fn unresolvable_host_is_classified_dns() {
        let err = connect_timeout_resolved(
            "nonexistent.host.invalid.termihub.test",
            23,
            Duration::from_secs(2),
        )
        .expect_err("an unresolvable host must error");
        assert_eq!(classify_connect_error(&err), Some(ConnectFailureKind::Dns));
        let session = connect_failure(
            "nonexistent.host.invalid.termihub.test",
            23,
            &err,
            |_| unreachable!(),
        );
        assert_eq!(
            session.connect_failure_kind(),
            Some(ConnectFailureKind::Dns)
        );
    }

    /// An error outside the curated kinds takes the caller's fallback.
    #[test]
    fn unclassified_connect_error_uses_the_fallback() {
        let err = io::Error::from(io::ErrorKind::ConnectionReset);
        let session = connect_failure("h", 1, &err, |e| SessionError::SpawnFailed(e.to_string()));
        assert!(matches!(session, SessionError::SpawnFailed(_)));
    }
}
