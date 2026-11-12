//! russh client handler and session type for termiHub.
//!
//! Defines [`TermiHubHandler`] — the russh [`Handler`](russh::client::Handler)
//! implementation — and the [`SshSession`] / [`ForwardedChannelRegistry`] types
//! used throughout the SSH subsystem.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tracing::debug;

use super::host_key::{HostKeyDecision, HostKeyVerifier, HOST_KEY_PROMPT_TIMEOUT};
use super::prompt_clock::PromptClock;

/// Convenience alias for the connected session handle.
///
/// In russh 0.65 `Handle` is **not** `Clone` (it owns the session task's join
/// handle and reply receiver); share it via `Arc<SshSession>`, as the pooled
/// endpoint / gateway sessions do.
pub type SshSession = russh::client::Handle<TermiHubHandler>;

/// A watch on an SSH session's liveness (#1297).
///
/// Resolves once the session's russh background task has ended — a transport
/// failure, a peer `SSH_MSG_DISCONNECT`, or keepalive exhaustion (configured at
/// 30 s × 3 in `auth.rs`). Event-driven: [`TermiHubHandler`] fires it from russh's
/// `disconnected` callback; and because the handler owns the sender, the sender
/// dropping with the handler (when the session task ends) closes the channel as a
/// backstop. Either way the tunnel supervisor observes true session death without
/// polling a throwaway channel every ~20 s. `Clone` fans one shared pooled session
/// out to every tunnel supervising it.
///
/// It also carries the server's SSH identification string (#5134), which the
/// same handler records when the first key exchange completes: the connector
/// reads it to tell a Win32-OpenSSH host before it asks for the login shell.
#[derive(Clone)]
pub struct LivenessWatch {
    rx: watch::Receiver<bool>,
    server_id: Arc<OnceLock<String>>,
}

impl LivenessWatch {
    /// Resolve once the session is dead. Returns immediately if it already died.
    ///
    /// `true` means dead — the handler flips it on disconnect. A dropped sender
    /// (the handler was dropped without an explicit `disconnected`, e.g. the last
    /// handle went away) makes `wait_for` return `Err` and is likewise treated as
    /// death, so the watch never hangs a supervisor on a vanished session.
    pub async fn dead(&mut self) {
        let _ = self.rx.wait_for(|&dead| dead).await;
    }

    /// Synchronously report whether the session is already dead.
    ///
    /// `true` when the handler flipped the flag on disconnect, **or** when the
    /// watch channel is closed (the sender dropped with the handler at session
    /// task end) — both mean the session is gone. Lets the endpoint pool skip a
    /// dead cached session instead of handing it out (#1315).
    pub fn is_dead(&self) -> bool {
        *self.rx.borrow() || self.rx.has_changed().is_err()
    }

    /// The server's SSH identification line (`SSH-2.0-OpenSSH_for_Windows_9.5`,
    /// say), once the first key exchange has completed; `None` before (#5134).
    pub fn server_id(&self) -> Option<&str> {
        self.server_id.get().map(String::as_str)
    }
}

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
/// is owned by the corresponding `RemoteForwarder` or X11 event loop.
pub type ForwardedChannelRegistry = Arc<Mutex<HashMap<u32, UnboundedSender<IncomingChannel>>>>;

/// Why the handshake refused the server's host key (#5185), recorded by the
/// handler (on russh's session task) for the connecting task to classify.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostKeyRefusal {
    /// Not trusted, and nobody was asked: an unattended connect (#3527) or the
    /// strict headless default policy.
    NotTrusted,
    /// The user was shown the trust prompt and rejected the key.
    RejectedByUser,
    /// The trust prompt was left unanswered for
    /// [`HOST_KEY_PROMPT_TIMEOUT`].
    PromptTimedOut,
    /// The connect was aborted or timed out while the prompt was open; the
    /// prompt was dismissed and any later answer is ignored.
    Abandoned,
}

/// The slot the handler records a [`HostKeyRefusal`] in.
pub(crate) type HostKeyOutcome = Arc<Mutex<Option<HostKeyRefusal>>>;

