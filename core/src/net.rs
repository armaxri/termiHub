//! Shared low-level networking helpers for TCP-based backends.
//!
//! Centralises socket tuning that must be identical across backends. The main
//! concern is **half-open connection detection**: a TCP peer that vanishes
//! silently (cable pull, NAT timeout, crashed host) never sends a FIN or RST,
//! so a plain blocking `read` waits forever and the session appears "connected"
//! indefinitely. Enabling TCP keepalive lets the OS probe the dead peer and
//! eventually fail the socket, which surfaces to the reader as an error and
//! drives the normal disconnect path (`terminal-exit` -> disconnect overlay).

use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use socket2::TcpKeepalive;

/// Idle time before the first keepalive probe is sent.
const KEEPALIVE_IDLE: Duration = Duration::from_secs(2);

/// Interval between keepalive probes once probing has started.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(2);

/// Number of unanswered probes before the connection is considered dead.
///
/// Not configurable on Windows (the platform derives the retry count from the
/// registry), so the `.with_retries` call is gated below.
#[cfg(not(target_os = "windows"))]
const KEEPALIVE_RETRIES: u32 = 1;

/// Build the shared [`TcpKeepalive`] configuration used by all TCP backends.
///
/// Mirrors the SSH transport tuning: probe after a short idle period, retry a
/// couple of times, then give up so a half-open connection is torn down
/// promptly rather than hanging.
fn keepalive_config() -> TcpKeepalive {
    let base = TcpKeepalive::new()
        .with_time(KEEPALIVE_IDLE)
        .with_interval(KEEPALIVE_INTERVAL);
    #[cfg(not(target_os = "windows"))]
    let base = base.with_retries(KEEPALIVE_RETRIES);
    base
}

/// Enable TCP keepalive on a connected socket so half-open connections are
/// detected and torn down instead of hanging forever.
///
/// Accepts anything convertible to a [`socket2::SockRef`] (e.g. a
/// [`std::net::TcpStream`] or [`tokio::net::TcpStream`]). Failure is logged and
/// swallowed: keepalive is a robustness improvement, not a hard requirement for
/// the connection to function.
pub fn enable_tcp_keepalive<'s, S>(stream: &'s S)
where
    socket2::SockRef<'s>: From<&'s S>,
{
    let ka = keepalive_config();
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
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("Failed to resolve host '{host}': {e}"),
            )
        })?
        .collect();

    if addrs.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Host '{host}' resolved to no addresses"),
        ));
    }

    let mut last_err: Option<io::Error> = None;
    for addr in addrs {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

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
}
