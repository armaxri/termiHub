//! Shared low-level networking helpers for TCP-based backends.
//!
//! Centralises socket tuning that must be identical across backends. The main
//! concern is **half-open connection detection**: a TCP peer that vanishes
//! silently (cable pull, NAT timeout, crashed host) never sends a FIN or RST,
//! so a plain blocking `read` waits forever and the session appears "connected"
//! indefinitely. Enabling TCP keepalive lets the OS probe the dead peer and
//! eventually fail the socket, which surfaces to the reader as an error and
//! drives the normal disconnect path (`terminal-exit` -> disconnect overlay).

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

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
}