/// What the connecting task hands the handler for the host-key check (#5185).
///
/// `check_server_key` runs on russh's spawned session task, which can see
/// neither the connecting task's unattended scope, its connect deadline nor its
/// prompt owner, nor notice that the connecting task gave up. This carries them
/// across.
#[derive(Clone, Default)]
pub(crate) struct HandshakeContext {
    /// Unattended (#3527): verify without prompting.
    pub unattended: bool,
    /// Where a refusal is recorded.
    pub outcome: HostKeyOutcome,
    /// The connect deadline, paused while the trust prompt is open.
    pub clock: PromptClock,
    /// The owner of the connect (#5243): the trust prompt carries it so the
    /// frontend pauses that tab's own connect deadline while it is open.
    pub owner: Option<String>,
    /// Cancelled when the connecting task stops waiting for the handshake
    /// (abort, connect timeout): the open prompt is then dropped — dismissed.
    pub abandoned: CancellationToken,
    /// A verifier to use instead of the process-wide one (tests only; the
    /// global verifier is set-once per process).
    pub verifier: Option<Arc<dyn HostKeyVerifier>>,
}

/// termiHub's russh client handler.
///
/// One instance is created per connection (passed to `russh::client::connect`).
/// Forwarded-channel notifications are routed via [`ForwardedChannelRegistry`].
pub struct TermiHubHandler {
    pub forwarded_channel_registry: ForwardedChannelRegistry,
    /// Fires the session-liveness watch (`true` = dead) when the session dies
    /// (#1297). Lives in the handler — which russh owns inside the session's
    /// background task — so `disconnected` signals explicitly, and the sender
    /// dropping with the handler (task end) closes the channel as a backstop.
    liveness_tx: watch::Sender<bool>,
    /// Whether this connection opted into SSH agent forwarding (#1699). Only when
    /// `true` does [`server_channel_open_agent_forward`](Self::server_channel_open_agent_forward)
    /// bridge an incoming `auth-agent@openssh.com` channel to the local agent; a
    /// forwarding channel that arrives without our opt-in is rejected, so a server
    /// cannot reach the local agent unsolicited.
    forward_agent: bool,
    /// The host this connection targets, used to key host-key verification
    /// (#1959). For a jump-host hop it is the hop/target of *that* leg, so each
    /// hop's key is verified against the right host.
    host: String,
    /// The TCP port this connection targets, paired with `host` for host-key
    /// verification (#1959).
    port: u16,
    /// The connecting task's context for the host-key check (#3527, #5185):
    /// unattended mode, the refusal slot, the pausable connect deadline, the
    /// prompt owner (#5243) and the abandon signal. The check runs on russh's session task, which cannot see
    /// the connecting task, so the handler carries them.
    handshake: HandshakeContext,
    /// The server's SSH identification line, set at the first key exchange
    /// and shared with the [`LivenessWatch`] (#5134).
    server_id: Arc<OnceLock<String>>,
}

impl TermiHubHandler {
    /// Create a new handler together with the shared channel registry and the
    /// session-liveness watch (#1297) the tunnel supervisor observes.
    ///
    /// Agent forwarding is off and the target host/port are empty; use
    /// [`new_with_forwarding`](Self::new_with_forwarding) to set them for a real
    /// connection. Intended for tests that never reach host-key verification.
    pub fn new() -> (Self, ForwardedChannelRegistry, LivenessWatch) {
        Self::new_with_forwarding(String::new(), 0, false)
    }

    /// Build a handler for a connection to `host:port`, setting whether the
    /// session should bridge a server-opened agent-forwarding channel to the
    /// local `ssh-agent` (#1699). `host`/`port` key host-key verification (#1959).
    pub fn new_with_forwarding(
        host: String,
        port: u16,
        forward_agent: bool,
    ) -> (Self, ForwardedChannelRegistry, LivenessWatch) {
        let registry: ForwardedChannelRegistry = Arc::new(Mutex::new(HashMap::new()));
        let (liveness_tx, liveness_rx) = watch::channel(false);
        let server_id = Arc::new(OnceLock::new());
        let handler = Self {
            forwarded_channel_registry: registry.clone(),
            liveness_tx,
            forward_agent,
            host,
            port,
            handshake: HandshakeContext::default(),
            server_id: server_id.clone(),
        };
        let liveness = LivenessWatch {
            rx: liveness_rx,
            server_id,
        };
        (handler, registry, liveness)
    }

    /// Attach the connecting task's [`HandshakeContext`] (#3527, #5185).
    pub(crate) fn with_handshake(mut self, handshake: HandshakeContext) -> Self {
        self.handshake = handshake;
        self
    }

    /// Record why the host key was refused, for the connecting task.
    fn refuse(&self, why: HostKeyRefusal) -> bool {
        *self
            .handshake
            .outcome
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(why);
        false
    }

