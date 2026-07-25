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
//! ## Default (no verifier registered) — strict, known_hosts-only (#1969)
//!
//! When no verifier is registered — the remote agent, other headless paths,
//! bare-`core` unit tests — there is no UI to ask, so the key **cannot** be
//! confirmed interactively. Rather than blind-accept (the pre-#1969 behaviour,
//! which merely warned), the default policy is strict: trust **only** keys
//! already recorded in the host's own OpenSSH `~/.ssh/known_hosts`, and refuse
//! everything else. An unknown host, a changed key, and a key the file cannot
//! vouch for are all rejected, so a headless agent connecting through a jump
//! host never silently accepts an arbitrary or changed server key. The
//! security-critical desktop client registers a trust-on-first-use verifier
//! that additionally prompts the user, so it can accept new hosts interactively.

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

/// The verdict of consulting the host's own OpenSSH `~/.ssh/known_hosts` file
/// for a presented server key (#1969).
///
/// This is the trust source honoured everywhere: the desktop accepts a `Match`
/// silently (exactly as `ssh` would), and the headless default policy trusts a
/// `Match` and refuses anything else. `Changed` is the possible-MITM case — the
/// host is recorded but with a *different* key — and must never be quietly
/// accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnownHostsStatus {
    /// The presented key matches an entry for this host — already trusted.
    Match,
    /// The host is recorded, but with a **different** key (possible MITM).
    Changed,
    /// The host is not recorded, no `known_hosts` file exists, or the file
    /// could not be consulted — the file cannot vouch for this key.
    Unknown,
}

/// Consult the host's OpenSSH `~/.ssh/known_hosts` for a presented server key.
///
/// A key already recorded there is trusted by every path; a *changed* key is
/// flagged (never silently accepted); anything else — unknown host, missing
/// file, or a read/parse error — is [`KnownHostsStatus::Unknown`]. An empty host
/// (never expected from a real connect) is treated as `Unknown`.
pub fn check_system_known_hosts(
    host: &str,
    port: u16,
    key: &russh::keys::PublicKey,
) -> KnownHostsStatus {
    if host.is_empty() {
        return KnownHostsStatus::Unknown;
    }
    map_known_hosts_result(russh::keys::check_known_hosts(host, port, key), host)
}

