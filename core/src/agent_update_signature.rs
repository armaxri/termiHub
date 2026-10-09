//! Ed25519 signature verification for agent update binaries (AGT-005, #3213,
//! #3330).
//!
//! Shared by both ends of an agent update so they can never drift apart:
//!
//! - the **agent** gates every self-update it applies (GitHub-fetched and
//!   desktop-pushed `agent.request_update`) on [`SignaturePolicy::verify`];
//! - the **desktop** verifies the resolved binary (cache, bundle, download)
//!   before *any* deploy path — immediate shutdown + install over SSH, the
//!   Windows fallback, and the coordinated push (#3330).
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
//! - **Trusted key** — `agent/keys/update-signing.pub.pem`, compiled into this
//!   crate (and so into both the agent and the desktop) via `include_str!`: one or more PEM `PUBLIC KEY` (SubjectPublicKeyInfo) blocks
//!   holding raw Ed25519 keys. More than one block is accepted so a key can be
//!   rotated with an overlap window. Text outside the blocks is ignored. The
//!   committed file is a **placeholder with no block** until the maintainer runs
//!   `scripts/internal/setup-agent-signing-key.sh`; while it is, a release-built
//!   agent trusts no key and refuses every update, and a release desktop refuses
//!   to deploy any agent binary (fail closed).
//!
//! # Build policy
//!
//! The agent uses [`SignaturePolicy::for_build`] (keyed on `debug_assertions`);
//! the desktop uses [`SignaturePolicy::embedded`] keyed on its own dev-build
//! rule (debug, CI dev build, or `-dev` version — the same rule that relaxes the
//! AGT-007 checksum requirement). Either way:
//!
//! - **Release builds** (`debug_assertions` off — every shipped agent, and the
//!   `test-hooks` system-test build): a valid signature from an embedded key is
//!   **mandatory**. Missing, malformed, or non-verifying signatures, and the
//!   placeholder key, all reject.
//! - **Debug / dev builds** (`cargo test`, `scripts/dev.sh`'s `target/debug`
//!   agent, dev/branch desktop builds): a *missing* signature is tolerated with a
//!   loud warning so the local dev loop can push locally built, unsigned agents.
//!   A signature that *is* present must still verify — a bad signature is never
//!   accepted.

use std::path::{Path, PathBuf};

#[cfg(any(test, feature = "agent-update-signing-test-support"))]
use base64::engine::general_purpose::STANDARD as BASE64;
#[cfg(any(test, feature = "agent-update-signing-test-support"))]
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey, SIGNATURE_LENGTH};
use tracing::warn;

use crate::ed25519_detached::{
    any_trusted_key_verifies, domain_message, parse_b64_signature, SignatureParseError,
};

/// File-name suffix of the detached signature sidecar published next to every
/// agent binary release asset (e.g. `termihub-agent-linux-x64.sig`).
pub const SIGNATURE_EXT: &str = "sig";

/// Domain-separation prefix of the signed message (see the module docs).
/// Changing it invalidates every published signature — bump the `-vN` suffix
/// only together with release CI.
pub const SIGNING_DOMAIN: &[u8] = b"termihub-agent-update-v1\0";