    /// The interactive trust decision (#5185): the prompt's wait is excluded
    /// from the connect deadline and bounded by [`HOST_KEY_PROMPT_TIMEOUT`]
    /// instead, and the prompt is dropped — dismissed — the moment the
    /// connecting task abandons the handshake.
    async fn decide_attended(&self, info: &super::host_key::HostKeyInfo) -> bool {
        let ctx = &self.handshake;
        let decision = super::prompt_owner::with_prompt_owner(
            ctx.owner.as_deref(),
            super::host_key::decide_host_key(info, ctx.verifier.clone()),
        );
        let bounded = ctx
            .clock
            .exclude(tokio::time::timeout(HOST_KEY_PROMPT_TIMEOUT, decision));
        let answer = tokio::select! {
            biased;
            _ = ctx.abandoned.cancelled() => return self.refuse(HostKeyRefusal::Abandoned),
            answer = bounded => answer,
        };
        match answer {
            Ok(HostKeyDecision::Accepted) => true,
            Ok(HostKeyDecision::Refused) => self.refuse(HostKeyRefusal::NotTrusted),
            Ok(HostKeyDecision::RejectedByUser) => self.refuse(HostKeyRefusal::RejectedByUser),
            Err(_) => self.refuse(HostKeyRefusal::PromptTimedOut),
        }
    }
}

impl Default for TermiHubHandler {
    fn default() -> Self {
        Self::new().0
    }
}

/// The bare host key to verify, or `None` for an OpenSSH host certificate,
/// which termiHub does not trust (see `check_server_key`, #5498).
fn plain_host_key(key: &russh::keys::PublicKeyOrCertificate) -> Option<&russh::keys::PublicKey> {
    match key {
        russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => Some(key),
        russh::keys::PublicKeyOrCertificate::Certificate(_) => None,
    }
}

/// The live listener registered for a server-opened forwarded channel's
/// `port`, if any. `None` (no listener, or its receiver is gone) makes the
/// caller reject the open (#5498).
fn forwarded_listener(
    registry: &ForwardedChannelRegistry,
    port: u32,
) -> Option<UnboundedSender<IncomingChannel>> {
    let registry = registry.lock().ok()?;
    registry.get(&port).filter(|tx| !tx.is_closed()).cloned()
}

/// Refuse a server-opened channel termiHub never asked for (#5498).
async fn reject_unsolicited(reply: russh::client::ChannelOpenHandle, kind: &str) {
    debug!(kind, "rejecting unsolicited server-opened channel");
    reply
        .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
        .await;
}

impl russh::client::Handler for TermiHubHandler {
    type Error = russh::Error;

    /// Record the server's SSH identification line (#5134). russh calls this
    /// after every key exchange, the first one before the connect returns.
    async fn kex_done(
        &mut self,
        _shared_secret: Option<&[u8]>,
        _names: &russh::Names,
        session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let id = String::from_utf8_lossy(session.remote_sshid())
            .trim()
            .to_string();
        let _ = self.server_id.set(id);
        Ok(())
    }

    /// Fire the session-liveness watch on session death, then preserve russh's
    /// default disconnect semantics (#1297).
    ///
    /// russh calls this from the session's run loop on both death paths — a peer
    /// `SSH_MSG_DISCONNECT` (`ReceivedDisconnect`) and a transport error /
    /// keepalive timeout (`Error`) — so flipping the watch here surfaces true
    /// session death to the tunnel supervisor promptly and without polling. The
    /// returned `Result` mirrors the trait default so we don't alter how russh
    /// treats the disconnect.
    async fn disconnected(
        &mut self,
        reason: russh::client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        let _ = self.liveness_tx.send(true);
        match reason {
            russh::client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            russh::client::DisconnectReason::Error(e) => Err(e),
        }
    }

