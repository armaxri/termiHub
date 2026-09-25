//! Ed25519 signature verification for agent self-updates (AGT-005, #3213).
//!
//! The SHA-256 sidecar (AGT-004) proves a staged binary is the one the
//! *initiator* intended; it does not prove the initiator is trustworthy. This
//! module adds **authenticity**: a binary is only applied when it carries a
//! detached signature made by the termiHub release key, whose public half is
//! compiled into the agent.
//!
//! # What is signed
//!
//! The signature covers a domain-separated digest, never the raw bytes directly:
//!
//! ```text
//! message   = b"termihub-agent-update-v1\0" || SHA-256(binary)   (24 + 1 + 32 bytes)
//! signature = Ed25519-sign(release_private_key, message)          (64 bytes)
//! ```
//!
//! Signing the digest (which the apply path already re-computes from the
//! on-disk bytes, AGT-004) keeps verification streaming-friendly, and the
//! domain-separation prefix guarantees a signature made for this purpose can
//! never be replayed as — or confused with — any other Ed25519 signature the
//! same key might ever produce. Release CI produces the same message with
//! `openssl` (see `.github/workflows/release.yml`).
//!
//! # File formats
//!
//! - **Signature sidecar** — `<binary>.sig`, published next to `<binary>` and
//!   `<binary>.sha256`: the 64-byte signature, standard base64, one line
//!   (surrounding whitespace ignored).
//! - **Trusted key** — `agent/keys/update-signing.pub.pem`, compiled in via
//!   `include_str!`: one or more PEM `PUBLIC KEY` (SubjectPublicKeyInfo) blocks
//!   holding raw Ed25519 keys. More than one block is accepted so a key can be
//!   rotated with an overlap window. Text outside the blocks is ignored. The
//!   committed file is a **placeholder with no block** until the maintainer runs
//!   `scripts/internal/setup-agent-signing-key.sh`; while it is, a release-built
//!   agent trusts no key and refuses every update (fail closed).
//!
//! # Build policy
//!
//! - **Release builds** (`debug_assertions` off — every shipped agent, and the
//!   `test-hooks` system-test build): a valid signature from an embedded key is
//!   **mandatory**. Missing, malformed, or non-verifying signatures, and the
//!   placeholder key, all reject.
//! - **Debug builds** (`cargo test`, `scripts/dev.sh`'s `target/debug` agent): a
//!   *missing* signature is tolerated with a loud warning so the local dev loop
//!   can push locally built, unsigned agents. A signature that *is* present must
//!   still verify — a debug agent never accepts a bad signature.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey, SIGNATURE_LENGTH};
use tracing::warn;

/// File-name suffix of the detached signature sidecar published next to every
/// agent binary release asset (e.g. `termihub-agent-linux-x64.sig`).
pub const SIGNATURE_EXT: &str = "sig";

/// Domain-separation prefix of the signed message (see the module docs).
/// Changing it invalidates every published signature — bump the `-vN` suffix
/// only together with release CI.
pub const SIGNING_DOMAIN: &[u8] = b"termihub-agent-update-v1\0";

/// The committed trusted-key file, compiled into the agent.
const EMBEDDED_PUBLIC_KEYS_PEM: &str = include_str!("../../keys/update-signing.pub.pem");

/// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410): SEQUENCE {
/// SEQUENCE { OID 1.3.101.112 }, BIT STRING (32 bytes) }. The 32 raw key bytes
/// follow it.
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// Why an update's signature was refused. Every variant is a **fail-closed**
/// rejection; the typed shape lets the RPC layer surface a dedicated error code
/// (`UPDATE_SIGNATURE_REJECTED`) to the desktop.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UpdateSignatureError {
    /// No signature accompanied the update.
    #[error(
        "the agent update carries no signature — refusing to apply an unsigned agent binary \
         (fail closed)"
    )]
    Missing,
    /// This agent was built with the placeholder key file, so it trusts no
    /// signing key and can verify nothing.
    #[error(
        "this agent was built without an update-signing public key (placeholder key file) — \
         it cannot verify, and therefore refuses, every self-update (fail closed)"
    )]
    KeyNotConfigured,
    /// The signature (or the digest it covers) is not well-formed.
    #[error("malformed agent update signature: {0}")]
    Malformed(String),
    /// The signature is well-formed but was not made by a trusted key over this
    /// binary's digest — a tampered binary or a foreign signer.
    #[error(
        "agent update signature does not verify against the trusted termiHub release key — \
         refusing to apply (fail closed)"
    )]
    Invalid,
}