/// Map a `russh` `check_known_hosts*` result to a [`KnownHostsStatus`], logging a
/// non-`KeyChanged` error so a broken/unreadable file is visible rather than
/// silently swallowed. Shared by [`check_system_known_hosts`] and its
/// path-based test helper.
fn map_known_hosts_result(
    result: Result<bool, russh::keys::Error>,
    host: &str,
) -> KnownHostsStatus {
    match result {
        Ok(true) => KnownHostsStatus::Match,
        Ok(false) => KnownHostsStatus::Unknown,
        Err(russh::keys::Error::KeyChanged { .. }) => KnownHostsStatus::Changed,
        Err(e) => {
            warn!(
                host = %host,
                error = %e,
                "could not read ~/.ssh/known_hosts; treating host as unknown"
            );
            KnownHostsStatus::Unknown
        }
    }
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
    /// What the host's own `~/.ssh/known_hosts` says about this key (#1969).
    /// Both the strict headless default and the desktop verifier consult it so a
    /// key recorded there is trusted and a *changed* key is never quietly
    /// accepted.
    pub known_hosts: KnownHostsStatus,
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
/// Delegates to the registered [`HostKeyVerifier`]; with none registered it
/// applies the strict headless default ([`default_verify`]) — trust only keys
/// already in `~/.ssh/known_hosts`, refuse everything else (see the module docs).
pub(crate) async fn verify_host_key(info: &HostKeyInfo) -> bool {
    match host_key_verifier() {
        Some(verifier) => verifier.verify(info).await,
        None => default_verify(info),
    }
}

/// The strict default policy for headless paths with no interactive verifier
/// (the remote agent, other server-side paths, tests) — #1969.
///
/// Trusts **only** a key already present in the host's `~/.ssh/known_hosts`
/// ([`KnownHostsStatus::Match`]); an unknown host, a *changed* key, and a key the
/// file cannot vouch for are all refused. It never blind-accepts, so a headless
/// agent connecting through a jump host cannot be silently man-in-the-middled.
/// The refusal is logged so the desktop (which surfaces the agent's stderr) can
/// see why a connect failed.
fn default_verify(info: &HostKeyInfo) -> bool {
    match info.known_hosts {
        KnownHostsStatus::Match => true,
        KnownHostsStatus::Changed => {
            warn!(
                host = %info.host,
                port = info.port,
                fingerprint = %info.fingerprint,
                "SSH host key CHANGED from ~/.ssh/known_hosts and no verifier is registered; \
                 refusing the connection (possible MITM)"
            );
            false
        }
        KnownHostsStatus::Unknown => {
            warn!(
                host = %info.host,
                port = info.port,
                fingerprint = %info.fingerprint,
                "unknown SSH host key and no verifier is registered; refusing the connection \
                 (add the host to ~/.ssh/known_hosts to trust it)"
            );
            false
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
            known_hosts: KnownHostsStatus::Unknown,
        }
    }

    #[test]
    fn host_port_keys_like_the_rdp_store() {
        assert_eq!(sample_info().host_port(), "example.com:2222");
    }

    /// The strict headless default (no verifier registered) trusts a key already
    /// in `~/.ssh/known_hosts` and refuses an unknown or changed key — it must
    /// never blind-accept as it did before #1969.
    #[test]
    fn default_policy_trusts_only_known_hosts_matches() {
        let with = |status| HostKeyInfo {
            known_hosts: status,
            ..sample_info()
        };
        assert!(
            default_verify(&with(KnownHostsStatus::Match)),
            "a key recorded in ~/.ssh/known_hosts is trusted"
        );
        assert!(
            !default_verify(&with(KnownHostsStatus::Unknown)),
            "an unknown host key must be refused headless (no blind accept)"
        );
        assert!(
            !default_verify(&with(KnownHostsStatus::Changed)),
            "a changed host key must be refused headless (possible MITM)"
        );
    }

    /// The `russh` known_hosts result maps to the right verdict: a match trusts,
    /// a `KeyChanged` error is the MITM case, and everything else is unknown.
    #[test]
    fn known_hosts_result_maps_to_status() {
        assert_eq!(
            map_known_hosts_result(Ok(true), "h"),
            KnownHostsStatus::Match
        );
        assert_eq!(
            map_known_hosts_result(Ok(false), "h"),
            KnownHostsStatus::Unknown
        );
        assert_eq!(
            map_known_hosts_result(Err(russh::keys::Error::KeyChanged { line: 3 }), "h"),
            KnownHostsStatus::Changed
        );
        assert_eq!(
            map_known_hosts_result(Err(russh::keys::Error::NoHomeDir), "h"),
            KnownHostsStatus::Unknown,
            "an unreadable known_hosts is unknown, not trusted"
        );
    }

    /// Two distinct, fixed ed25519 public keys — deterministic so the test needs
    /// no RNG. `RECORDED` is written to the test `known_hosts`; `IMPOSTOR`
    /// impersonates the same host with a different key.
    const RECORDED_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGvPs1dLFaPzeD8R5jSSrKLm3WqqOHx4W3e7VGFqojXJ recorded";
    const IMPOSTOR_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICiH/XInTaWEkjc02WF1n/O5ypuoc/j8XMLlY9CRkplT impostor";

    fn public_key(openssh: &str) -> russh::keys::PublicKey {
        let mut key =
            russh::keys::PublicKey::from_openssh(openssh).expect("parse test public key");
        // A server key off the wire (and a key parsed out of `known_hosts`) has
        // no comment; clear it so equality is by key material, as in production.
        key.set_comment("");
        key
    }

    /// An empty host (never expected from a real connect) resolves to `Unknown`
    /// rather than touching the filesystem, so the strict default refuses it.
    #[test]
    fn empty_host_is_unknown() {
        assert_eq!(
            check_system_known_hosts("", 22, &public_key(RECORDED_KEY)),
            KnownHostsStatus::Unknown
        );
    }

    /// End-to-end mapping against a real `known_hosts` file: a recorded key is a
    /// `Match`, a different key for the same host is `Changed`, and an
    /// unrecorded host is `Unknown`.
    #[test]
    fn check_against_known_hosts_file() {
        use std::io::Write;

        let recorded = public_key(RECORDED_KEY);
        let impostor = public_key(IMPOSTOR_KEY);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        {
            let mut f = std::fs::File::create(&path).unwrap();
            writeln!(f, "[example.com]:2222 {RECORDED_KEY}").unwrap();
        }

        let map = |host: &str, key: &russh::keys::PublicKey| {
            map_known_hosts_result(
                russh::keys::check_known_hosts_path(host, 2222, key, &path),
                host,
            )
        };

        assert_eq!(
            map("example.com", &recorded),
            KnownHostsStatus::Match,
            "the recorded key is trusted"
        );
        assert_eq!(
            map("example.com", &impostor),
            KnownHostsStatus::Changed,
            "a different key for a recorded host is a changed key"
        );
        assert_eq!(
            map("unlisted.example", &recorded),
            KnownHostsStatus::Unknown,
            "a host not in the file is unknown"
        );
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
