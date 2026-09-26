//! Verifier for platforms without a supported OS re-authentication API.

use super::{OsAuthCapability, OsAuthError, OsAuthPurpose, OsAuthSuccess, OsUserVerifier};

/// A verifier that is never available and always refuses (fails closed).
///
/// Used on Linux and other platforms, and in unit tests.
pub struct UnsupportedVerifier {
    reason: String,
}

impl UnsupportedVerifier {
    /// Create a verifier that reports `reason` as why it is unavailable.
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

impl OsUserVerifier for UnsupportedVerifier {
    fn capability(&self, _purpose: OsAuthPurpose) -> OsAuthCapability {
        OsAuthCapability::unavailable("system authentication", self.reason.clone())
    }

    fn verify(
        &self,
        _purpose: OsAuthPurpose,
        _reason: &str,
        _owner_window: Option<isize>,
    ) -> Result<OsAuthSuccess, OsAuthError> {
        Err(OsAuthError::Unavailable(self.reason.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_succeeds() {
        let verifier = UnsupportedVerifier::new("nope");
        for purpose in [
            OsAuthPurpose::ReauthExport,
            OsAuthPurpose::EnableBiometricUnlock,
            OsAuthPurpose::BiometricUnlock,
        ] {
            assert!(!verifier.capability(purpose).available);
            assert_eq!(
                verifier.verify(purpose, "do a thing", None),
                Err(OsAuthError::Unavailable("nope".to_string()))
            );
        }
    }

    #[test]
    fn test_builds_never_use_the_real_os_verifier() {
        // A unit test must never be able to pop a real Touch ID / Windows
        // Hello prompt (or silently succeed): the platform verifier is the
        // unavailable one under cfg(test).
        let verifier = super::super::platform_verifier();
        assert!(!verifier.capability(OsAuthPurpose::ReauthExport).available);
        assert!(matches!(
            verifier.verify(OsAuthPurpose::ReauthExport, "x", None),
            Err(OsAuthError::Unavailable(_))
        ));
    }
}
