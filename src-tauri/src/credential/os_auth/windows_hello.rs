//! Windows verifier: Windows Hello `UserConsentVerifier`.
//!
//! Windows Hello verifies the user with face, fingerprint or the Hello PIN.
//! For a desktop (Win32) app the prompt must be parented to the app window via
//! `IUserConsentVerifierInterop::RequestVerificationForWindowAsync`, otherwise
//! it can open behind termiHub; the plain `RequestVerificationAsync` is only a
//! fallback when no window handle is known.
//!
//! Windows does not expose a biometric-enrollment fingerprint, so
//! [`OsAuthSuccess::enrollment_fingerprint`] is always `None` here: biometric
//! unlock on Windows is invalidated by a master-password change, a store
//! switch or opting out, but not by enrolling another finger (any Hello
//! credential of the signed-in user — including the PIN — is accepted).
//!
//! `IAsyncOperation::get` blocks the calling (non-UI) thread until the user
//! answers; the Hello dialog has its own system timeout.

use windows::core::{factory, HSTRING};
use windows::Foundation::IAsyncOperation;
use windows::Security::Credentials::UI::{
    UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::IUserConsentVerifierInterop;

use super::{OsAuthCapability, OsAuthError, OsAuthPurpose, OsAuthSuccess, OsUserVerifier};

const METHOD_LABEL: &str = "Windows Hello";

/// Verifier backed by Windows Hello.
pub struct WindowsHelloVerifier;

fn availability_reason(availability: UserConsentVerifierAvailability) -> Option<&'static str> {
    if availability == UserConsentVerifierAvailability::Available {
        None
    } else if availability == UserConsentVerifierAvailability::DeviceNotPresent {
        Some("No Windows Hello device is available.")
    } else if availability == UserConsentVerifierAvailability::NotConfiguredForUser {
        Some("Windows Hello is not set up for this user. Set it up in Windows Settings.")
    } else if availability == UserConsentVerifierAvailability::DisabledByPolicy {
        Some("Windows Hello is disabled by policy.")
    } else if availability == UserConsentVerifierAvailability::DeviceBusy {
        Some("The Windows Hello device is busy. Try again.")
    } else {
        Some("Windows Hello is not available.")
    }
}

fn check_availability() -> Result<(), OsAuthError> {
    let availability = UserConsentVerifier::CheckAvailabilityAsync()
        .and_then(|operation| operation.get())
        .map_err(|e| OsAuthError::Unavailable(e.message().to_string()))?;
    match availability_reason(availability) {
        None => Ok(()),
        Some(reason) => Err(OsAuthError::Unavailable(reason.to_string())),
    }
}

fn request(
    message: &HSTRING,
    owner_window: Option<isize>,
) -> windows::core::Result<IAsyncOperation<UserConsentVerificationResult>> {
    match owner_window {
        Some(hwnd) if hwnd != 0 => {
            let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
            // SAFETY: `hwnd` is the live top-level window handle of termiHub
            // (obtained from Tauri on the calling side); the interop call only
            // uses it to parent the system dialog.
            unsafe { interop.RequestVerificationForWindowAsync(HWND(hwnd as *mut _), message) }
        }
        _ => UserConsentVerifier::RequestVerificationAsync(message),
    }
}

impl OsUserVerifier for WindowsHelloVerifier {
    fn capability(&self, _purpose: OsAuthPurpose) -> OsAuthCapability {
        match check_availability() {
            Ok(()) => OsAuthCapability::available(METHOD_LABEL),
            Err(OsAuthError::Unavailable(reason)) => {
                OsAuthCapability::unavailable(METHOD_LABEL, reason)
            }
            Err(other) => OsAuthCapability::unavailable(METHOD_LABEL, other.to_string()),
        }
    }

    fn verify(
        &self,
        _purpose: OsAuthPurpose,
        reason: &str,
        owner_window: Option<isize>,
    ) -> Result<OsAuthSuccess, OsAuthError> {
        check_availability()?;
        let message = HSTRING::from(format!("termiHub is trying to {reason}."));
        let result = request(&message, owner_window)
            .and_then(|operation| operation.get())
            .map_err(|e| OsAuthError::Other(e.message().to_string()))?;
        if result == UserConsentVerificationResult::Verified {
            Ok(OsAuthSuccess {
                enrollment_fingerprint: None,
            })
        } else if result == UserConsentVerificationResult::Canceled {
            Err(OsAuthError::Cancelled)
        } else if result == UserConsentVerificationResult::RetriesExhausted {
            Err(OsAuthError::Failed(
                "Too many failed Windows Hello attempts.".to_string(),
            ))
        } else if result == UserConsentVerificationResult::DeviceBusy {
            Err(OsAuthError::Failed(
                "The Windows Hello device is busy. Try again.".to_string(),
            ))
        } else if result == UserConsentVerificationResult::DeviceNotPresent
            || result == UserConsentVerificationResult::NotConfiguredForUser
            || result == UserConsentVerificationResult::DisabledByPolicy
        {
            Err(OsAuthError::Unavailable(
                "Windows Hello is not available.".to_string(),
            ))
        } else {
            Err(OsAuthError::Other(
                "Windows Hello returned an unexpected result.".to_string(),
            ))
        }
    }
}
