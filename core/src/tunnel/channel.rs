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
//! outside the tunnel forwarders has to change.
//!
//! Lifted from the desktop into core (#2185) so the same forwarder runs on the
//! desktop or on an agent (S3, part of #2139).

use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};

use crate::backends::ssh::handler::SshSession;

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
            .map_err(open_error_to_io)?;
        Ok(channel.into_stream())
    }
}

/// Convert a russh channel-open error into an [`std::io::Error`] whose
/// [`ErrorKind`](std::io::ErrorKind) carries the SSH failure reason, so the
/// SOCKS5 forwarder can answer the client with a matching RFC 1928 reply code
/// instead of a blanket "general failure" (#4337).
pub(crate) fn open_error_to_io(err: russh::Error) -> std::io::Error {
    let kind = match &err {
        russh::Error::ChannelOpenFailure(reason) => open_failure_kind(*reason),
        _ => std::io::ErrorKind::Other,
    };
    std::io::Error::new(kind, err.to_string())
}

/// Classify an SSH `SSH_MSG_CHANNEL_OPEN_FAILURE` reason code (RFC 4254 §5.1).
///
/// The SSH server reports only these four coarse reasons. Its free-text
/// description (e.g. "Connection refused") is not part of russh's error, so
/// `SSH_OPEN_CONNECT_FAILED` — which covers refused, unreachable and DNS
/// failures alike — maps to the generic "host unreachable".
pub(crate) fn open_failure_kind(reason: russh::ChannelOpenFailure) -> std::io::ErrorKind {
    use russh::ChannelOpenFailure as F;
    match reason {
        F::AdministrativelyProhibited => std::io::ErrorKind::PermissionDenied,
        F::ConnectFailed => std::io::ErrorKind::HostUnreachable,
        F::UnknownChannelType => std::io::ErrorKind::Unsupported,
        F::ResourceShortage | F::Unknown => std::io::ErrorKind::Other,
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
        fail: Option<std::io::ErrorKind>,
    }

    impl EchoChannelOpener {
        /// An opener that succeeds and echoes.
        pub(crate) fn new() -> Self {
            Self {
                targets: Arc::new(Mutex::new(Vec::new())),
                fail: None,
            }
        }

        /// An opener that always fails to open the channel (exercises the
        /// error branch: SOCKS5 general-failure reply / local relay bail-out).
        pub(crate) fn failing() -> Self {
            Self::failing_with(std::io::ErrorKind::Other)
        }

        /// An opener whose channel open always fails with an error of `kind`,
        /// mimicking how [`super::SshChannelOpener`] classifies an SSH
        /// channel-open failure (#4337).
        pub(crate) fn failing_with(kind: std::io::ErrorKind) -> Self {
            Self {
                targets: Arc::new(Mutex::new(Vec::new())),
                fail: Some(kind),
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

            if let Some(kind) = self.fail {
                return Err(std::io::Error::new(kind, "simulated channel open failure"));
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

    /// A [`ChannelOpener`] that opens a channel and then **holds it open**: the
    /// returned `near` stream is the relay's channel side, and the far end is
    /// parked in a shared list so it never EOFs. This keeps the relay's
    /// `copy_bidirectional` pending — and therefore its concurrency permit held
    /// — until the test explicitly ends it by clearing the far-ends handle,
    /// which lets a test drive the concurrency cap deterministically (CORE-027).
    pub(crate) struct HoldingChannelOpener {
        opens: Arc<std::sync::atomic::AtomicUsize>,
        fars: Arc<Mutex<Vec<DuplexStream>>>,
    }

    impl HoldingChannelOpener {
        pub(crate) fn new() -> Self {
            Self {
                opens: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                fars: Arc::new(Mutex::new(Vec::new())),
            }
        }

        /// A cloneable handle to the count of channels opened so far, so a test
        /// can wait until a relay has actually opened its channel (i.e. holds a
        /// permit) before probing the cap.
        pub(crate) fn opens(&self) -> Arc<std::sync::atomic::AtomicUsize> {
            Arc::clone(&self.opens)
        }

        /// A cloneable handle to the parked far ends. Clearing it (`.lock()…
        /// .clear()`) drops every held far end, sending EOF into each relay's
        /// channel side so the relays can finish and release their permits —
        /// usable after the opener itself has been moved into a forwarder.
        pub(crate) fn fars_handle(&self) -> Arc<Mutex<Vec<DuplexStream>>> {
            Arc::clone(&self.fars)
        }
    }

    impl ChannelOpener for HoldingChannelOpener {
        type Stream = DuplexStream;

        async fn open_direct_tcpip(
            &self,
            _host: String,
            _port: u16,
        ) -> std::io::Result<Self::Stream> {
            let (near, far) = tokio::io::duplex(64 * 1024);
            self.fars.lock().expect("fars mutex poisoned").push(far);
            self.opens.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(near)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;

    use russh::ChannelOpenFailure;

    use super::{open_error_to_io, open_failure_kind};

    #[test]
    fn administratively_prohibited_maps_to_permission_denied() {
        assert_eq!(
            open_failure_kind(ChannelOpenFailure::AdministrativelyProhibited),
            ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn connect_failed_maps_to_host_unreachable() {
        assert_eq!(
            open_failure_kind(ChannelOpenFailure::ConnectFailed),
            ErrorKind::HostUnreachable
        );
    }

    #[test]
    fn unknown_channel_type_maps_to_unsupported() {
        assert_eq!(
            open_failure_kind(ChannelOpenFailure::UnknownChannelType),
            ErrorKind::Unsupported
        );
    }

    #[test]
    fn resource_shortage_and_unknown_map_to_other() {
        assert_eq!(
            open_failure_kind(ChannelOpenFailure::ResourceShortage),
            ErrorKind::Other
        );
        assert_eq!(
            open_failure_kind(ChannelOpenFailure::Unknown),
            ErrorKind::Other
        );
    }

    #[test]
    fn russh_open_failure_error_keeps_its_reason() {
        let err = open_error_to_io(russh::Error::ChannelOpenFailure(
            ChannelOpenFailure::AdministrativelyProhibited,
        ));
        assert_eq!(err.kind(), ErrorKind::PermissionDenied);
    }

    #[test]
    fn other_russh_errors_are_general_failures() {
        let err = open_error_to_io(russh::Error::Disconnect);
        assert_eq!(err.kind(), ErrorKind::Other);
    }
}
