//! macOS verifier: LocalAuthentication (`LAContext`).
//!
//! - Export re-authentication uses `deviceOwnerAuthentication`: Touch ID when
//!   available, otherwise (or on fallback) the macOS login password.
//! - Biometric unlock uses `deviceOwnerAuthenticationWithBiometrics`: Touch ID
//!   only. The "Use Master Password" fallback button cancels the prompt so the
//!   unlock dialog falls back to the master password. After a successful
//!   biometric evaluation the `evaluatedPolicyDomainState` (which changes when
//!   a fingerprint is added or removed) is hashed into the enrollment
//!   fingerprint, emulating `SecAccessControl.biometryCurrentSet`.
//!
//! `evaluatePolicy` is asynchronous and replies on a private framework queue;
//! this blocks the calling (non-main) thread on a channel until the reply
//! arrives, bounded by [`PROMPT_TIMEOUT`]. On timeout the context is
//! invalidated (which dismisses the prompt) and the verification fails.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_local_authentication::{LABiometryType, LAContext, LAError, LAPolicy};
use sha2::{Digest, Sha256};

use super::{OsAuthCapability, OsAuthError, OsAuthPurpose, OsAuthSuccess, OsUserVerifier};

/// Upper bound on how long a prompt may stay open before it is cancelled.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(300);

/// Verifier backed by macOS LocalAuthentication.
pub struct MacVerifier;

fn policy_for(purpose: OsAuthPurpose) -> LAPolicy {
    if purpose.is_biometric() {
        LAPolicy::DeviceOwnerAuthenticationWithBiometrics
    } else {
        LAPolicy::DeviceOwnerAuthentication
    }
}

fn biometry_label(context: &LAContext) -> &'static str {
    // SAFETY: plain property read on a live context.
    let kind = unsafe { context.biometryType() };
    if kind == LABiometryType::TouchID {
        "Touch ID"
    } else if kind == LABiometryType::FaceID {
        "Face ID"
    } else if kind == LABiometryType::OpticID {
        "Optic ID"
    } else {
        "Touch ID"
    }
}

fn method_label(context: &LAContext, purpose: OsAuthPurpose) -> String {
    if purpose.is_biometric() {
        biometry_label(context).to_string()
    } else {
        format!("{} or your Mac password", biometry_label(context))
    }
}

/// Map an `LAError` code to the fail-closed error taxonomy.
fn map_error(code: isize, description: String) -> OsAuthError {
    let code = LAError(code);
    if code == LAError::UserCancel
        || code == LAError::SystemCancel
        || code == LAError::AppCancel
        || code == LAError::UserFallback
    {
        OsAuthError::Cancelled
    } else if code == LAError::AuthenticationFailed || code == LAError::BiometryLockout {
        OsAuthError::Failed(description)
    } else if code == LAError::BiometryNotAvailable
        || code == LAError::BiometryNotEnrolled
        || code == LAError::PasscodeNotSet
        || code == LAError::NotInteractive
        || code == LAError::BiometryNotPaired
        || code == LAError::BiometryDisconnected
    {
        OsAuthError::Unavailable(description)
    } else {
        OsAuthError::Other(description)
    }
}

fn describe(error: &NSError) -> (isize, String) {
    (error.code(), error.localizedDescription().to_string())
}

fn new_context() -> Retained<LAContext> {
    // SAFETY: `LAContext` is a plain NSObject subclass; `new` has no preconditions.
    unsafe { LAContext::new() }
}

impl OsUserVerifier for MacVerifier {
    fn capability(&self, purpose: OsAuthPurpose) -> OsAuthCapability {
        let context = new_context();
        // SAFETY: preflight query on a live context; never prompts.
        match unsafe { context.canEvaluatePolicy_error(policy_for(purpose)) } {
            Ok(()) => OsAuthCapability::available(method_label(&context, purpose)),
            Err(error) => {
                let (_, description) = describe(&error);
                OsAuthCapability::unavailable(method_label(&context, purpose), description)
            }
        }
    }

