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
use x509_cert::Certificate;

/// Best-effort human-readable subject and issuer distinguished names for the
/// certificate-trust prompt (#1783).
///
/// `ironrdp_tls::upgrade` already hands the sidecar a parsed
/// [`x509_cert::Certificate`], so this just formats its subject and issuer as
/// RFC 4514 distinguished-name strings (e.g. `CN=host.example,O=Acme`). It is
/// **context only** — the public-key fingerprint is the identity the trust
/// decision keys on — so an empty distinguished name yields `None` rather than an
/// empty string, and the caller never fails the connect over a missing value.
pub fn subject_and_issuer(cert: &Certificate) -> (Option<String>, Option<String>) {
    let subject = non_empty(cert.tbs_certificate.subject.to_string());
    let issuer = non_empty(cert.tbs_certificate.issuer.to_string());
    (subject, issuer)
}

/// Map a blank distinguished name to `None`; a certificate may legitimately carry
/// an empty subject (identity asserted via subjectAltName), which is not useful
/// prompt context.
fn non_empty(dn: String) -> Option<String> {
    if dn.trim().is_empty() {
        None
    } else {
        Some(dn)
    }
}

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

    /// A committed self-signed DER certificate whose subject == issuer is
    /// `C=DE, O=termiHub, CN=termihub-test.example` (generated with `openssl req
    /// -x509`). Exercises the real `x509-cert` DER decode + DN formatting path.
    const SAMPLE_CERT_DER: &[u8] = include_bytes!("testdata/sample_cert.der");

    #[test]
    fn subject_and_issuer_extracted_from_der_cert() {
        use x509_cert::der::Decode as _;

        let cert = Certificate::from_der(SAMPLE_CERT_DER).expect("sample cert parses");
        let (subject, issuer) = subject_and_issuer(&cert);

        let subject = subject.expect("subject is populated");
        let issuer = issuer.expect("issuer is populated");
        // RFC 4514 formatting; assert on the components rather than exact spacing.
        assert!(
            subject.contains("CN=termihub-test.example"),
            "subject was {subject:?}"
        );
        assert!(subject.contains("O=termiHub"), "subject was {subject:?}");
        // Self-signed: issuer mirrors the subject.
        assert_eq!(subject, issuer);
    }

    #[test]
    fn empty_distinguished_name_maps_to_none() {
        assert_eq!(non_empty(String::new()), None);
        assert_eq!(non_empty("   ".to_string()), None);
        assert_eq!(
            non_empty("CN=host".to_string()),
            Some("CN=host".to_string())
        );
    }
}
