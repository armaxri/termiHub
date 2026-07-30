//! Channel-opener seam for the tunnel forwarders.
//!
//! Lifted into core (#2185) so the same forwarders run on the desktop or on an
//! agent (S3, part of #2139). This module re-exports the core trait and the
//! production [`SshChannelOpener`] so existing desktop call sites
//! (`super::channel::…`) are unchanged. The still-desktop-only dynamic (`-D`)
//! and remote (`-R`) forwarders keep using it.

pub use termihub_core::tunnel::channel::{ChannelOpener, SshChannelOpener};

#[cfg(test)]
pub(crate) mod test_support {
    //! In-memory [`ChannelOpener`] fake for the desktop forwarder unit tests
    //! (the dynamic/remote engines still live in this crate). The core local
    //! forwarder has its own copy behind `cfg(test)` — a tiny, deterministic
    //! test fake is cheaper duplicated than exposed across a crate boundary.

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
