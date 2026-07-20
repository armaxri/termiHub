//! Server-certificate trust gate for the RDP sidecar (#1758).
//!
//! IronRDP's TLS layer (`ironrdp_tls::upgrade`) accepts *any* server certificate
//! so the handshake can complete and the CredSSP layer can bind trust to the
//! server public key. On its own, though, that blind accept means an untrusted
//! or spoofed server is taken with no signal at all — exactly the "always
//! accept" behaviour #1758 sets out to replace. This module turns the blind
//! accept into an explicit, auditable decision keyed off the connection's
//! `ignoreCertErrors` setting.
//!
//! The trust model is deliberately SSH-host-key-shaped: we fingerprint the
//! server's public key (not a CA chain — real RDP hosts are overwhelmingly
//! self-signed, so chain validation would reject nearly every legitimate host)
//! and decide whether to proceed. `ignoreCertErrors` accepts unconditionally;
//! otherwise the sidecar asks the **host** for an interactive trust decision
//! (#1767) via [`SidecarMessage::CertPrompt`](termihub_core::backends::rdp_sidecar::protocol::SidecarMessage::CertPrompt)
//! and blocks on the reply. The persisted per-host trust store, the
//! auto-accept-known and changed-fingerprint (MITM) detection all live on the
//! host, which owns the config directory; the sidecar just relays the
//! fingerprint and applies the verdict. [`CertVerdict`] is that seam.

use sha2::{Digest, Sha256};

/// A SHA-256 fingerprint of the server's public key, formatted as uppercase
/// colon-separated hex with a `sha256:` prefix (e.g. `sha256:AB:CD:…`) — the
/// shape an operator can eyeball against the value a server administrator
/// reports.
pub fn public_key_fingerprint(public_key: &[u8]) -> String {
    let digest = Sha256::digest(public_key);
    let hex = hex::encode_upper(digest);
    let mut out = String::with_capacity("sha256:".len() + hex.len() + hex.len() / 2);
    out.push_str("sha256:");
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        if i > 0 {
            out.push(':');
        }
        // `chunk` is always valid ASCII hex from `encode_upper`.
        out.push_str(std::str::from_utf8(chunk).expect("hex is ascii"));
    }
    out
}

/// The outcome of the server-certificate trust gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CertVerdict {
    /// Proceed with the connection without asking (the user set `ignoreCertErrors`).
    Accept,
    /// The certificate is untrusted: ask the host for an interactive decision
    /// before proceeding (#1767).
    Prompt,
}

/// Decide how to handle the server certificate identified by `fingerprint`.
///
/// `ignore_cert_errors` mirrors the connection's `ignoreCertErrors` setting: set,
/// it accepts unconditionally; unset, the sidecar surfaces the fingerprint to the
/// host and waits for an interactive accept/reject decision (#1767) rather than
/// silently accepting or hard-failing.
pub fn evaluate(ignore_cert_errors: bool) -> CertVerdict {
    if ignore_cert_errors {
        CertVerdict::Accept
    } else {
        CertVerdict::Prompt
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_and_formatted() {
        // SHA-256 of the empty input is a known constant; formatted uppercase,
        // colon-separated, with the algorithm prefix.
        let fp = public_key_fingerprint(b"");
        assert_eq!(
            fp,
            "sha256:E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:\
             27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55"
        );
        // Byte pairs → 32 hex octets → 31 separators between them.
        assert_eq!(fp.matches(':').count(), 32); // 1 after the prefix + 31 between octets
    }

    #[test]
    fn fingerprint_differs_per_key() {
        assert_ne!(
            public_key_fingerprint(b"key-a"),
            public_key_fingerprint(b"key-b")
        );
        // Deterministic for the same input.
        assert_eq!(
            public_key_fingerprint(b"key-a"),
            public_key_fingerprint(b"key-a")
        );
    }

    #[test]
    fn ignore_cert_errors_accepts() {
        assert_eq!(evaluate(true), CertVerdict::Accept);
    }

    #[test]
    fn default_prompts_for_an_interactive_decision() {
        // With ignoreCertErrors unset the sidecar must neither silently accept
        // nor hard-fail: it asks the host (#1767).
        assert_eq!(evaluate(false), CertVerdict::Prompt);
    }
}
