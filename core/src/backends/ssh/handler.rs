//! russh client handler and session type for termiHub.
//!
//! Defines [`TermiHubHandler`] — the russh [`Handler`](russh::client::Handler)
//! implementation — and the [`SshSession`] / [`ForwardedChannelRegistry`] types
//! used throughout the SSH subsystem.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc::UnboundedSender;
use tracing::debug;

/// Convenience alias for the connected session handle.
///
/// `Handle` is cheaply `Clone + Send + Sync` — share it freely.
pub type SshSession = russh::client::Handle<TermiHubHandler>;

/// An incoming forwarded channel from the SSH server (remote-port-forward / X11).
pub struct IncomingChannel {
    pub channel: russh::Channel<russh::client::Msg>,
    pub connected_address: String,
    pub connected_port: u32,
}

/// Registry that routes incoming forwarded channels to the right listener.
///
/// Keyed by the bound port on the SSH server (as returned by
/// [`SshSession::tcpip_forward`]). The value is a sender whose receiver
/// is owned by the corresponding [`RemoteForwarder`] or X11 event loop.
pub type ForwardedChannelRegistry = Arc<Mutex<HashMap<u32, UnboundedSender<IncomingChannel>>>>;

/// termiHub's russh client handler.
///
/// One instance is created per connection (passed to `russh::client::connect`).
/// Forwarded-channel notifications are routed via [`ForwardedChannelRegistry`].
pub struct TermiHubHandler {
    pub forwarded_channel_registry: ForwardedChannelRegistry,
}

impl TermiHubHandler {
    /// Create a new handler together with the shared channel registry.
    pub fn new() -> (Self, ForwardedChannelRegistry) {
        let registry: ForwardedChannelRegistry = Arc::new(Mutex::new(HashMap::new()));
        let handler = Self {
            forwarded_channel_registry: registry.clone(),
        };
        (handler, registry)
    }
}

impl Default for TermiHubHandler {
    fn default() -> Self {
        Self::new().0
    }
}

#[async_trait::async_trait]
impl russh::client::Handler for TermiHubHandler {
    type Error = russh::Error;

    /// Accept the server's host key without verification.
    ///
    /// # Security note
    /// Proper host-key verification (known-hosts file check) should be
    /// implemented in a follow-up issue. For now we accept all keys to
    /// maintain the same behaviour as the previous libssh2 implementation,
    /// which also did not verify host keys.
    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    /// Route an incoming server-initiated forwarded channel to the registered
    /// listener for `connected_port` (remote port forwarding / X11 hack).
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        debug!(
            connected_address,
            connected_port, "Incoming forwarded-tcpip channel"
        );
        if let Ok(registry) = self.forwarded_channel_registry.lock() {
            if let Some(tx) = registry.get(&connected_port) {
                let _ = tx.send(IncomingChannel {
                    channel,
                    connected_address: connected_address.to_string(),
                    connected_port,
                });
            }
        }
        Ok(())
    }
}
