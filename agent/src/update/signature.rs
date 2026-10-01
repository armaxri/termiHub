//! Ed25519 signature verification for agent self-updates (AGT-005, #3213).
//!
//! The implementation lives in `termihub_core::agent_update_signature` so the
//! desktop verifies agent binaries with exactly the same code and trusted key
//! set before deploying them (#3330). This module re-exports it under the
//! agent's historical `update::signature` path and adds [`agent_policy`], the
//! one policy every agent update path uses.
//!
//! # The TEST-ONLY key (#4083)
//!
//! A system-test agent (built with the `test-hooks` cargo feature) additionally
//! trusts the committed, throwaway key in
//! `agent/keys/test-only/update-signing-TEST-ONLY.pub.pem`, so the full-app
//! deferred-update E2E can stage a binary it signed itself and watch a
//! release-built agent really swap it in. Nothing else changes: the same
//! [`SignaturePolicy::verify`] runs, with the same digest (AGT-004) and
//! signature (AGT-005) gates — there is no "skip signature" path. Without
//! `test-hooks` (every shipped build) the key is not compiled in at all, which
//! `scripts/internal/assert-no-test-signing-key.sh` checks on the built
//! binaries in CI.

pub use termihub_core::agent_update_signature::{
    signature_sidecar_path, SignaturePolicy, UpdateSignatureError,
};

#[cfg(test)]
pub(crate) use termihub_core::agent_update_signature::test_support;

/// The TEST-ONLY public key, compiled in only for `test-hooks` builds. See the
/// module docs and `agent/keys/test-only/README.md`.
#[cfg(feature = "test-hooks")]
const TEST_ONLY_PUBLIC_KEY_PEM: &str =
    include_str!("../../keys/test-only/update-signing-TEST-ONLY.pub.pem");

/// The update-signature policy of this agent build.
///
/// [`SignaturePolicy::for_build`] (the embedded release key; the unsigned
/// allowance only under `debug_assertions`), plus — in a `test-hooks`
/// system-test build only — the TEST-ONLY key (#4083).
pub fn agent_policy() -> SignaturePolicy {
    let policy = SignaturePolicy::for_build();
    #[cfg(feature = "test-hooks")]
    let policy = policy.with_extra_trusted_keys(
        termihub_core::agent_update_signature::parse_public_keys_pem(TEST_ONLY_PUBLIC_KEY_PEM),
    );
    policy
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_core::agent_update_signature::parse_public_keys_pem;

    const TEST_ONLY_PRIVATE_KEY_PEM: &str =
        include_str!("../../keys/test-only/update-signing-TEST-ONLY.key.pem");
    const TEST_ONLY_PUBLIC_KEY_FILE: &str =
        include_str!("../../keys/test-only/update-signing-TEST-ONLY.pub.pem");

    /// SHA-256 of "abc" (NIST vector).
    const DIGEST: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn sign_with_test_only_key() -> String {
        test_support::sign_digest(
            &test_support::signing_key_from_pkcs8_pem(TEST_ONLY_PRIVATE_KEY_PEM),
            DIGEST,
        )
    }

    #[test]
    fn committed_test_only_key_pair_matches() {
        let keys = parse_public_keys_pem(TEST_ONLY_PUBLIC_KEY_FILE);
        assert_eq!(
            keys,
            vec![
                test_support::signing_key_from_pkcs8_pem(TEST_ONLY_PRIVATE_KEY_PEM).verifying_key()
            ]
        );
    }

    /// The shipped rule: the release build policy never accepts a signature
    /// made with the TEST-ONLY key, whatever the build's unsigned allowance.
    #[test]
    fn core_build_policy_rejects_test_only_signatures() {
        assert_eq!(
            SignaturePolicy::for_build().verify(DIGEST, Some(&sign_with_test_only_key())),
            Err(UpdateSignatureError::Invalid)
        );
    }

    /// Without `test-hooks` the agent's own policy is the build policy and
    /// rejects a TEST-ONLY signature too.
    #[cfg(not(feature = "test-hooks"))]
    #[test]
    fn agent_policy_without_test_hooks_rejects_test_only_signatures() {
        assert_eq!(
            agent_policy().verify(DIGEST, Some(&sign_with_test_only_key())),
            Err(UpdateSignatureError::Invalid)
        );
    }

    /// With `test-hooks` the agent trusts the TEST-ONLY key — through the
    /// unchanged verification: a tampered digest or a foreign key still fails.
    #[cfg(feature = "test-hooks")]
    #[test]
    fn agent_policy_with_test_hooks_verifies_test_only_signatures() {
        use termihub_core::agent_update_signature::SignatureVerdict;

        let policy = agent_policy();
        let sig = sign_with_test_only_key();
        assert_eq!(
            policy.verify(DIGEST, Some(&sig)),
            Ok(SignatureVerdict::Verified)
        );
        // SHA-256 of "abd": the same signature over another binary is refused.
        let other = "a52d159f262b2c6ddb724a61840befc36eb30c88877a4030b65cbe86298449c9";
        assert_eq!(
            policy.verify(other, Some(&sig)),
            Err(UpdateSignatureError::Invalid)
        );
        let foreign = test_support::sign_digest(&test_support::test_signing_key(9), DIGEST);
        assert_eq!(
            policy.verify(DIGEST, Some(&foreign)),
            Err(UpdateSignatureError::Invalid)
        );
    }

    /// Positive control for the CI binary grep
    /// (`scripts/internal/assert-no-test-signing-key.sh`): in a `test-hooks`
    /// build the key's base64 line is embedded verbatim in the binary, so the
    /// grep that must find nothing in a shipped agent does find it here.
    #[cfg(feature = "test-hooks")]
    #[test]
    fn test_only_key_is_embedded_verbatim_in_a_test_hooks_binary() {
        let needle = TEST_ONLY_PUBLIC_KEY_PEM
            .lines()
            .find(|l| l.starts_with("MCow"))
            .expect("the key's base64 line");
        // Keep the const referenced from non-test code paths too.
        assert!(agent_policy().has_trusted_keys());
        let exe = std::env::current_exe().expect("test binary path");
        let bytes = std::fs::read(exe).expect("read test binary");
        assert!(
            bytes.windows(needle.len()).any(|w| w == needle.as_bytes()),
            "the TEST-ONLY key must be embedded verbatim, or the CI grep checks nothing"
        );
    }
}
