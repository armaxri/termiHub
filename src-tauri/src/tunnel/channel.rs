//! Channel-opener seam for the tunnel forwarders (test injection point, #2044).
//!
//! The local and dynamic (SOCKS5) forwarders open one SSH `direct-tcpip`
//! channel per accepted connection and relay bytes over its stream. In
//! production that stream comes from a russh channel, but [`SshSession`] is a
//! concrete `russh::client::Handle` that cannot be fabricated without a live
//! SSH server — which left the forwarders' relay and SOCKS5-handshake logic
//! untestable at the unit level (the whole data path sat at ~0% coverage).
//!
//! This trait abstracts *only* the channel-open step, so a test can inject an
//! in-memory loopback stream while production keeps using the real SSH session
//! unchanged. The public `start(config, Arc<SshSession>)` entry points are
//! preserved (they wrap the session in an [`SshChannelOpener`]), so nothing
//! outside the `tunnel` module — including `tunnel_manager` — has to change.

use std::sync::Arc;

use termihub_core::backends::ssh::handler::SshSession;
use tokio::io::{AsyncRead, AsyncWrite};

/// Opens a bidirectional byte-stream channel to a remote `host:port`.
///
/// The real implementation ([`SshChannelOpener`]) opens an SSH `direct-tcpip`
/// channel; tests supply a fake that returns an in-memory duplex stream and
/// records the requested target so address parsing can be asserted.
pub trait ChannelOpener: Send + Sync + 'static {
    /// The bidirectional byte stream a relay copies over.
    type Stream: AsyncRead + AsyncWrite + Unpin + Send + 'static;

    /// Open a channel to `host:port`, returning its byte stream.
    fn open_direct_tcpip(
        &self,
        host: String,
        port: u16,
    ) -> impl std::future::Future<Output = std::io::Result<Self::Stream>> + Send;
}

/// Production [`ChannelOpener`] backed by a shared SSH session.
///
/// Opens a russh `channel_open_direct_tcpip` channel (originator
/// `localhost:0`, matching the previous inline calls) and hands back its byte
/// stream via `into_stream()`.
pub struct SshChannelOpener {
    session: Arc<SshSession>,
}

impl SshChannelOpener {
    /// Wrap a shared SSH session as a channel opener.
    pub fn new(session: Arc<SshSession>) -> Self {
        Self { session }
    }
}

impl ChannelOpener for SshChannelOpener {
    type Stream = russh::ChannelStream<russh::client::Msg>;

    async fn open_direct_tcpip(&self, host: String, port: u16) -> std::io::Result<Self::Stream> {
        let channel = self
            .session
            .channel_open_direct_tcpip(host, port as u32, "localhost", 0)
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(channel.into_stream())
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! In-memory [`ChannelOpener`] fakes shared by the forwarder unit tests.

    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    use super::ChannelOpener;

    /// A [`ChannelOpener`] that returns an in-memory duplex stream whose far
    /// end echoes everything written to it, and records each requested target
    /// so a test can assert the forwarder's address parsing. No SSH, no
    /// sockets — fully deterministic.
    pub(crate) struct EchoChannelOpener {
        targets: Arc<Mutex<Vec<(String, u16)>>>,
        fail: bool,
    }

    impl EchoChannelOpener {
        /// An opener that succeeds and echoes.
        pub(crate) fn new() -> Self {
            Self {
                targets: Arc::new(Mutex::new(Vec::new())),
                fail: false,
            }
        }

        /// An opener that always fails to open the channel (exercises the
        /// error branch: SOCKS5 general-failure reply / local relay bail-out).
        pub(crate) fn failing() -> Self {
            Self {
                targets: Arc::new(Mutex::new(Vec::new())),
                fail: true,
            }
        }

        /// A cloneable handle to the recorded target list, so a test can read
        /// it after driving a connection through the forwarder.
        pub(crate) fn targets_handle(&self) -> Arc<Mutex<Vec<(String, u16)>>> {
            Arc::clone(&self.targets)
        }
    }

    impl ChannelOpener for EchoChannelOpener {
        type Stream = DuplexStream;

        async fn open_direct_tcpip(
            &self,
            host: String,
            port: u16,
        ) -> std::io::Result<Self::Stream> {
            self.targets
                .lock()
                .expect("targets mutex poisoned")
                .push((host, port));

            if self.fail {
                return Err(std::io::Error::other("simulated channel open failure"));
            }

            // `near` is handed to the forwarder as the "channel"; `far` is
            // echoed by a detached task, so bytes written by the forwarder come
            // straight back — proving bidirectional relay.
            let (near, mut far) = tokio::io::duplex(64 * 1024);
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match far.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if far.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
            Ok(near)
        }
    }
}