/// Outcome of a successful [`SignaturePolicy::verify`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureVerdict {
    /// A trusted key verified the signature.
    Verified,
    /// Debug build only: no signature was supplied and the dev-loop allowance
    /// let it through (with a warning). Never produced by a release build.
    UnsignedDevBuild,
}

/// The set of keys an update may be signed by, plus whether an unsigned update
/// is tolerated (debug builds only — see the module docs).
#[derive(Debug, Clone)]
pub struct SignaturePolicy {
    trusted_keys: Vec<VerifyingKey>,
    allow_unsigned: bool,
}

impl SignaturePolicy {
    /// The policy compiled into this build: the embedded key(s), with the
    /// unsigned allowance on **only** when `debug_assertions` is on.
    pub fn for_build() -> Self {
        Self {
            trusted_keys: parse_public_keys_pem(EMBEDDED_PUBLIC_KEYS_PEM),
            allow_unsigned: cfg!(debug_assertions),
        }
    }

    /// A strict policy trusting exactly `trusted_keys` — the release-build rule,
    /// independent of how the current binary was compiled. Used by tests to
    /// exercise the production behaviour from a debug test binary.
    #[cfg(test)]
    pub fn strict(trusted_keys: Vec<VerifyingKey>) -> Self {
        Self {
            trusted_keys,
            allow_unsigned: false,
        }
    }

    /// Verify `signature_b64` over the domain-separated `digest_hex`.
    ///
    /// `digest_hex` must be the lowercase/uppercase hex SHA-256 of the binary
    /// that will be applied; the caller is responsible for having bound it to
    /// the on-disk bytes (AGT-004).
    pub fn verify(
        &self,
        digest_hex: &str,
        signature_b64: Option<&str>,
    ) -> Result<SignatureVerdict, UpdateSignatureError> {
        let Some(signature_b64) = signature_b64 else {
            if self.allow_unsigned {
                warn!(
                    "!!! DEBUG BUILD: applying an UNSIGNED agent update — signature verification is \
                     skipped only because this agent was built with debug_assertions. A release \
                     build refuses this update (AGT-005). !!!"
                );
                return Ok(SignatureVerdict::UnsignedDevBuild);
            }
            if self.trusted_keys.is_empty() {
                return Err(UpdateSignatureError::KeyNotConfigured);
            }
            return Err(UpdateSignatureError::Missing);
        };

        if self.trusted_keys.is_empty() {
            return Err(UpdateSignatureError::KeyNotConfigured);
        }
        let signature = parse_signature(signature_b64)?;
        let message = signed_message(digest_hex)?;
        if self
            .trusted_keys
            .iter()
            .any(|key| key.verify_strict(&message, &signature).is_ok())
        {
            Ok(SignatureVerdict::Verified)
        } else {
            Err(UpdateSignatureError::Invalid)
        }
    }
}

/// Build the exact byte string that is signed for a binary with SHA-256
/// `digest_hex`: [`SIGNING_DOMAIN`] followed by the 32 raw digest bytes.
pub fn signed_message(digest_hex: &str) -> Result<Vec<u8>, UpdateSignatureError> {
    let digest = hex::decode(digest_hex.trim())
        .map_err(|e| UpdateSignatureError::Malformed(format!("digest is not hex: {e}")))?;
    if digest.len() != 32 {
        return Err(UpdateSignatureError::Malformed(format!(
            "digest is {} bytes, expected 32 (SHA-256)",
            digest.len()
        )));
    }
    let mut message = Vec::with_capacity(SIGNING_DOMAIN.len() + digest.len());
    message.extend_from_slice(SIGNING_DOMAIN);
    message.extend_from_slice(&digest);
    Ok(message)
}

/// Parse a `.sig` sidecar / RPC `signature` value: base64 of the 64-byte
/// Ed25519 signature, surrounding whitespace ignored.
pub fn parse_signature(signature_b64: &str) -> Result<Signature, UpdateSignatureError> {
    let bytes = BASE64
        .decode(signature_b64.trim())
        .map_err(|e| UpdateSignatureError::Malformed(format!("signature is not base64: {e}")))?;
    let bytes: [u8; SIGNATURE_LENGTH] = bytes.as_slice().try_into().map_err(|_| {
        UpdateSignatureError::Malformed(format!(
            "signature is {} bytes, expected {SIGNATURE_LENGTH}",
            bytes.len()
        ))
    })?;
    Ok(Signature::from_bytes(&bytes))
}

/// Extract every Ed25519 key from the PEM `PUBLIC KEY` blocks in `pem`.
///
/// Blocks that are not valid Ed25519 SubjectPublicKeyInfo are skipped (a
/// garbled block can never *add* trust), and text outside blocks — comments,
/// the placeholder marker — is ignored. The placeholder file therefore yields an
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

