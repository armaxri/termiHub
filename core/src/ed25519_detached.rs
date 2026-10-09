//! Domain-separated detached Ed25519 verification (#4365, audit DUP2-007).
//!
//! The mechanics shared by every detached signature termiHub verifies — the
//! agent self-update binary (`agent_update_signature`, AGT-005) and the curated
//! plugin index (`plugin::index_signature`, #3716):
//!
//! ```text
//! message   = domain || SHA-256(payload)        (domain is NUL-terminated, "-vN")
//! signature = base64(Ed25519-sign(key, message)) (64 bytes)
//! ```
//!
//! This module owns only the mechanics: building the message
//! ([`domain_message`]), parsing the base64 signature
//! ([`parse_b64_signature`]) and the strict any-trusted-key check
//! ([`any_trusted_key_verifies`]). Each caller keeps its own **domain string,
//! policy and error type**, mapping [`SignatureParseError`] at its boundary, so
//! a signature made for one purpose can never verify as another and each
//! policy's fail-open/fail-closed rules stay where they are documented.
//! Trusted keys come from [`crate::ed25519_pem`].

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey, SIGNATURE_LENGTH};

/// Why a base64 signature value could not be parsed. Callers map it into their
/// own `Malformed` error with their own wording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignatureParseError {
    /// The (trimmed) value is not valid standard base64; carries the decoder's
    /// message.
    NotBase64(String),
    /// The value decoded, but not to [`SIGNATURE_LENGTH`] bytes; carries the
    /// decoded length.
    WrongLength(usize),
}

/// Build the signed message: `domain` followed by the 32 raw `digest` bytes.
pub fn domain_message(domain: &[u8], digest: &[u8; 32]) -> Vec<u8> {
    let mut message = Vec::with_capacity(domain.len() + digest.len());
    message.extend_from_slice(domain);
    message.extend_from_slice(digest);
    message
}

/// Parse a detached signature value: standard base64 of the 64-byte Ed25519
/// signature, surrounding whitespace ignored.
pub fn parse_b64_signature(signature_b64: &str) -> Result<Signature, SignatureParseError> {
    let bytes = BASE64
        .decode(signature_b64.trim())
        .map_err(|e| SignatureParseError::NotBase64(e.to_string()))?;
    let bytes: [u8; SIGNATURE_LENGTH] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| SignatureParseError::WrongLength(bytes.len()))?;
    Ok(Signature::from_bytes(&bytes))
}

/// Whether any of `trusted_keys` verifies `signature` over `message`, using
/// [`VerifyingKey::verify_strict`] (rejects weak keys and malleable
/// signatures). An empty key set verifies nothing.
pub fn any_trusted_key_verifies(
    trusted_keys: &[VerifyingKey],
    message: &[u8],
    signature: &Signature,
) -> bool {
    trusted_keys
        .iter()
        .any(|key| key.verify_strict(message, signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const DOMAIN_A: &[u8] = b"termihub-test-a-v1\0";
    const DOMAIN_B: &[u8] = b"termihub-test-b-v1\0";
    const DIGEST: [u8; 32] = [7u8; 32];

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn sign_b64(key: &SigningKey, domain: &[u8], digest: &[u8; 32]) -> String {
        BASE64.encode(key.sign(&domain_message(domain, digest)).to_bytes())
    }

    #[test]
    fn domain_message_is_prefix_then_raw_digest() {
        let msg = domain_message(DOMAIN_A, &DIGEST);
        assert_eq!(&msg[..DOMAIN_A.len()], DOMAIN_A);
        assert_eq!(&msg[DOMAIN_A.len()..], &DIGEST);
        assert_eq!(msg.len(), DOMAIN_A.len() + 32);
    }

    #[test]
    fn good_signature_verifies_with_whitespace_around_it() {
        let k = key(1);
        let sig = parse_b64_signature(&format!(" {}\n", sign_b64(&k, DOMAIN_A, &DIGEST))).unwrap();
        assert!(any_trusted_key_verifies(
            &[k.verifying_key()],
            &domain_message(DOMAIN_A, &DIGEST),
            &sig
        ));
    }

    #[test]
    fn wrong_domain_signature_is_rejected() {
        let k = key(1);
        let sig = parse_b64_signature(&sign_b64(&k, DOMAIN_B, &DIGEST)).unwrap();
        assert!(!any_trusted_key_verifies(
            &[k.verifying_key()],
            &domain_message(DOMAIN_A, &DIGEST),
            &sig
        ));
    }

    #[test]
    fn wrong_digest_and_wrong_key_are_rejected() {
        let k = key(1);
        let sig = parse_b64_signature(&sign_b64(&k, DOMAIN_A, &DIGEST)).unwrap();
        assert!(!any_trusted_key_verifies(
            &[k.verifying_key()],
            &domain_message(DOMAIN_A, &[8u8; 32]),
            &sig
        ));
        assert!(!any_trusted_key_verifies(
            &[key(2).verifying_key()],
            &domain_message(DOMAIN_A, &DIGEST),
            &sig
        ));
    }

    #[test]
    fn any_of_several_keys_may_verify_but_no_keys_verify_nothing() {
        let k = key(2);
        let sig = parse_b64_signature(&sign_b64(&k, DOMAIN_A, &DIGEST)).unwrap();
        let msg = domain_message(DOMAIN_A, &DIGEST);
        assert!(any_trusted_key_verifies(
            &[key(1).verifying_key(), k.verifying_key()],
            &msg,
            &sig
        ));
        assert!(!any_trusted_key_verifies(&[], &msg, &sig));
    }

    #[test]
    fn malformed_signatures_are_typed_parse_errors() {
        assert!(matches!(
            parse_b64_signature("not base64!!"),
            Err(SignatureParseError::NotBase64(_))
        ));
        assert_eq!(
            parse_b64_signature(&BASE64.encode([0u8; 10])),
            Err(SignatureParseError::WrongLength(10))
        );
        assert_eq!(
            parse_b64_signature(""),
            Err(SignatureParseError::WrongLength(0))
        );
    }
}