    fn verify(
        &self,
        purpose: OsAuthPurpose,
        reason: &str,
        _owner_window: Option<isize>,
    ) -> Result<OsAuthSuccess, OsAuthError> {
        if reason.trim().is_empty() {
            // LocalAuthentication throws on an empty reason; refuse instead.
            return Err(OsAuthError::Other(
                "A reason is required for system authentication".to_string(),
            ));
        }
        let policy = policy_for(purpose);
        let context = new_context();
        // SAFETY: preflight query on a live context; never prompts.
        if let Err(error) = unsafe { context.canEvaluatePolicy_error(policy) } {
            let (code, description) = describe(&error);
            return Err(match map_error(code, description.clone()) {
                OsAuthError::Cancelled => OsAuthError::Unavailable(description),
                other => other,
            });
        }
        if purpose == OsAuthPurpose::BiometricUnlock {
            // The fallback button cancels the prompt; the unlock dialog then
            // falls back to the master password field.
            let title = NSString::from_str("Use Master Password");
            // SAFETY: setter on a live context with a valid NSString.
            unsafe { context.setLocalizedFallbackTitle(Some(&title)) };
        }

        let (tx, rx) = mpsc::sync_channel::<Result<(), (isize, String)>>(1);
        let reply = RcBlock::new(move |success: Bool, error: *mut NSError| {
            let outcome = if success.as_bool() {
                Ok(())
            } else {
                // SAFETY: LocalAuthentication passes either null or a valid
                // NSError that lives for the duration of the reply block.
                match unsafe { error.as_ref() } {
                    Some(error) => Err(describe(error)),
                    None => Err((0, "Unknown LocalAuthentication error".to_string())),
                }
            };
            // The receiver may have given up (timeout); nothing to do then.
            let _ = tx.try_send(outcome);
        });
        let localized_reason = NSString::from_str(reason);
        // SAFETY: the context is kept alive (strong reference) until the reply
        // arrives or we invalidate it; the reply block only captures a
        // `SyncSender`, which is `Send`, so it may run on any queue.
        unsafe { context.evaluatePolicy_localizedReason_reply(policy, &localized_reason, &reply) };

        let outcome = match rx.recv_timeout(PROMPT_TIMEOUT) {
            Ok(outcome) => outcome,
            Err(_) => {
                // SAFETY: invalidating a live context dismisses its prompt.
                unsafe { context.invalidate() };
                return Err(OsAuthError::Failed(
                    "The system authentication prompt timed out".to_string(),
                ));
            }
        };
        if let Err((code, description)) = outcome {
            return Err(map_error(code, description));
        }

        let enrollment_fingerprint = if purpose.is_biometric() {
            // SAFETY: property read on the context that just evaluated a
            // biometric policy successfully. Deprecated in macOS 15 in favour
            // of `domainState` (macOS 15+ only); still returned on every
            // supported release.
            #[allow(deprecated)]
            let state = unsafe { context.evaluatedPolicyDomainState() };
            match state {
                Some(data) => Some(Sha256::digest(data.to_vec()).into()),
                // A biometric evaluation that succeeded must have a domain
                // state; without it enrollment changes could not be detected,
                // so refuse rather than enroll/unlock unbound.
                None => {
                    return Err(OsAuthError::Other(
                        "macOS did not report the biometric enrollment state".to_string(),
                    ))
                }
            }
        } else {
            None
        };
        Ok(OsAuthSuccess {
            enrollment_fingerprint,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke-check the real framework binding: the preflight must return
    /// without prompting or crashing. Ignored by default because it talks to
    /// the real LocalAuthentication framework; run with `--ignored` on a Mac.
    #[test]
    #[ignore = "talks to the real macOS LocalAuthentication framework"]
    fn capability_preflight_does_not_prompt() {
        for purpose in [OsAuthPurpose::ReauthExport, OsAuthPurpose::BiometricUnlock] {
            let capability = MacVerifier.capability(purpose);
            assert!(!capability.method_label.is_empty());
            assert_eq!(capability.available, capability.reason.is_none());
        }
    }

    #[test]
    fn cancellation_codes_map_to_cancelled() {
        for code in [
            LAError::UserCancel,
            LAError::SystemCancel,
            LAError::AppCancel,
            LAError::UserFallback,
        ] {
            assert_eq!(map_error(code.0, "x".into()), OsAuthError::Cancelled);
        }
        assert!(matches!(
            map_error(LAError::AuthenticationFailed.0, "x".into()),
            OsAuthError::Failed(_)
        ));
        assert!(matches!(
            map_error(LAError::BiometryNotEnrolled.0, "x".into()),
            OsAuthError::Unavailable(_)
        ));
        assert!(matches!(
            map_error(-9999, "x".into()),
            OsAuthError::Other(_)
        ));
    }
}
