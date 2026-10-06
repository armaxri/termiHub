//! Windows: wrapping key derived from a Windows Hello key credential (#3534).
//!
//! `KeyCredentialManager` holds a per-user Hello key (TPM-backed where a TPM
//! exists) whose private half never leaves the OS; every `RequestSignAsync`
//! shows the Hello prompt. The wrapping key is HKDF-SHA256 over the
//! signature of a fixed challenge, so it **only exists after Hello verified
//! the user** — nothing readable is stored.
//!
//! This needs deterministic signatures. Hello key credentials are RSA-2048
//! keys that sign with RSASSA-PKCS1-v1_5 / SHA-256, which is deterministic;
//! the WinRT docs do not promise the padding, so [`create`] signs **twice**
//! and refuses (as `Unavailable`, so biometric unlock falls back to the
//! app-enforced path) when the two signatures differ.
//!
//! Bringing the prompt to the front: unlike `UserConsentVerifier` there is no
//! HWND interop for `KeyCredentialManager`, so a Win32 app's Hello dialog can
//! open behind its window. While a request is pending, [`HelloFocus`] polls
//! for the system's `Credential Dialog Xaml Host` window and raises it with
//! `SetForegroundWindow` — allowed because termiHub is the foreground process
//! when the user clicked unlock (the same workaround other Win32 password
//! managers use).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use windows::core::{Array, HSTRING};
use windows::Security::Credentials::{
    KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
};
use windows::Security::Cryptography::CryptographicBuffer;
use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow};
use zeroize::Zeroizing;

use super::{
    derive_wrapping_key, derive_wrapping_key_checked, HardwareKeyProtector, HwKeyError,
    WrappingKey, HW_KEY_NAME,
};

/// The fixed challenge signed to derive the wrapping key.
const CHALLENGE: &[u8] = b"termihub-biometric-unlock/hello-challenge/v1";
/// Window class of the system Windows Hello dialog.
const HELLO_DIALOG_CLASS: &str = "Credential Dialog Xaml Host";
/// How long to look for the Hello dialog to raise it.
const FOCUS_POLL_ATTEMPTS: u32 = 50;
const FOCUS_POLL_INTERVAL: Duration = Duration::from_millis(100);
/// `NTE_NOT_FOUND` — deleting a key credential that does not exist.
const NTE_NOT_FOUND: i32 = 0x8009_0011_u32 as i32;

/// The Windows Hello key-credential protector.
pub struct HelloKeyCredential;

fn os_error(e: windows::core::Error) -> HwKeyError {
    HwKeyError::Other(e.message().to_string())
}

fn map_status(status: KeyCredentialStatus) -> Result<(), HwKeyError> {
    if status == KeyCredentialStatus::Success {
        Ok(())
    } else if status == KeyCredentialStatus::NotFound {
        Err(HwKeyError::Missing)
    } else if status == KeyCredentialStatus::UserCanceled
        || status == KeyCredentialStatus::UserPrefersPassword
    {
        Err(HwKeyError::Cancelled)
    } else if status == KeyCredentialStatus::SecurityDeviceLocked {
        Err(HwKeyError::Failed(
            "The security device is locked after too many attempts.".into(),
        ))
    } else {
        Err(HwKeyError::Other(format!(
            "Windows Hello returned status {}",
            status.0
        )))
    }
}

fn is_supported() -> Result<bool, HwKeyError> {
    KeyCredentialManager::IsSupportedAsync()
        .and_then(|operation| operation.get())
        .map_err(os_error)
}

fn ensure_supported() -> Result<(), HwKeyError> {
    if is_supported()? {
        Ok(())
    } else {
        Err(HwKeyError::Unavailable(
            "Windows Hello key credentials are not set up for this user".into(),
        ))
    }
}

fn sign(credential: &KeyCredential) -> Result<Zeroizing<Vec<u8>>, HwKeyError> {
    let challenge = CryptographicBuffer::CreateFromByteArray(CHALLENGE).map_err(os_error)?;
    let result = {
        let _focus = HelloFocus::start();
        credential
            .RequestSignAsync(&challenge)
            .and_then(|operation| operation.get())
            .map_err(os_error)?
    };
    map_status(result.Status().map_err(os_error)?)?;
    let signature = result.Result().map_err(os_error)?;
    let mut bytes = Array::<u8>::new();
    CryptographicBuffer::CopyToByteArray(&signature, &mut bytes).map_err(os_error)?;
    Ok(Zeroizing::new(bytes.to_vec()))
}

fn name() -> HSTRING {
    HSTRING::from(HW_KEY_NAME)
}

impl HardwareKeyProtector for HelloKeyCredential {
    fn probe(&self) -> Result<(), HwKeyError> {
        ensure_supported()
    }

    fn create_prompts(&self) -> bool {
        true
    }

    fn create(&self, _reason: &str, _owner: Option<isize>) -> Result<WrappingKey, HwKeyError> {
        ensure_supported()?;
        let result = {
            let _focus = HelloFocus::start();
            KeyCredentialManager::RequestCreateAsync(
                &name(),
                KeyCredentialCreationOption::ReplaceExisting,
            )
            .and_then(|operation| operation.get())
            .map_err(os_error)?
        };
        map_status(result.Status().map_err(os_error)?)?;
        let credential = result.Credential().map_err(os_error)?;
        let derived = sign(&credential)
            .and_then(|first| sign(&credential).map(|second| (first, second)))
            .and_then(|(first, second)| derive_wrapping_key_checked(&first, &second));
        if derived.is_err() {
            // Never leave an unusable key credential behind.
            let _ = self.delete();
        }
        derived
    }

    fn release(&self, _reason: &str, _owner: Option<isize>) -> Result<WrappingKey, HwKeyError> {
        ensure_supported()?;
        let result = KeyCredentialManager::OpenAsync(&name())
            .and_then(|operation| operation.get())
            .map_err(os_error)?;
        map_status(result.Status().map_err(os_error)?)?;
        let credential = result.Credential().map_err(os_error)?;
        derive_wrapping_key(&sign(&credential)?)
    }

    fn delete(&self) -> Result<(), HwKeyError> {
        if !is_supported().unwrap_or(false) {
            return Ok(());
        }
        match KeyCredentialManager::DeleteAsync(&name()).and_then(|action| action.get()) {
            Ok(()) => Ok(()),
            Err(e) if e.code().0 == NTE_NOT_FOUND => Ok(()),
            Err(e) => Err(os_error(e)),
        }
    }
}

/// Raises the Windows Hello dialog in front of termiHub while a request is
/// pending. Stops polling when dropped.
struct HelloFocus {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl HelloFocus {
    fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let worker = std::thread::Builder::new()
            .name("hello-focus".into())
            .spawn(move || raise_hello_dialog(&flag))
            .ok();
        Self { stop, worker }
    }
}

impl Drop for HelloFocus {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn raise_hello_dialog(stop: &AtomicBool) {
    let class: Vec<u16> = HELLO_DIALOG_CLASS
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    for _ in 0..FOCUS_POLL_ATTEMPTS {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        // SAFETY: `class` is a NUL-terminated UTF-16 string that outlives the
        // call; a null window name matches any title.
        let hwnd = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
        if !hwnd.is_null() {
            // SAFETY: `hwnd` was just returned by FindWindowW; raising a
            // window that has since closed is a harmless failure.
            unsafe { SetForegroundWindow(hwnd) };
            return;
        }
        std::thread::sleep(FOCUS_POLL_INTERVAL);
    }
}
