//! Accept loop of the embedded HTTP server with a concurrent-connection cap
//! (#4399).
//!
//! `axum::serve` (0.7) accepts every connection and offers no hook to refuse
//! one, so an unbounded number of clients could make the server hold a socket
//! and a task each. This loop admits at most [`HttpLimits::connection_cap`]
//! connections at a time: each admitted connection holds a semaphore permit
//! for its whole lifetime, and a connection arriving while every permit is
//! taken is answered with `503`, recorded in the access log as `CONNECT` /
//! `busy`, and closed without being served. Admitted connections are served by
//! hyper's HTTP/1 implementation with a header-read timeout, so an idle or
//! slow-header connection cannot hold its slot indefinitely.
//!
//! On top of the server-wide cap, one client IP may hold at most
//! [`HttpLimits::per_client_cap`] connections at a time (#4686), the same
//! sub-cap the FTP server enforces (#4398): otherwise a single client could
//! occupy every slot and lock everyone else out. A connection over its IP's
//! sub-cap is refused the same way, with a per-client detail in the log.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ConnectInfo;
use axum::http::Request;
use axum::Router;
use hyper::body::Incoming;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tower::ServiceExt as _;

use super::super::activity::AccessRecord;
use super::super::client_limits::{per_client_cap, ClientConnections, ClientSlot};
use super::super::config::{AtomicServerStats, EmbeddedServerConfig};
use super::super::shutdown::ShutdownSignal;

/// How long a connection may take to send a request's complete header block,
/// both for its first request and while idle between keep-alive requests.
pub(super) const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// How long shutdown waits for open connections to finish their in-flight
/// response before the runtime drops whatever is left.
const CONNECTION_DRAIN: Duration = Duration::from_secs(3);

/// Pause after an accept error other than a per-connection one, so a persistent
/// failure (such as running out of file descriptors) does not spin the loop.
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(100);

/// Response written to a connection refused because every slot is taken or
/// its client IP already holds its share of them.
const REFUSED_RESPONSE: &[u8] = b"HTTP/1.1 503 Service Unavailable\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Content-Length: 25\r\n\
Retry-After: 1\r\n\
Connection: close\r\n\
\r\n\
503 Too many connections\n";

/// The connection limits the accept loop enforces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct HttpLimits {
    /// Server-wide concurrent-connection cap (`max_concurrent_sessions`).
    pub connection_cap: usize,
    /// Concurrent connections one client IP may hold (#4686), derived from
    /// the cap by [`per_client_cap`].
    pub per_client_cap: usize,
    /// See [`HEADER_READ_TIMEOUT`].
    pub header_read_timeout: Duration,
}

impl HttpLimits {
    /// The limits for `config`: its session cap (or the default), the derived
    /// per-client sub-cap and the built-in header-read timeout.
    pub(super) fn for_config(config: &EmbeddedServerConfig) -> Self {
        let connection_cap = config.session_cap();
        Self {
            connection_cap,
            per_client_cap: per_client_cap(connection_cap),
            header_read_timeout: HEADER_READ_TIMEOUT,
        }
    }
}

/// Serve `router` on `listener` until `shutdown` fires, admitting at most
/// `limits.connection_cap` connections at a time, and at most
/// `limits.per_client_cap` from one client IP (see the module docs).
///
/// Each request carries the peer address as a [`ConnectInfo<SocketAddr>`]
/// extension, exactly as `into_make_service_with_connect_info` would add it.
pub(super) async fn serve(
    listener: TcpListener,
    router: Router,
    limits: HttpLimits,
    stats: Arc<AtomicServerStats>,
    shutdown: ShutdownSignal,
) {
    let slots = Arc::new(Semaphore::new(limits.connection_cap.max(1)));
    let clients = ClientConnections::new(limits.per_client_cap);
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    let Some(slot) = admit(peer, &slots, &clients, &stats) else {
                        refuse(stream);
                        continue;
                    };
                    connections.spawn(serve_connection(
                        stream,
                        peer,
                        router.clone(),
                        limits.header_read_timeout,
                        slot,
                        shutdown.clone(),
                    ));
                }
                Err(e) if is_connection_error(&e) => {
                    tracing::debug!(error = %e, "HTTP accept failed for one connection");
                }
                Err(e) => {
                    tracing::warn!(error = %e, "HTTP accept failed");
                    tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                }
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            // Event-driven: park until the signal fires, then stop accepting at
            // once — no fixed-interval poll (WA-RS-001 / CORE-001).
            _ = shutdown.wait() => {
                tracing::info!("HTTP server shutting down");
                break;
            }
        }
    }
    drop(listener);

    // Every connection watches the same signal and finishes gracefully (its
    // in-flight response, no further keep-alive requests). Give them a bounded
    // moment, then abort the rest (dropping the `JoinSet` aborts its tasks).
    let drained = tokio::time::timeout(CONNECTION_DRAIN, async {
        while connections.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        tracing::warn!("HTTP connections did not close in time; aborting them");
    }
}

