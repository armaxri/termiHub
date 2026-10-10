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

/// Response written to a connection refused because every slot is taken.
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
    /// See [`HEADER_READ_TIMEOUT`].
    pub header_read_timeout: Duration,
}

impl HttpLimits {
    /// The limits for `config`: its session cap (or the default) and the
    /// built-in header-read timeout.
    pub(super) fn for_config(config: &EmbeddedServerConfig) -> Self {
        Self {
            connection_cap: config.session_cap(),
            header_read_timeout: HEADER_READ_TIMEOUT,
        }
    }
}

/// Serve `router` on `listener` until `shutdown` fires, admitting at most
/// `limits.connection_cap` connections at a time (see the module docs).
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
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    let Some(permit) = admit(peer, &slots, &stats) else {
                        refuse(stream);
                        continue;
                    };
                    connections.spawn(serve_connection(
                        stream,
                        peer,
                        router.clone(),
                        limits.header_read_timeout,
                        permit,
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

/// Take a connection slot for `peer`, or record the refusal and return `None`
/// when every slot is taken.
fn admit(
    peer: SocketAddr,
    slots: &Arc<Semaphore>,
    stats: &AtomicServerStats,
) -> Option<OwnedSemaphorePermit> {
    if let Ok(permit) = Arc::clone(slots).try_acquire_owned() {
        return Some(permit);
    }
    tracing::debug!(%peer, "HTTP connection refused: too many concurrent connections");
    stats.activity.record(
        AccessRecord::new("CONNECT", "busy", false)
            .client(peer.ip().to_canonical())
            .detail("too many concurrent connections"),
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
    permit: OwnedSemaphorePermit,
    shutdown: ShutdownSignal,
) {
    let _permit = permit;
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
}
