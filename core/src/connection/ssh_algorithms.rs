//! The algorithms an SSH session negotiated in its key exchange (#5896).
//!
//! The status-bar SSH chip's "Connection security" popover names the cipher,
//! the integrity MAC, the key exchange and the host-key algorithm the session
//! really uses, instead of a bare "Encrypted (SSH)". The SSH backend records
//! them when the key exchange completes; a direct session reports them through
//! [`ConnectionType::ssh_algorithms`](super::ConnectionType::ssh_algorithms),
//! an agent-hosted one through the agent's `connection.sshAlgorithms` method.

use serde::{Deserialize, Serialize};

/// The algorithms of one SSH transport, as their SSH wire names
/// (`chacha20-poly1305@openssh.com`, `curve25519-sha256`, …).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct SshNegotiatedAlgorithms {
    /// The key-exchange method (`curve25519-sha256`).
    pub kex: String,
    /// The host-key signature algorithm (`ssh-ed25519`, `rsa-sha2-512`).
    pub host_key: String,
    /// The cipher (`chacha20-poly1305@openssh.com`, `aes256-ctr`).
    pub cipher: String,
    /// The integrity MAC (`hmac-sha2-256-etm@openssh.com`), `None` when the
    /// cipher is an AEAD one that protects integrity itself: SSH still
    /// negotiates a MAC name then, but it is not used.
    pub mac: Option<String>,
}

impl SshNegotiatedAlgorithms {
    /// Build the record from the negotiated names, dropping the MAC when the
    /// cipher authenticates itself (see [`is_aead_cipher`]).
    pub fn new(kex: &str, host_key: &str, cipher: &str, mac: &str) -> Self {
        let mac = (!is_aead_cipher(cipher) && mac != "none").then(|| mac.to_string());
        Self {
            kex: kex.to_string(),
            host_key: host_key.to_string(),
            cipher: cipher.to_string(),
            mac,
        }
    }
}

/// Whether an SSH cipher is AEAD — it carries its own integrity tag, so the
/// negotiated MAC is unused: ChaCha20-Poly1305 and the AES-GCM modes.
pub fn is_aead_cipher(cipher: &str) -> bool {
    let name = cipher.to_ascii_lowercase();
    name.contains("poly1305") || name.contains("-gcm")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_aead_cipher_drops_the_unused_mac() {
        let a = SshNegotiatedAlgorithms::new(
            "curve25519-sha256",
            "ssh-ed25519",
            "chacha20-poly1305@openssh.com",
            "hmac-sha2-256-etm@openssh.com",
        );
        assert_eq!(a.mac, None);
        let gcm = SshNegotiatedAlgorithms::new("k", "h", "aes256-gcm@openssh.com", "hmac-sha2-256");
        assert_eq!(gcm.mac, None);
    }

    #[test]
    fn a_plain_cipher_keeps_its_mac() {
        let a = SshNegotiatedAlgorithms::new(
            "diffie-hellman-group14-sha256",
            "rsa-sha2-512",
            "aes256-ctr",
            "hmac-sha2-256-etm@openssh.com",
        );
        assert_eq!(a.mac.as_deref(), Some("hmac-sha2-256-etm@openssh.com"));
        assert_eq!(a.cipher, "aes256-ctr");
        assert_eq!(a.host_key, "rsa-sha2-512");
    }

    #[test]
    fn a_none_mac_is_not_reported() {
        let a = SshNegotiatedAlgorithms::new("k", "h", "aes128-ctr", "none");
        assert_eq!(a.mac, None);
    }

    #[test]
    fn serializes_camel_case_with_an_explicit_null_mac() {
        let a = SshNegotiatedAlgorithms::new("k", "h", "chacha20-poly1305@openssh.com", "m");
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "kex": "k",
                "hostKey": "h",
                "cipher": "chacha20-poly1305@openssh.com",
                "mac": null
            })
        );
        let back: SshNegotiatedAlgorithms = serde_json::from_value(v).unwrap();
        assert_eq!(back, a);
    }
}