    /// Verify the server's host key before completing the handshake (#1959).
    ///
    /// Computes the presented key's SHA-256 fingerprint and delegates the
    /// trust decision to the process-wide [`HostKeyVerifier`](super::host_key)
    /// (trust-on-first-use against a persisted store, with an interactive prompt
    /// for unknown or changed keys). Returning `Ok(false)` aborts the handshake,
    /// so a man-in-the-middle presenting an untrusted key is rejected instead of
    /// blindly accepted as it was before this issue.
    ///
    /// russh (0.65+) hands over either a bare key or an OpenSSH host
    /// certificate. termiHub never advertises the `*-cert-v01@openssh.com`
    /// host-key algorithms (russh's `Preferred::host_key_certificates` stays
    /// empty) and has no `@cert-authority` trust store, so a certificate cannot
    /// legitimately arrive here. Should one ever do, it is refused outright
    /// (fail closed) rather than trusting the key it wraps: russh deliberately
    /// does not also ask about that inner key (#5498).
    async fn check_server_key(
        &mut self,
        server_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let Some(server_public_key) = plain_host_key(server_key) else {
            debug!("refusing an SSH host certificate: no certificate authority is trusted");
            return Ok(self.refuse(HostKeyRefusal::NotTrusted));
        };
        // Consult the host's own `~/.ssh/known_hosts` once and carry the verdict
        // into the trust decision (#1969). A recorded key is trusted silently by
        // every path (exactly as `ssh` would); a *changed* key there is the
        // possible-MITM case and is never quietly accepted; an unknown host or
        // unreadable file falls through. The strict headless default (no
        // verifier registered, e.g. the remote agent) trusts only a recorded key
        // and refuses the rest, while the desktop verifier can additionally
        // prompt the user for an unknown key.
        let info = super::host_key::HostKeyInfo {
            host: self.host.clone(),
            port: self.port,
            key_type: super::host_key::key_algorithm(server_public_key),
            fingerprint: super::host_key::fingerprint_sha256(server_public_key),
            known_hosts: super::host_key::check_system_known_hosts(
                &self.host,
                self.port,
                server_public_key,
            ),
        };
        if self.handshake.unattended {
            // Unattended (#3527): never prompt — only an already-trusted key
            // passes, and a refusal is recorded for the typed error.
            let trusted = super::host_key::verify_host_key_unattended(&info).await;
            return Ok(trusted || self.refuse(HostKeyRefusal::NotTrusted));
        }
        Ok(self.decide_attended(&info).await)
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
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        debug!(
            connected_address,
            connected_port, "Incoming forwarded-tcpip channel"
        );
        // Since russh 0.65 a server-opened channel is only confirmed when the
        // handler accepts it. Accept only when a live listener is registered
        // for this port; otherwise refuse, so the server sees an open failure
        // instead of a confirmed channel that nobody reads (#5498). The
        // confirmation is queued before the listener gets the channel, so its
        // first write cannot overtake the open confirmation.
        if let Some(tx) = forwarded_listener(&self.forwarded_channel_registry, connected_port) {
            reply.accept().await;
            // A listener that went away in between drops the channel, which
            // closes it.
            let _ = tx.send(IncomingChannel {
                channel,
                connected_address: connected_address.to_string(),
                connected_port,
            });
        } else {
            debug!(
                connected_port,
                "rejecting forwarded-tcpip channel: no listener"
            );
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
        }
        Ok(())
    }

