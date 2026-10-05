//! Ed25519 signature over the curated plugin index (#3716).
//!
//! The plugin index (`plugins/index.json`, ADR-17) is fetched over HTTPS and
//! carries a SHA-256 per package, but a checksum in the index only proves a
//! package is the one *the index* lists. This module adds **authenticity of the
//! index itself**: the default index is only accepted when a detached signature
//! made by the termiHub plugin-index key verifies.
//!
//! It reuses the agent-update scheme (AGT-005, #3213 —
//! `core/src/agent_update_signature.rs`) with a **separate key** and its own
//! domain-separation prefix, so a signature made for one purpose can never be
//! replayed as the other.
//!
//! # What is signed
//!
//! ```text
//! message   = b"termihub-plugin-index-v1\0" || SHA-256(index bytes)   (24 + 1 + 32 bytes)
//! signature = Ed25519-sign(index_private_key, message)                (64 bytes)
//! ```
//!
//! The signature covers the exact bytes served — it is checked **before** the
//! index is parsed, so a tampered document never reaches the JSON parser.
//!
//! # File formats
//!
//! - **Signature** — `<index URL>.sig` (for the default index
//!   `plugins/index.json.sig` next to `plugins/index.json`): the 64-byte
//!   signature, standard base64, one line (surrounding whitespace ignored),
//!   at most [`MAX_INDEX_SIGNATURE_BYTES`].
//! - **Trusted key** — `plugins/keys/index-signing.pub.pem`, compiled in via
//!   `include_str!`, in the same PEM SubjectPublicKeyInfo format as the agent
//!   key ([`crate::ed25519_pem`]). One or more blocks (rotation overlap).
//!
//! # Policy
//!
//! [`IndexSignaturePolicy::check`] decides, given the index bytes and the
//! signature (if one was served):
//!
//! - **Placeholder key** (no key compiled in, i.e. before the maintainer ran
//!   `scripts/internal/setup-plugin-index-signing-key.sh`): the index is
//!   accepted as [`IndexSignatureStatus::NotConfigured`] — nothing is reported
//!   as verified, but Browse keeps working. This deliberately differs from the
//!   agent-update key, which fails closed on the placeholder: an index is a
//!   discovery aid (every package still passes its own signature and trust
//!   gates), so disabling discovery until a key ceremony would buy nothing.
//! - **Signature required** (the default index in a release build): a missing,
//!   malformed or non-verifying signature rejects the index.
//! - **Signature optional** (a custom index URL, or the default index in a dev
//!   build): a *missing* signature is accepted as
//!   [`IndexSignatureStatus::Unsigned`], which the UI shows as a visible notice.
//!   A signature that *is* present must still verify against the termiHub key —
//!   a bad signature is never accepted.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey, SIGNATURE_LENGTH};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ed25519_pem::parse_public_keys_pem;

/// Suffix appended (after a `.`) to an index URL to locate its signature.
pub const INDEX_SIGNATURE_EXT: &str = "sig";

/// Domain-separation prefix of the signed message. Changing it invalidates
/// every published index signature — bump the `-vN` suffix only together with
/// `scripts/internal/plugin-index-signing.sh`.
pub const INDEX_SIGNING_DOMAIN: &[u8] = b"termihub-plugin-index-v1\0";

/// Upper bound for a fetched `.sig` file. A real one is 88 base64 characters
/// plus a newline; anything much larger is not a signature.
pub const MAX_INDEX_SIGNATURE_BYTES: usize = 1024;

/// Marker line of the committed placeholder key file.
pub const INDEX_KEY_PLACEHOLDER_MARKER: &str = "TERMIHUB-PLUGIN-INDEX-KEY-PLACEHOLDER";

/// The committed trusted-key file, compiled in.
const EMBEDDED_INDEX_KEYS_PEM: &str =
    include_str!("../../../plugins/keys/index-signing.pub.pem");

/// How a loaded index was authenticated — shown in the Browse view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../src/types/generated/",
        rename = "PluginIndexSignatureStatus"
    )
)]
#[serde(rename_all = "camelCase")]
pub enum IndexSignatureStatus {
    /// A signature from the embedded termiHub plugin-index key verified.
    Verified,
    /// No signature was served and the policy allowed that (a custom index, or
    /// the default index in a dev build). The contents are not authenticated.
    Unsigned,
    /// This build carries the placeholder key, so it cannot check any index
    /// signature. Nothing is reported as verified.
    NotConfigured,
}