/// The committed trusted-key file, compiled in. It lives next to the agent crate
/// (where the setup script, release CI and docs expect it) but is embedded here
/// so the agent and the desktop trust exactly the same key set.
const EMBEDDED_PUBLIC_KEYS_PEM: &str = include_str!("../../agent/keys/update-signing.pub.pem");

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
    /// unsigned allowance on **only** when `debug_assertions` is on. The agent's
    /// production policy.
    pub fn for_build() -> Self {
        Self::embedded(cfg!(debug_assertions))
    }

    /// The embedded key(s) with an explicit unsigned allowance. The desktop
    /// passes its dev-build rule (`allow_unsigned = true` only for dev/branch
    /// builds), mirroring the AGT-007 checksum posture.
    pub fn embedded(allow_unsigned: bool) -> Self {
        Self::new(
            parse_public_keys_pem(EMBEDDED_PUBLIC_KEYS_PEM),
            allow_unsigned,
        )
    }

    /// A policy trusting exactly `trusted_keys`, with an explicit unsigned
    /// allowance.
    pub fn new(trusted_keys: Vec<VerifyingKey>, allow_unsigned: bool) -> Self {
        Self {
            trusted_keys,
            allow_unsigned,
        }
    }

    /// A strict policy trusting exactly `trusted_keys` — the release-build rule,
    /// independent of how the current binary was compiled. Used by tests to
    /// exercise the production behaviour from a debug test binary.
    pub fn strict(trusted_keys: Vec<VerifyingKey>) -> Self {
        Self::new(trusted_keys, false)
    }

    /// This policy, additionally trusting `keys`. The unsigned allowance and
    /// every verification rule stay exactly as they are — only the key set
    /// grows. The agent uses it to add the committed **test-only** key in
    /// `test-hooks` system-test builds (#4083); a shipped build never calls it.
    pub fn with_extra_trusted_keys(mut self, keys: impl IntoIterator<Item = VerifyingKey>) -> Self {
        self.trusted_keys.extend(keys);
        self
    }

    /// Whether a missing signature is tolerated (dev/debug builds only).
    pub fn allows_unsigned(&self) -> bool {
        self.allow_unsigned
    }

    /// Whether at least one trusted key is configured. `false` for a build made
    /// from the placeholder key file — such a policy can verify nothing.
    pub fn has_trusted_keys(&self) -> bool {
        !self.trusted_keys.is_empty()
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
                    "!!! DEV BUILD: accepting an UNSIGNED agent binary — signature verification is \
                     skipped only because this is a debug/dev build. A release build refuses this \
                     binary (AGT-005). !!!"
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
        if any_trusted_key_verifies(&self.trusted_keys, &message, &signature) {
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
    let digest: [u8; 32] = digest.as_slice().try_into().map_err(|_| {
        UpdateSignatureError::Malformed(format!(
            "digest is {} bytes, expected 32 (SHA-256)",
            digest.len()
        ))
    })?;
    Ok(domain_message(SIGNING_DOMAIN, &digest))
}

/// Parse a `.sig` sidecar / RPC `signature` value: base64 of the 64-byte
/// Ed25519 signature, surrounding whitespace ignored.
///
/// The shared [`parse_b64_signature`] does the decoding; its error is mapped
/// into [`UpdateSignatureError::Malformed`] with this module's wording.
pub fn parse_signature(signature_b64: &str) -> Result<Signature, UpdateSignatureError> {
    parse_b64_signature(signature_b64).map_err(|e| {
        UpdateSignatureError::Malformed(match e {
            SignatureParseError::NotBase64(e) => format!("signature is not base64: {e}"),
            SignatureParseError::WrongLength(n) => {
                format!("signature is {n} bytes, expected {SIGNATURE_LENGTH}")
            }
        })
    })
}

pub use crate::ed25519_pem::parse_public_keys_pem;

/// Return the path of the `.sig` signature sidecar for a binary path.
pub fn signature_sidecar_path(binary_path: &Path) -> PathBuf {
    let mut name = binary_path.as_os_str().to_owned();
    name.push(".");
    name.push(SIGNATURE_EXT);
    PathBuf::from(name)
}

/// Deterministic signing helpers for tests of the agent and the desktop.
///
/// Compiled only for this crate's tests or behind the
/// `agent-update-signing-test-support` feature, which consumers enable from
/// `[dev-dependencies]` only — never in a shipping build.
#[cfg(any(test, feature = "agent-update-signing-test-support"))]
// Test-only helpers: a panic on a malformed *test* digest is the right outcome.
#[allow(clippy::expect_used)]
pub mod test_support {
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

    /// Sign `digest_hex` under a **different** domain-separation prefix,
    /// returning the base64 value. For regression tests proving a signature
    /// made for another purpose (e.g. the plugin index) never verifies as an
    /// agent update.
    pub fn sign_digest_in_domain(key: &SigningKey, domain: &[u8], digest_hex: &str) -> String {
        let digest: [u8; 32] = hex::decode(digest_hex.trim())
            .expect("hex digest")
            .try_into()
            .expect("a 32-byte digest");
        BASE64.encode(key.sign(&domain_message(domain, &digest)).to_bytes())
    }

    /// Parse an Ed25519 private key from an `openssl genpkey` PKCS#8 PEM (text
    /// outside the `PRIVATE KEY` block ignored). Used to load the committed
    /// TEST-ONLY key (`agent/keys/test-only/`, #4083).
    pub fn signing_key_from_pkcs8_pem(pem: &str) -> SigningKey {
        /// DER prefix of an Ed25519 PKCS#8 v1 private key (RFC 8410); the
        /// 32-byte seed follows it.
        const ED25519_PKCS8_PREFIX: [u8; 16] = [
            0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22,
            0x04, 0x20,
        ];
        let body: String = pem
            .lines()
            .skip_while(|l| l.trim() != "-----BEGIN PRIVATE KEY-----")
            .skip(1)
            .take_while(|l| l.trim() != "-----END PRIVATE KEY-----")
            .map(str::trim)
            .collect();
        let der = BASE64.decode(body).expect("private key PEM is base64");
        let seed: [u8; 32] = der
            .strip_prefix(&ED25519_PKCS8_PREFIX[..])
            .expect("an Ed25519 PKCS#8 private key")
            .try_into()
            .expect("a 32-byte Ed25519 seed");
        SigningKey::from_bytes(&seed)
    }

    /// The PEM SPKI encoding of `key`'s public half, as the setup script writes it.
    pub fn public_key_pem(key: &SigningKey) -> String {
        crate::ed25519_pem::public_key_pem(&key.verifying_key())
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
    fn embedded_policy_carries_the_requested_allowance_and_committed_keys() {
        let strict = SignaturePolicy::embedded(false);
        let relaxed = SignaturePolicy::embedded(true);
        assert!(!strict.allows_unsigned());
        assert!(relaxed.allows_unsigned());
        let committed = !parse_public_keys_pem(EMBEDDED_PUBLIC_KEYS_PEM).is_empty();
        assert_eq!(strict.has_trusted_keys(), committed);
        assert!(!SignaturePolicy::strict(Vec::new()).has_trusted_keys());
    }

    #[test]
    fn build_policy_allows_unsigned_only_in_debug_builds() {
        assert_eq!(
            SignaturePolicy::for_build().allow_unsigned,
            cfg!(debug_assertions)
        );
    }

    #[test]
    fn extra_trusted_keys_extend_the_set_without_relaxing_the_policy() {
        let policy = strict_for(1).with_extra_trusted_keys([test_signing_key(2).verifying_key()]);
        for seed in [1, 2] {
            let sig = sign_digest(&test_signing_key(seed), DIGEST);
            assert_eq!(
                policy.verify(DIGEST, Some(&sig)),
                Ok(SignatureVerdict::Verified)
            );
        }
        // Still strict: unsigned and foreign signatures are refused.
        assert!(!policy.allows_unsigned());
        assert_eq!(
            policy.verify(DIGEST, None),
            Err(UpdateSignatureError::Missing)
        );
        let foreign = sign_digest(&test_signing_key(3), DIGEST);
        assert_eq!(
            policy.verify(DIGEST, Some(&foreign)),
            Err(UpdateSignatureError::Invalid)
        );
    }

    /// The committed TEST-ONLY key (#4083) must never be trusted by the
    /// embedded (shipped) key set: neither the agent's build policy nor the
    /// desktop's embedded policy may accept a test-key signature.
    #[test]
    fn embedded_policies_never_trust_the_test_only_key() {
        let test_pub = include_str!("../../agent/keys/test-only/update-signing-TEST-ONLY.pub.pem");
        let test_keys = parse_public_keys_pem(test_pub);
        assert_eq!(
            test_keys.len(),
            1,
            "the test-only key file must hold one key"
        );
        let embedded = parse_public_keys_pem(EMBEDDED_PUBLIC_KEYS_PEM);
        assert!(
            !embedded.contains(&test_keys[0]),
            "the TEST-ONLY key must never be added to agent/keys/update-signing.pub.pem"
        );
        // And a real signature made with the committed private half is refused
        // by both shipped policies.
        let private = signing_key_from_pkcs8_pem(include_str!(
            "../../agent/keys/test-only/update-signing-TEST-ONLY.key.pem"
        ));
        assert_eq!(private.verifying_key(), test_keys[0]);
        let sig = sign_digest(&private, DIGEST);
        for policy in [
            SignaturePolicy::for_build(),
            SignaturePolicy::embedded(false),
        ] {
            assert!(matches!(
                policy.verify(DIGEST, Some(&sig)),
                Err(UpdateSignatureError::Invalid | UpdateSignatureError::KeyNotConfigured)
            ));
        }
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

    /// Regression (#4365): the shared `ed25519_detached` parser is mapped back to
    /// this module's exact `Malformed` wording, digest errors included.
    #[test]
    fn malformed_messages_are_unchanged() {
        let policy = strict_for(1);
        let Err(UpdateSignatureError::Malformed(msg)) = policy.verify(DIGEST, Some("not base64!!"))
        else {
            panic!("expected a malformed rejection");
        };
        assert!(msg.starts_with("signature is not base64: "), "{msg}");
        assert_eq!(
            policy.verify(DIGEST, Some(&BASE64.encode([0u8; 10]))),
            Err(UpdateSignatureError::Malformed(
                "signature is 10 bytes, expected 64".to_string()
            ))
        );
        let sig = sign_digest(&test_signing_key(1), DIGEST);
        assert_eq!(
            policy.verify("deadbeef", Some(&sig)),
            Err(UpdateSignatureError::Malformed(
                "digest is 4 bytes, expected 32 (SHA-256)".to_string()
            ))
        );
        let Err(UpdateSignatureError::Malformed(msg)) = policy.verify("zz", Some(&sig)) else {
            panic!("expected a malformed rejection");
        };
        assert!(msg.starts_with("digest is not hex: "), "{msg}");
    }

    /// Regression (#4365): a signature by a trusted key over the same digest but
    /// under another domain (the plugin-index one) never verifies as an update.
    #[test]
    fn wrong_domain_signature_is_rejected() {
        let sig =
            sign_digest_in_domain(&test_signing_key(1), b"termihub-plugin-index-v1\0", DIGEST);
        assert_eq!(
            strict_for(1).verify(DIGEST, Some(&sig)),
            Err(UpdateSignatureError::Invalid)
        );
        assert_eq!(SIGNING_DOMAIN, b"termihub-agent-update-v1\0");
        // The helper under the agent's own domain is exactly `sign_digest`.
        assert_eq!(
            sign_digest_in_domain(&test_signing_key(1), SIGNING_DOMAIN, DIGEST),
            sign_digest(&test_signing_key(1), DIGEST)
        );
    }

    #[test]
    fn signature_sidecar_path_appends_sig() {
        assert_eq!(
            signature_sidecar_path(Path::new("/tmp/updates/termihub-agent-linux-x64")),
            PathBuf::from("/tmp/updates/termihub-agent-linux-x64.sig")
        );
    }
}