    /// Bridge a server-opened SSH agent-forwarding channel to the local agent
    /// (#1699), but only when this connection opted into forwarding.
    ///
    /// The server opens an `auth-agent@openssh.com` channel when a program on the
    /// target contacts its `$SSH_AUTH_SOCK`. We hand it to
    /// `spawn_forwarded_agent_bridge`,
    /// which pumps bytes between it and the local `ssh-agent`. When forwarding was
    /// not requested the open is rejected (`SSH_OPEN_ADMINISTRATIVELY_PROHIBITED`),
    /// so a server can never reach the local agent unsolicited.
    ///
    /// termiHub only *bridges* bytes to the user's own agent (OpenSSH
    /// `ssh-agent`, Pageant, the Windows agent); it never runs russh's agent
    /// server, so per-use confirmation of `ssh-add -c` keys stays with that
    /// agent (RUSTSEC-2026-0495 does not apply, #5498).
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        if self.forward_agent {
            debug!("bridging forwarded SSH agent channel to the local agent");
            reply.accept().await;
            super::agent_forward::spawn_forwarded_agent_bridge(channel);
        } else {
            debug!("rejecting agent-forward channel: forwarding was not requested");
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
        }
        Ok(())
    }
    // ── Unsolicited server-opened channels (#5498) ─────────────────────────
    //
    // Since russh 0.65 a server-opened channel is confirmed only when the
    // handler accepts it, and russh's *default* for these kinds accepts. termiHub
    // never asks the server for any of them — X11 rides on `forwarded-tcpip`
    // (see `x11.rs`), and no streamlocal forward is ever requested — so a server
    // opening one is unsolicited and is refused rather than confirmed.

    async fn server_channel_open_session(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        reject_unsolicited(reply, "session").await;
        Ok(())
    }

    async fn server_channel_open_direct_tcpip(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        reject_unsolicited(reply, "direct-tcpip").await;
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        reject_unsolicited(reply, "x11").await;
        Ok(())
    }

    async fn server_channel_open_forwarded_streamlocal(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _socket_path: &str,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        reject_unsolicited(reply, "forwarded-streamlocal").await;
        Ok(())
    }

    async fn server_channel_open_direct_streamlocal(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _socket_path: &str,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        reject_unsolicited(reply, "direct-streamlocal").await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    //! Session-liveness watch (#1297). The watch is the native, event-driven
    //! replacement for the tunnel supervisor's ~20 s `channel_open_session`
    //! keepalive poll: the handler fires it from russh's `disconnected` callback
    //! (and its `Drop` as a backstop), so these exercise both firing paths and
    //! the live-session (never-resolve) contract without a real SSH server.

    use super::*;
    use russh::client::{DisconnectReason, Handler};
    use std::time::Duration;

    /// A live session's watch must never resolve — the supervisor keeps waiting
    /// on it rather than tearing a healthy tunnel down.
    #[tokio::test]
    async fn watch_pending_while_session_alive() {
        let (_handler, _registry, mut watch) = TermiHubHandler::new();
        let res = tokio::time::timeout(Duration::from_millis(50), watch.dead()).await;
        assert!(res.is_err(), "a live session must not report dead");
    }

    /// russh's `disconnected` callback (peer disconnect / transport error /
    /// keepalive timeout) must flip the watch so the supervisor sees death.
    #[tokio::test]
    async fn watch_fires_on_disconnected_callback() {
        let (mut handler, _registry, mut watch) = TermiHubHandler::new();
        // A keepalive timeout is the silent-death case S2 targets.
        let _ = handler
            .disconnected(DisconnectReason::Error(russh::Error::KeepaliveTimeout))
            .await;
        tokio::time::timeout(Duration::from_millis(50), watch.dead())
            .await
            .expect("watch must resolve after disconnected fired");
    }

    /// Dropping the handler (the session task ended by any path) also resolves
    /// the watch — the backstop so a vanished session never hangs a supervisor.
    #[tokio::test]
    async fn watch_fires_on_handler_drop() {
        let (handler, _registry, mut watch) = TermiHubHandler::new();
        drop(handler);
        tokio::time::timeout(Duration::from_millis(50), watch.dead())
            .await
            .expect("watch must resolve after the handler is dropped");
    }

    /// A shared pooled session fans out to many supervisors: a cloned watch must
    /// observe the same death (`watch::Receiver` is multi-consumer).
    #[tokio::test]
    async fn cloned_watch_also_fires() {
        let (mut handler, _registry, watch) = TermiHubHandler::new();
        let mut clone = watch.clone();
        let _ = handler
            .disconnected(DisconnectReason::Error(russh::Error::KeepaliveTimeout))
            .await;
        tokio::time::timeout(Duration::from_millis(50), clone.dead())
            .await
            .expect("a cloned watch must also see the session die");
    }

    /// Agent forwarding (#1699) is off by default: a handler built with `new`
    /// must not bridge a server-opened agent channel, so a server cannot reach the
    /// local agent unless the connection opted in.
    #[test]
    fn forwarding_disabled_by_default() {
        let (handler, _registry, _watch) = TermiHubHandler::new();
        assert!(!handler.forward_agent);
    }

    /// A connection that opted into forwarding builds a handler that will bridge
    /// the server's agent channel to the local agent.
    #[test]
    fn forwarding_enabled_when_requested() {
        let (handler, _registry, _watch) =
            TermiHubHandler::new_with_forwarding("host".to_string(), 22, true);
        assert!(handler.forward_agent);
    }

    /// `disconnected` must preserve russh's default result so we don't change how
    /// russh treats the disconnect: `Error` propagates, `ReceivedDisconnect` is Ok.
    #[tokio::test]
    async fn disconnected_preserves_default_result() {
        let (mut handler, _registry, _watch) = TermiHubHandler::new();
        let err = handler
            .disconnected(DisconnectReason::Error(russh::Error::KeepaliveTimeout))
            .await;
        assert!(err.is_err(), "an Error disconnect must propagate the error");
    }
}

#[cfg(test)]
#[path = "handler_channel_open_tests.rs"]
mod channel_open_tests;