/// Why an index's signature was refused. Every variant rejects the index.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IndexSignatureError {
    /// No signature was served, but this index requires one.
    #[error(
        "the plugin index has no signature (`.sig`) — the default index is only accepted when \
         signed by the termiHub plugin-index key"
    )]
    Missing,
    /// The signature file is not a base64 Ed25519 signature.
    #[error("the plugin index signature is malformed: {0}")]
    Malformed(String),
    /// Well-formed, but not made by a trusted key over these exact bytes — a
    /// tampered index or a foreign signer.
    #[error(
        "the plugin index signature does not verify against the termiHub plugin-index key — \
         the index may have been tampered with"
    )]
    Invalid,
}

/// The keys an index may be signed by, and whether a signature is mandatory.
#[derive(Debug, Clone)]
pub struct IndexSignaturePolicy {
    trusted_keys: Vec<VerifyingKey>,
    require_signature: bool,
}

impl IndexSignaturePolicy {
    /// The embedded (committed) key(s), with the given requirement.
    pub fn embedded(require_signature: bool) -> Self {
        Self::new(embedded_index_keys(), require_signature)
    }

    /// A policy trusting exactly `trusted_keys`.
    pub fn new(trusted_keys: Vec<VerifyingKey>, require_signature: bool) -> Self {
        Self {
            trusted_keys,
            require_signature,
        }
    }

    /// Whether at least one key is configured (`false` for the placeholder).
    pub fn has_trusted_keys(&self) -> bool {
        !self.trusted_keys.is_empty()
    }

    /// Whether a missing signature rejects the index.
    pub fn requires_signature(&self) -> bool {
        self.require_signature
    }

    /// Check `signature` (the raw `.sig` file body, if one was served) over
    /// the exact `index_bytes`. See the module docs for the policy.
    pub fn check(
        &self,
        index_bytes: &[u8],
        signature: Option<&[u8]>,
    ) -> Result<IndexSignatureStatus, IndexSignatureError> {
        if self.trusted_keys.is_empty() {
            return Ok(IndexSignatureStatus::NotConfigured);
        }
        let Some(signature) = signature else {
            return if self.require_signature {
                Err(IndexSignatureError::Missing)
            } else {
                Ok(IndexSignatureStatus::Unsigned)
            };
        };
        let signature = parse_index_signature(signature)?;
        let message = index_signed_message(index_bytes);
        if self
            .trusted_keys
            .iter()
            .any(|key| key.verify_strict(&message, &signature).is_ok())
        {
            Ok(IndexSignatureStatus::Verified)
        } else {
            Err(IndexSignatureError::Invalid)
        }
    }
}

/// The Ed25519 key(s) in the committed `plugins/keys/index-signing.pub.pem`;
/// empty while it is the placeholder.
pub fn embedded_index_keys() -> Vec<VerifyingKey> {
    parse_public_keys_pem(EMBEDDED_INDEX_KEYS_PEM)
}

/// The exact byte string signed for an index: [`INDEX_SIGNING_DOMAIN`]
/// followed by the 32 raw SHA-256 bytes of `index_bytes`.
pub fn index_signed_message(index_bytes: &[u8]) -> Vec<u8> {
    let digest = Sha256::digest(index_bytes);
    let mut message = Vec::with_capacity(INDEX_SIGNING_DOMAIN.len() + digest.len());
    message.extend_from_slice(INDEX_SIGNING_DOMAIN);
    message.extend_from_slice(&digest);
    message
}

/// Parse a `.sig` body: base64 of the 64-byte signature, whitespace ignored.
fn parse_index_signature(raw: &[u8]) -> Result<Signature, IndexSignatureError> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| IndexSignatureError::Malformed("not UTF-8 text".to_string()))?;
    let bytes = BASE64
        .decode(text.trim())
        .map_err(|e| IndexSignatureError::Malformed(format!("not base64: {e}")))?;
    let bytes: [u8; SIGNATURE_LENGTH] = bytes.as_slice().try_into().map_err(|_| {
        IndexSignatureError::Malformed(format!(
            "{} bytes, expected {SIGNATURE_LENGTH}",
            bytes.len()
        ))
    })?;
    Ok(Signature::from_bytes(&bytes))
}

/// Deterministic signing helpers for the desktop's tests. Compiled only for
/// this crate's tests or behind `plugin-index-signing-test-support`, which is
/// enabled from `[dev-dependencies]` only.
#[cfg(any(test, feature = "plugin-index-signing-test-support"))]
pub mod test_support {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// A fixed test signing key (never used outside tests).
    pub fn test_index_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    /// Sign `index_bytes` exactly as `plugin-index-signing.sh sign` does,
    /// returning the `.sig` file body (base64 + newline).
    pub fn sign_index(key: &SigningKey, index_bytes: &[u8]) -> String {
        format!(
            "{}\n",
            BASE64.encode(key.sign(&index_signed_message(index_bytes)).to_bytes())
        )
    }
}

#[cfg(test)]
#[path = "index_signature_tests.rs"]
mod tests;
