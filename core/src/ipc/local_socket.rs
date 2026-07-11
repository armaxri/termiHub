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

use tokio::io::{AsyncRead, AsyncWrite};

/// Boxed reader half of a local-IPC connection (Unix socket or named pipe).
pub type BoxedReader = Box<dyn AsyncRead + Send + Unpin>;
/// Boxed writer half of a local-IPC connection (Unix socket or named pipe).
pub type BoxedWriter = Box<dyn AsyncWrite + Send + Unpin>;

#[cfg(unix)]
pub use unix_impl::{connect, LocalSocketListener};
#[cfg(windows)]
pub use windows_impl::{connect, LocalSocketListener};

// ── Unix domain socket transport ────────────────────────────────────

#[cfg(unix)]
mod unix_impl {
    use super::{BoxedReader, BoxedWriter};
    use std::io;
    use std::path::PathBuf;
    use tokio::net::{UnixListener, UnixStream};

    /// A listening Unix domain socket.
    pub struct LocalSocketListener {
        listener: UnixListener,
    }

    impl LocalSocketListener {
        /// Bind a listener at the socket path `address`, reclaiming a stale
        /// socket file if present.
        ///
        /// "Stale" means the file exists on disk but nothing is listening: a
        /// connect probe fails, so the file is safe to remove (a crashed
        /// instance left it behind). If a *live* instance owns the path, the
        /// probe succeeds, the file is left untouched, and the subsequent
        /// `bind` fails with `AddrInUse` — the caller's "not the rendezvous"
        /// signal.
        pub async fn bind(address: &str) -> io::Result<Self> {
            let path = PathBuf::from(address);
            if path.exists() && UnixStream::connect(&path).await.is_err() {
                let _ = std::fs::remove_file(&path);
            }
            let listener = UnixListener::bind(&path)?;
            Ok(Self { listener })
        }

        /// Accept the next client connection, returning erased read/write halves.
        pub async fn accept(&mut self) -> io::Result<(BoxedReader, BoxedWriter)> {
            let (stream, _addr) = self.listener.accept().await?;
            let (reader, writer) = stream.into_split();
            Ok((Box::new(reader), Box::new(writer)))
        }
    }

    /// Connect once to a socket path, failing fast if nothing is listening.
    pub async fn connect(address: &str) -> io::Result<(BoxedReader, BoxedWriter)> {
        let (reader, writer) = UnixStream::connect(address).await?.into_split();
        Ok((Box::new(reader), Box::new(writer)))
    }
}

// ── Windows named-pipe transport ────────────────────────────────────

#[cfg(windows)]
mod windows_impl {
    use super::{BoxedReader, BoxedWriter};
    use std::io;
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

    /// A listening Windows named pipe.
    ///
    /// Named pipes serve one client per server instance, so the listener keeps
    /// the next (not-yet-connected) instance ready and stages a fresh one each
    /// time a client is accepted.
    pub struct LocalSocketListener {
        name: String,
        /// The next pipe instance, waiting for a client to connect.
        next: Option<NamedPipeServer>,
    }

    impl LocalSocketListener {
        /// Bind the first pipe instance at pipe name `address`.
        ///
        /// `first_pipe_instance(true)` fails if another instance already owns
        /// the pipe — the caller's "not the rendezvous" signal, the exact
        /// analog of the unix `AddrInUse` case.
        pub async fn bind(address: &str) -> io::Result<Self> {
            let next = ServerOptions::new()
                .first_pipe_instance(true)
                .create(address)?;
            Ok(Self {
                name: address.to_string(),
                next: Some(next),
            })
        }

        /// Accept the next client connection, returning erased read/write halves.
        pub async fn accept(&mut self) -> io::Result<(BoxedReader, BoxedWriter)> {
            let server = self
                .next
                .as_ref()
                .expect("listener always holds a pending pipe instance");
            server.connect().await?;

            // Hand off the connected instance and stage a fresh one for the
            // next client before serving this one, so no client races into a
            // missing pipe.
            let connected = self.next.take().expect("pending instance present");
            self.next = Some(ServerOptions::new().create(&self.name)?);

            let (reader, writer) = tokio::io::split(connected);
            Ok((Box::new(reader), Box::new(writer)))
        }
    }

    /// Connect once to a pipe name, failing fast if it is not present.
    pub async fn connect(address: &str) -> io::Result<(BoxedReader, BoxedWriter)> {
        let client = ClientOptions::new().open(address)?;
        let (reader, writer) = tokio::io::split(client);
        Ok((Box::new(reader), Box::new(writer)))
    }
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
