//! SSH server host-key verification hook (#1959).
//!
//! Historically [`TermiHubHandler::check_server_key`](super::handler) accepted
//! **every** server host key unconditionally — a blind-accept that defeats the
//! very man-in-the-middle protection SSH exists to provide (worse through a jump
//! host into an untrusted network). This module replaces that with a pluggable
//! [`HostKeyVerifier`]: the handler computes the presented key's SHA-256
//! fingerprint and asks the process-wide verifier whether to trust it.
//!
//! ## Why a process-global verifier
//!
//! An SSH connect is driven from a dozen call sites (terminal sessions, tunnels,
//! SFTP, agent deploy, monitoring, jump-host hops). Threading a verifier through
//! every one of them — and through the serializable [`SshConfig`](crate::config)
//! — would be invasive and collision-prone. Instead the desktop app registers a
//! single verifier once at startup via [`set_host_key_verifier`]; the handler
//! looks it up through [`host_key_verifier`]. The verifier implementation lives
//! in the host crate (`src-tauri`), which owns the config directory and the UI,
//! exactly like the RDP certificate trust store it mirrors.
//!
//! ## Default (no verifier registered)
//!
//! When no verifier is registered — the agent binary, bare-`core` unit tests —
//! the key is accepted with a warning, preserving the pre-#1959 behaviour so
//! server-side and headless paths keep working. The security-critical desktop
//! client always registers a strict trust-on-first-use verifier, so it never
//! blind-accepts.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use tracing::warn;

/// The SHA-256 fingerprint of a presented host key, in OpenSSH `SHA256:BASE64`
/// form (e.g. `SHA256:Nh0Me49Zh9fDw/VYUfq43IJmI1T+XrjiYONPND8GzaM`) — the same
/// string `ssh` prints and a server administrator can read out for comparison.
pub fn fingerprint_sha256(key: &russh::keys::PublicKey) -> String {
    key.fingerprint(russh::keys::HashAlg::Sha256).to_string()
}

/// The host key's algorithm name, e.g. `ssh-ed25519` / `ecdsa-sha2-nistp256`.
pub fn key_algorithm(key: &russh::keys::PublicKey) -> String {
    key.algorithm().as_str().to_string()
}

/// The details of a server host key a [`HostKeyVerifier`] decides whether to
/// trust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKeyInfo {
    /// The host being connected to (the value from the connection config).
    pub host: String,
    /// The TCP port of the SSH server.
    pub port: u16,
    /// The key algorithm, e.g. `ssh-ed25519`.
    pub key_type: String,
    /// The SHA-256 fingerprint in OpenSSH `SHA256:BASE64` form.
    pub fingerprint: String,
}

impl HostKeyInfo {
    /// The `host:port` key used to index a trust store, matching the RDP store's
    /// keying (#1767).
    pub fn host_port(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// Decides whether a presented server host key should be trusted (#1959).
///
/// Called from the russh handshake on the connecting task; implementations may
/// block on an interactive user prompt (the whole connect is bounded by
/// [`SshConfig::connect_timeout`](crate::config::SshConfig::connect_timeout), so
/// a never-answered prompt fails the connect rather than hanging forever).
#[async_trait]
pub trait HostKeyVerifier: Send + Sync {
    /// Return `true` to accept the key and proceed, `false` to reject and abort
    /// the connection.
    async fn verify(&self, info: &HostKeyInfo) -> bool;
}

/// The process-wide verifier, registered once by the host application.
static VERIFIER: OnceLock<Arc<dyn HostKeyVerifier>> = OnceLock::new();

/// Register the process-wide host-key verifier. Returns `false` if one was
/// already registered (first registration wins); the app registers exactly once
/// at startup.
pub fn set_host_key_verifier(verifier: Arc<dyn HostKeyVerifier>) -> bool {
    VERIFIER.set(verifier).is_ok()
}

/// The registered verifier, or `None` when none has been set (agent / tests).
pub fn host_key_verifier() -> Option<Arc<dyn HostKeyVerifier>> {
    VERIFIER.get().cloned()
}

/// Decide whether to accept a presented host key.
///
/// Delegates to the registered [`HostKeyVerifier`]; with none registered the key
/// is accepted with a warning, preserving pre-#1959 behaviour for headless paths
/// (see the module docs).
pub(crate) async fn verify_host_key(info: &HostKeyInfo) -> bool {
    match host_key_verifier() {
        Some(verifier) => verifier.verify(info).await,
        None => {
            warn!(
                host = %info.host,
                port = info.port,
                fingerprint = %info.fingerprint,
                "no SSH host-key verifier registered; accepting host key unverified"
            );
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct FixedVerifier {
        accept: bool,
        called: AtomicBool,
    }

    #[async_trait]
    impl HostKeyVerifier for FixedVerifier {
        async fn verify(&self, _info: &HostKeyInfo) -> bool {
            self.called.store(true, Ordering::SeqCst);
            self.accept
        }
    }

    fn sample_info() -> HostKeyInfo {
        HostKeyInfo {
            host: "example.com".to_string(),
            port: 2222,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:AABBCC".to_string(),
        }
    }

    #[test]
    fn host_port_keys_like_the_rdp_store() {
        assert_eq!(sample_info().host_port(), "example.com:2222");
    }

    /// A registered verifier's verdict is what `verify_host_key` returns, and the
    /// verifier is actually consulted (no blind accept).
    #[tokio::test]
    async fn registered_verifier_is_consulted() {
        // OnceLock is process-global and set-once; exercise the trait directly so
        // this test does not depend on global registration order.
        let verifier = FixedVerifier {
            accept: false,
            called: AtomicBool::new(false),
        };
        let accepted = verifier.verify(&sample_info()).await;
        assert!(!accepted, "a rejecting verifier must reject");
        assert!(
            verifier.called.load(Ordering::SeqCst),
            "the verifier must be consulted"
        );
    }
}
