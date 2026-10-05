//! Tests for the plugin-index signature (#3716).

use super::test_support::*;
use super::*;
use crate::ed25519_pem::public_key_pem;

const INDEX: &[u8] = b"{\"schemaVersion\":1,\"plugins\":[]}\n";
const TAMPERED: &[u8] = b"{\"schemaVersion\":1,\"plugins\":[ ]}\n";

fn policy(seed: u8, require: bool) -> IndexSignaturePolicy {
    IndexSignaturePolicy::new(vec![test_index_key(seed).verifying_key()], require)
}

#[test]
fn valid_signature_verifies_in_either_mode() {
    let sig = sign_index(&test_index_key(1), INDEX);
    for require in [true, false] {
        assert_eq!(
            policy(1, require).check(INDEX, Some(sig.as_bytes())),
            Ok(IndexSignatureStatus::Verified)
        );
    }
    // Surrounding whitespace (CRLF, padding) does not matter.
    let padded = format!("  {}\r\n", sig.trim());
    assert_eq!(
        policy(1, true).check(INDEX, Some(padded.as_bytes())),
        Ok(IndexSignatureStatus::Verified)
    );
}

#[test]
fn tampered_index_and_wrong_key_are_rejected_even_when_optional() {
    let sig = sign_index(&test_index_key(1), INDEX);
    let foreign = sign_index(&test_index_key(2), INDEX);
    for require in [true, false] {
        assert_eq!(
            policy(1, require).check(TAMPERED, Some(sig.as_bytes())),
            Err(IndexSignatureError::Invalid)
        );
        assert_eq!(
            policy(1, require).check(INDEX, Some(foreign.as_bytes())),
            Err(IndexSignatureError::Invalid)
        );
    }
}

#[test]
fn missing_signature_is_rejected_only_when_required() {
    assert_eq!(
        policy(1, true).check(INDEX, None),
        Err(IndexSignatureError::Missing)
    );
    assert_eq!(
        policy(1, false).check(INDEX, None),
        Ok(IndexSignatureStatus::Unsigned)
    );
}

#[test]
fn malformed_signatures_are_rejected() {
    let p = policy(1, false);
    for raw in [
        &b"not base64!!"[..],
        &b"AAAA"[..],
        &[0xff, 0xfe, 0x00][..],
        &b"<html>404</html>"[..],
    ] {
        assert!(
            matches!(
                p.check(INDEX, Some(raw)),
                Err(IndexSignatureError::Malformed(_))
            ),
            "{raw:?}"
        );
    }
}

/// The placeholder key degrades to "not checked" rather than failing closed,
/// so Browse keeps working before the maintainer's key ceremony.
#[test]
fn placeholder_key_degrades_to_not_configured() {
    let empty = IndexSignaturePolicy::new(Vec::new(), true);
    assert!(!empty.has_trusted_keys());
    let sig = sign_index(&test_index_key(1), INDEX);
    assert_eq!(
        empty.check(INDEX, None),
        Ok(IndexSignatureStatus::NotConfigured)
    );
    assert_eq!(
        empty.check(TAMPERED, Some(sig.as_bytes())),
        Ok(IndexSignatureStatus::NotConfigured)
    );
}

#[test]
fn committed_key_file_is_the_placeholder_or_a_real_key() {
    let keys = embedded_index_keys();
    if EMBEDDED_INDEX_KEYS_PEM.contains(INDEX_KEY_PLACEHOLDER_MARKER) {
        assert!(keys.is_empty(), "the placeholder must carry no key");
        assert!(!IndexSignaturePolicy::embedded(true).has_trusted_keys());
    } else {
        assert!(
            !keys.is_empty(),
            "a non-placeholder key file must hold a key"
        );
    }
    assert!(IndexSignaturePolicy::embedded(true).requires_signature());
    assert!(!IndexSignaturePolicy::embedded(false).requires_signature());
}

/// The index key is separate from the agent update key: a signature over the
/// same digest with the agent domain must never verify as an index signature.
#[test]
fn domain_separation_from_the_agent_update_scheme() {
    use ed25519_dalek::Signer;
    let key = test_index_key(1);
    let mut agent_msg = b"termihub-agent-update-v1\0".to_vec();
    agent_msg.extend_from_slice(&Sha256::digest(INDEX));
    let agent_sig = BASE64.encode(key.sign(&agent_msg).to_bytes());
    assert_eq!(
        policy(1, true).check(INDEX, Some(agent_sig.as_bytes())),
        Err(IndexSignatureError::Invalid)
    );
    let msg = index_signed_message(INDEX);
    assert_eq!(&msg[..INDEX_SIGNING_DOMAIN.len()], INDEX_SIGNING_DOMAIN);
    assert_eq!(msg.len(), 25 + 32);
}

#[test]
fn rotation_overlap_accepts_either_key() {
    let (old, new) = (test_index_key(1), test_index_key(2));
    let pem = format!(
        "# comment\n{}{}",
        public_key_pem(&old.verifying_key()),
        public_key_pem(&new.verifying_key())
    );
    let p = IndexSignaturePolicy::new(parse_public_keys_pem(&pem), true);
    for key in [&old, &new] {
        let sig = sign_index(key, INDEX);
        assert_eq!(
            p.check(INDEX, Some(sig.as_bytes())),
            Ok(IndexSignatureStatus::Verified)
        );
    }
}

/// Interop vector from the exact pipeline of
/// `scripts/internal/plugin-index-signing.sh sign` (throwaway key, discarded):
///
/// ```text
/// openssl genpkey -algorithm ed25519 -out k.pem
/// openssl pkey -in k.pem -pubout                      # -> OPENSSL_PUB_PEM
/// printf '{"schemaVersion":1,"plugins":[]}\n' > index.json
/// plugin-index-signing.sh --pub pub.pem sign --key k.pem index.json  # -> OPENSSL_SIG
/// ```
///
/// Guards against the CI signing script and the desktop drifting apart.
const OPENSSL_PUB_PEM: &str = "-----BEGIN PUBLIC KEY-----\n\
    MCowBQYDK2VwAyEAT5ai+5pnxGHVlzrI27AuFQy0IW2wVBRdu4FMlF2Iu44=\n\
    -----END PUBLIC KEY-----\n";
const OPENSSL_SIG: &str =
    "XZHRuJ5N+1+8FBJULKW609hPdXgTYxT0Ly2W2auMl9Y/vizzT3jEbPEdqMZTRAkwTfw8VzuugRp9xnP32vDCDA==\n";

#[test]
fn openssl_produced_signature_verifies() {
    let p = IndexSignaturePolicy::new(parse_public_keys_pem(OPENSSL_PUB_PEM), true);
    assert_eq!(
        p.check(INDEX, Some(OPENSSL_SIG.as_bytes())),
        Ok(IndexSignatureStatus::Verified)
    );
    assert_eq!(
        p.check(TAMPERED, Some(OPENSSL_SIG.as_bytes())),
        Err(IndexSignatureError::Invalid)
    );
}