/// A connection's slots: one of the server-wide cap and one of its client
/// IP's sub-cap, both held for the connection's whole lifetime.
struct ConnectionSlot {
    _global: OwnedSemaphorePermit,
    _client: ClientSlot,
}

/// Take a connection slot for `peer`, or record the refusal and return `None`
/// when every slot is taken or `peer`'s IP already holds its sub-cap.
fn admit(
    peer: SocketAddr,
    slots: &Arc<Semaphore>,
    clients: &Arc<ClientConnections>,
    stats: &AtomicServerStats,
) -> Option<ConnectionSlot> {
    let detail = match Arc::clone(slots).try_acquire_owned() {
        Ok(global) => match clients.try_acquire(peer.ip()) {
            Some(client) => {
                return Some(ConnectionSlot {
                    _global: global,
                    _client: client,
                })
            }
            None => "too many concurrent connections from this client",
        },
        Err(_) => "too many concurrent connections",
    };
    tracing::debug!(%peer, detail, "HTTP connection refused");
    stats.activity.record(
        AccessRecord::new("CONNECT", "busy", false)
            .client(peer.ip().to_canonical())
            .detail(detail),
    );
    None
}

/// Answer a refused connection with `503` and close it.
///
/// The reply is a non-blocking write on a freshly accepted socket, whose empty
/// send buffer takes it whole, so a refusal never holds up the accept loop or
/// spawns a task. tokio's `try_write` would report `WouldBlock` until the
/// reactor has seen the socket writable; the plain (still non-blocking) socket
/// writes straight away. Dropping the socket closes it.
fn refuse(stream: TcpStream) {
    if let Ok(std_stream) = stream.into_std() {
        let _ = io::Write::write(&mut &std_stream, REFUSED_RESPONSE);
    }
}

/// Serve one admitted connection, holding its slot until the connection ends.
async fn serve_connection(
    stream: TcpStream,
    peer: SocketAddr,
    router: Router,
    header_read_timeout: Duration,
    slot: ConnectionSlot,
    shutdown: ShutdownSignal,
) {
    let _slot = slot;
    let service =
        TowerToHyperService::new(router.map_request(move |mut req: Request<Incoming>| {
            req.extensions_mut().insert(ConnectInfo(peer));
            req
        }));
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(header_read_timeout);
    let connection = builder.serve_connection(TokioIo::new(stream), service);
    tokio::pin!(connection);
    tokio::select! {
        // A connection error (the client vanished, a header timeout) only ends
        // this connection; there is no one to report it to.
        _ = connection.as_mut() => return,
        _ = shutdown.wait() => connection.as_mut().graceful_shutdown(),
    }
    let _ = connection.await;
}

/// Whether an accept error concerns only the one connection being accepted
/// (it was reset or aborted before it could be accepted), so the loop can
/// accept the next one straight away.
fn is_connection_error(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refused_response_content_length_matches_its_body() {
        let text = std::str::from_utf8(REFUSED_RESPONSE).expect("ascii");
        let (head, body) = text.split_once("\r\n\r\n").expect("header/body split");
        assert!(head.starts_with("HTTP/1.1 503 "));
        assert!(head.contains(&format!("Content-Length: {}", body.len())));
    }

    /// One client IP at its sub-cap is refused with a per-client detail while
    /// another IP is still admitted, and the global cap is refused with the
    /// server-wide detail (#4686).
    #[test]
    fn admit_enforces_the_per_client_cap_before_the_global_cap() {
        let slots = Arc::new(Semaphore::new(3));
        let clients = ClientConnections::new(2);
        let stats = AtomicServerStats::new();
        let a: SocketAddr = "192.0.2.1:1000".parse().expect("addr");
        let b: SocketAddr = "192.0.2.2:1000".parse().expect("addr");
        let details = |stats: &AtomicServerStats| -> Vec<String> {
            stats
                .activity
                .snapshot(None, &stats.snapshot())
                .entries
                .into_iter()
                .filter_map(|e| e.detail)
                .collect()
        };

        let a1 = admit(a, &slots, &clients, &stats).expect("first from a");
        let a2 = admit(a, &slots, &clients, &stats).expect("second from a");
        assert!(admit(a, &slots, &clients, &stats).is_none());
        assert_eq!(
            details(&stats),
            ["too many concurrent connections from this client"]
        );
        // The refused attempt took no global slot: b still gets the third.
        let b1 = admit(b, &slots, &clients, &stats).expect("another client");
        assert!(admit(b, &slots, &clients, &stats).is_none());
        assert_eq!(
            details(&stats).last().map(String::as_str),
            Some("too many concurrent connections")
        );
        drop(a1);
        assert_eq!(clients.held(a.ip()), 1);
        drop((a2, b1));
        assert_eq!(clients.tracked(), 0);
    }
}
