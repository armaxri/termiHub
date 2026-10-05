//! Parsing of the committed Ed25519 trusted-key files (PEM SubjectPublicKeyInfo).
//!
//! Shared by the two compiled-in signing keys termiHub verifies against — the
//! agent self-update key (`agent/keys/update-signing.pub.pem`, AGT-005, #3213)
//! and the plugin-index key (`plugins/keys/index-signing.pub.pem`, #3716) — so
//! both files follow exactly the same format: one or more PEM `PUBLIC KEY`
//! blocks holding raw Ed25519 keys (more than one allows a rotation overlap),
//! with any text outside the blocks (comments, a placeholder marker) ignored.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::VerifyingKey;

/// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410): SEQUENCE {
/// SEQUENCE { OID 1.3.101.112 }, BIT STRING (32 bytes) }. The 32 raw key bytes
/// follow it.
pub(crate) const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// Extract every Ed25519 key from the PEM `PUBLIC KEY` blocks in `pem`.
///
/// Blocks that are not valid Ed25519 SubjectPublicKeyInfo are skipped (a
/// garbled block can never *add* trust), and text outside blocks — comments,
/// the placeholder marker — is ignored. A placeholder file therefore yields an
/// empty list.
pub fn parse_public_keys_pem(pem: &str) -> Vec<VerifyingKey> {
    let mut keys = Vec::new();
    let mut body: Option<String> = None;
    for line in pem.lines() {
        let line = line.trim();
        if line == "-----BEGIN PUBLIC KEY-----" {
            body = Some(String::new());
        } else if line == "-----END PUBLIC KEY-----" {
            if let Some(b64) = body.take() {
                if let Some(key) = decode_spki(&b64) {
                    keys.push(key);
                }
            }
        } else if let Some(b64) = body.as_mut() {
            b64.push_str(line);
        }
    }
    keys
}

fn decode_spki(b64: &str) -> Option<VerifyingKey> {
    let der = BASE64.decode(b64).ok()?;
    let raw = der.strip_prefix(&ED25519_SPKI_PREFIX[..])?;
    let raw: [u8; 32] = raw.try_into().ok()?;
    VerifyingKey::from_bytes(&raw).ok()
}

/// The PEM SPKI encoding of `key`, exactly as the key-setup scripts write it
/// (`openssl pkey -pubout`). Used by tests to build trusted-key files.
#[cfg(any(
    test,
    feature = "agent-update-signing-test-support",
    feature = "plugin-index-signing-test-support"
))]
pub fn public_key_pem(key: &VerifyingKey) -> String {
    let mut der = ED25519_SPKI_PREFIX.to_vec();
    der.extend_from_slice(key.as_bytes());
    format!(
        "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
        BASE64.encode(der)
    )
}