/// Return the path of the `.sig` signature sidecar for a binary path.
pub fn signature_sidecar_path(binary_path: &Path) -> PathBuf {
    let mut name = binary_path.as_os_str().to_owned();
    name.push(".");
    name.push(SIGNATURE_EXT);
    PathBuf::from(name)
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Deterministic signing helpers shared by the update-module tests.
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// A fixed test signing key (never used outside tests).
    pub fn test_signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    /// Sign `digest_hex` exactly as release CI does, returning the base64
    /// sidecar value.
    pub fn sign_digest(key: &SigningKey, digest_hex: &str) -> String {
        let message = signed_message(digest_hex).expect("valid digest");
        BASE64.encode(key.sign(&message).to_bytes())
    }

    /// The PEM SPKI encoding of `key`'s public half, as the setup script writes it.
    pub fn public_key_pem(key: &SigningKey) -> String {
        let mut der = ED25519_SPKI_PREFIX.to_vec();
        der.extend_from_slice(key.verifying_key().as_bytes());
        format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
            BASE64.encode(der)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    /// SHA-256 of "abc" (NIST vector).
    const DIGEST: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    /// SHA-256 of "abd" — a "tampered binary".
    const OTHER_DIGEST: &str = "a52d159f262b2c6ddb724a61840befc36eb30c88877a4030b65cbe86298449c9";

    fn strict_for(seed: u8) -> SignaturePolicy {
        SignaturePolicy::strict(vec![test_signing_key(seed).verifying_key()])
    }

    #[test]
    fn valid_signature_verifies() {
        let key = test_signing_key(1);
        let sig = sign_digest(&key, DIGEST);
        assert_eq!(
            strict_for(1).verify(DIGEST, Some(&sig)),
            Ok(SignatureVerdict::Verified)
        );
        // Digest case and surrounding whitespace do not matter.
        assert_eq!(
            strict_for(1).verify(&DIGEST.to_ascii_uppercase(), Some(&format!("  {sig}\n"))),
            Ok(SignatureVerdict::Verified)
        );
    }

    #[test]
    fn tampered_binary_is_rejected() {
        let sig = sign_digest(&test_signing_key(1), DIGEST);
        assert_eq!(
            strict_for(1).verify(OTHER_DIGEST, Some(&sig)),
            Err(UpdateSignatureError::Invalid)
        );
    }

    #[test]
    fn wrong_key_is_rejected() {
        let sig = sign_digest(&test_signing_key(2), DIGEST);
        assert_eq!(
            strict_for(1).verify(DIGEST, Some(&sig)),
            Err(UpdateSignatureError::Invalid)
        );
    }

    #[test]
    fn missing_signature_fails_closed_in_strict_policy() {
        assert_eq!(
            strict_for(1).verify(DIGEST, None),
            Err(UpdateSignatureError::Missing)
        );
    }

    #[test]
    fn placeholder_key_fails_closed_signed_or_not() {
        let placeholder = SignaturePolicy::strict(parse_public_keys_pem(EMBEDDED_PUBLIC_KEYS_PEM));
        let sig = sign_digest(&test_signing_key(1), DIGEST);
        // The committed placeholder carries no key, so nothing can verify.
        if EMBEDDED_PUBLIC_KEYS_PEM.contains("TERMIHUB-AGENT-UPDATE-KEY-PLACEHOLDER") {
            assert_eq!(
                placeholder.verify(DIGEST, Some(&sig)),
                Err(UpdateSignatureError::KeyNotConfigured)
            );
            assert_eq!(
                placeholder.verify(DIGEST, None),
                Err(UpdateSignatureError::KeyNotConfigured)
            );
        }
        // Independently of the committed file: an empty key set always fails.
        let empty = SignaturePolicy::strict(Vec::new());
        assert_eq!(
            empty.verify(DIGEST, Some(&sig)),
            Err(UpdateSignatureError::KeyNotConfigured)
        );
        assert_eq!(
            empty.verify(DIGEST, None),
            Err(UpdateSignatureError::KeyNotConfigured)
        );
    }

    #[test]
    fn malformed_signature_and_digest_are_rejected() {
        let policy = strict_for(1);
        assert!(matches!(
            policy.verify(DIGEST, Some("not base64!!")),
            Err(UpdateSignatureError::Malformed(_))
        ));
        assert!(matches!(
            policy.verify(DIGEST, Some(&BASE64.encode([0u8; 10]))),
            Err(UpdateSignatureError::Malformed(_))
        ));
        let sig = sign_digest(&test_signing_key(1), DIGEST);
        assert!(matches!(
            policy.verify("deadbeef", Some(&sig)),
            Err(UpdateSignatureError::Malformed(_))
        ));
        assert!(matches!(
            policy.verify("zz", Some(&sig)),
            Err(UpdateSignatureError::Malformed(_))
        ));
    }

    #[test]
    fn debug_allowance_tolerates_only_a_missing_signature() {
        let dev = SignaturePolicy {
            trusted_keys: vec![test_signing_key(1).verifying_key()],
            allow_unsigned: true,
        };
        assert_eq!(
            dev.verify(DIGEST, None),
            Ok(SignatureVerdict::UnsignedDevBuild)
        );
        // A present-but-bad signature is still rejected in a debug build.
        let foreign = sign_digest(&test_signing_key(9), DIGEST);
        assert_eq!(
            dev.verify(DIGEST, Some(&foreign)),
            Err(UpdateSignatureError::Invalid)
        );
    }

    #[test]
    fn build_policy_allows_unsigned_only_in_debug_builds() {
        assert_eq!(
            SignaturePolicy::for_build().allow_unsigned,
            cfg!(debug_assertions)
        );
    }

    #[test]
    fn pem_parsing_extracts_keys_and_ignores_noise() {
        let a = test_signing_key(1);
        let b = test_signing_key(2);
        let pem = format!(
            "# comment\n{}garbage between\n{}-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
            public_key_pem(&a),
            public_key_pem(&b)
        );
        let keys = parse_public_keys_pem(&pem);
        assert_eq!(keys, vec![a.verifying_key(), b.verifying_key()]);
        assert!(parse_public_keys_pem("").is_empty());
    }

    #[test]
    fn rotation_overlap_accepts_either_trusted_key() {
        let old = test_signing_key(1);
        let new = test_signing_key(2);
        let policy = SignaturePolicy::strict(parse_public_keys_pem(&format!(
            "{}{}",
            public_key_pem(&old),
            public_key_pem(&new)
        )));
        for key in [&old, &new] {
            assert_eq!(
                policy.verify(DIGEST, Some(&sign_digest(key, DIGEST))),
                Ok(SignatureVerdict::Verified)
            );
        }
    }

    /// Interop vector produced by the exact `openssl` pipeline release CI and
    /// `setup-agent-signing-key.sh` use (throwaway key, discarded):
    ///
    /// ```text
    /// openssl genpkey -algorithm ed25519 -out k.pem
    /// openssl pkey -in k.pem -pubout                       # → OPENSSL_PUB_PEM
    /// printf abc > bin
    /// { printf 'termihub-agent-update-v1\0'; openssl dgst -sha256 -binary bin; } > msg
    /// openssl pkeyutl -sign -rawin -inkey k.pem -in msg | openssl base64 -A   # → OPENSSL_SIG
    /// ```
    ///
    /// Guards against the CI signing format and the agent drifting apart.
    const OPENSSL_PUB_PEM: &str = "-----BEGIN PUBLIC KEY-----\n\
        MCowBQYDK2VwAyEATzXH8w+M7VYTktYiO1RpxO2fuKRzuB1xO9bE442CSBo=\n\
        -----END PUBLIC KEY-----\n";
    const OPENSSL_SIG: &str =
        "v0DBAoH70CDQ8IBa+RyrZ5o00j5kE3UE6tEDlimQV4BX9oNeUpc8pcvlU6/IOB/ct+Xu/QuoI6tCrDQ8n5TIDw==";

    #[test]
    fn openssl_produced_signature_verifies() {
        let policy = SignaturePolicy::strict(parse_public_keys_pem(OPENSSL_PUB_PEM));
        assert_eq!(
            policy.verify(DIGEST, Some(OPENSSL_SIG)),
            Ok(SignatureVerdict::Verified)
        );
        assert_eq!(
            policy.verify(OTHER_DIGEST, Some(OPENSSL_SIG)),
            Err(UpdateSignatureError::Invalid)
        );
    }

    #[test]
    fn signed_message_is_domain_prefix_plus_raw_digest() {
        let msg = signed_message(DIGEST).unwrap();
        assert_eq!(&msg[..SIGNING_DOMAIN.len()], SIGNING_DOMAIN);
        assert_eq!(&msg[SIGNING_DOMAIN.len()..], hex::decode(DIGEST).unwrap());
        assert_eq!(msg.len(), 25 + 32);
    }

    #[test]
    fn signature_sidecar_path_appends_sig() {
        assert_eq!(
            signature_sidecar_path(Path::new("/tmp/updates/termihub-agent-linux-x64")),
            PathBuf::from("/tmp/updates/termihub-agent-linux-x64.sig")
        );
    }
}
