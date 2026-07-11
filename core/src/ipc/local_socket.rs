//! Protocol-agnostic local-IPC transport: a Unix domain socket on unix and a
//! Windows named pipe on windows, behind one small bind/accept/connect API.
//!
//! The transport moves opaque byte streams — it imposes no framing — so any
//! protocol (NDJSON request/response, length-prefixed binary frames, …) can be
//! layered on top. Concrete socket/pipe types are erased behind [`BoxedReader`]
//! and [`BoxedWriter`] so consumers stay fully platform-independent.
//!
//! ```text
//!  bind(address) ─► LocalSocketListener ─► accept() ─► (BoxedReader, BoxedWriter)
//!  connect(address) ───────────────────────────────► (BoxedReader, BoxedWriter)
//! ```
//!
//! Semantics are deliberately **fail-fast one-shot**:
//! - [`connect`] tries once and returns the underlying error immediately (no
//!   retry) — suited to a "is a rendezvous instance already running?" probe.
//! - [`LocalSocketListener::bind`] only reclaims a socket path that is *stale*
//!   (present on disk but with nothing listening); if a live instance owns the
//!   endpoint, `bind` fails so the caller can treat that as "not the
//!   rendezvous". On windows this maps to `first_pipe_instance(true)`.
//!
//! Consumers that need a retrying connect or a security-hardened listener
//! (e.g. the agent session daemon) layer that policy on top rather than baking
//! it in here.

use std::io;

use tokio::io::{AsyncRead, AsyncWrite};

/// Boxed reader half of a local-IPC connection (Unix socket or named pipe).
pub type BoxedReader = Box<dyn AsyncRead + Send + Unpin>;
/// Boxed writer half of a local-IPC connection (Unix socket or named pipe).
pub type BoxedWriter = Box<dyn AsyncWrite + Send + Unpin>;

/// A listening local-IPC endpoint (Unix domain socket or Windows named pipe).
pub struct LocalSocketListener {
    _private: (),
}

impl LocalSocketListener {
    /// Bind a listener at `address`, reclaiming a stale endpoint if present.
    ///
    /// `address` is a filesystem path on unix and a `\\.\pipe\…` name on
    /// windows. Fails if a live instance already owns the endpoint.
    pub async fn bind(_address: &str) -> io::Result<Self> {
        todo!("implemented in the following commit")
    }

    /// Accept the next client connection, returning erased read/write halves.
    pub async fn accept(&mut self) -> io::Result<(BoxedReader, BoxedWriter)> {
        todo!("implemented in the following commit")
    }
}

/// Connect once to `address`, failing fast if nothing is listening.
pub async fn connect(_address: &str) -> io::Result<(BoxedReader, BoxedWriter)> {
    todo!("implemented in the following commit")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Build a unique per-process endpoint address so concurrent tests don't
    /// collide on the same socket path / pipe name.
    fn unique_address(tag: &str) -> String {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        #[cfg(unix)]
        {
            std::env::temp_dir()
                .join(format!("termihub-core-ipc-{tag}-{pid}-{n}.sock"))
                .to_string_lossy()
                .into_owned()
        }
        #[cfg(windows)]
        {
            format!(r"\\.\pipe\termihub-core-ipc-{tag}-{pid}-{n}")
        }
    }

    /// Round-trip opaque bytes through the platform transport: bind, accept on a
    /// server task, connect from the client, echo the bytes back.
    #[tokio::test]
    async fn bind_accept_connect_round_trip() {
        let address = unique_address("rt");
        let mut listener = LocalSocketListener::bind(&address).await.expect("bind");

        let server = tokio::spawn(async move {
            let (mut reader, mut writer) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 5];
            reader.read_exact(&mut buf).await.expect("server read");
            writer.write_all(&buf).await.expect("server echo");
            writer.flush().await.expect("server flush");
        });

        let (mut reader, mut writer) = connect(&address).await.expect("connect");
        writer.write_all(b"hello").await.expect("client write");
        writer.flush().await.expect("client flush");
        let mut got = [0u8; 5];
        reader.read_exact(&mut got).await.expect("client read");
        assert_eq!(&got, b"hello");

        server.await.expect("server task");
    }

    /// A second connection to the same listener must also succeed (verifies the
    /// listener stages a fresh instance after each accept on windows).
    #[tokio::test]
    async fn listener_accepts_sequential_connections() {
        let address = unique_address("seq");
        let mut listener = LocalSocketListener::bind(&address).await.expect("bind");

        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut reader, mut writer) = listener.accept().await.expect("accept");
                let mut b = [0u8; 1];
                reader.read_exact(&mut b).await.expect("server read");
                writer.write_all(&b).await.expect("server echo");
                writer.flush().await.expect("server flush");
            }
        });

        for i in 0..2u8 {
            let (mut reader, mut writer) = connect(&address).await.expect("connect");
            writer.write_all(&[i]).await.expect("client write");
            writer.flush().await.expect("client flush");
            let mut got = [0u8; 1];
            reader.read_exact(&mut got).await.expect("client read");
            assert_eq!(got[0], i);
            drop(reader);
            drop(writer);
        }

        server.await.expect("server task");
    }

    /// `connect` fails fast (does not hang/retry) when no listener is present.
    #[tokio::test]
    async fn connect_fails_fast_when_absent() {
        let address = unique_address("absent");
        let result = connect(&address).await;
        assert!(result.is_err(), "connect to a dead endpoint must error");
    }

    /// A stale unix socket file (present on disk, nothing listening) is removed
    /// so `bind` succeeds — the crashed-instance recovery path.
    #[cfg(unix)]
    #[tokio::test]
    async fn bind_reclaims_stale_unix_socket() {
        let address = unique_address("stale");

        // Bind then drop a listener: tokio does not unlink the socket file on
        // drop, so the path is left behind with nothing listening (stale).
        let first = tokio::net::UnixListener::bind(&address).expect("first bind");
        drop(first);
        assert!(
            std::path::Path::new(&address).exists(),
            "stale socket file should remain on disk"
        );

        // A fresh bind must reclaim the stale path and be usable.
        let mut listener = LocalSocketListener::bind(&address)
            .await
            .expect("bind reclaims stale socket");
        let server = tokio::spawn(async move {
            let (mut reader, mut writer) = listener.accept().await.expect("accept");
            let mut b = [0u8; 2];
            reader.read_exact(&mut b).await.expect("server read");
            writer.write_all(&b).await.expect("server echo");
            writer.flush().await.expect("server flush");
        });
        let (mut reader, mut writer) = connect(&address).await.expect("connect");
        writer.write_all(b"ok").await.expect("write");
        writer.flush().await.expect("flush");
        let mut got = [0u8; 2];
        reader.read_exact(&mut got).await.expect("read");
        assert_eq!(&got, b"ok");
        server.await.expect("server task");
    }

    /// Binding an endpoint a live instance already owns fails (the "not the
    /// rendezvous" signal), rather than stealing it.
    #[cfg(unix)]
    #[tokio::test]
    async fn bind_rejects_live_endpoint() {
        let address = unique_address("live");
        let _held = LocalSocketListener::bind(&address).await.expect("first bind");
        let second = LocalSocketListener::bind(&address).await;
        assert!(
            second.is_err(),
            "binding an endpoint owned by a live listener must fail"
        );
    }
}
