//! Where the app-enforced biometric-unlock wrapping key is kept (#3433).
//!
//! The app-enforced path stores a random wrapping key in the OS credential
//! store (macOS login Keychain / Windows Credential Manager) and only reads
//! it after termiHub's own OS verification. The OS-enforced path (#3534) is
//! [`HardwareKeyProtector`](super::hw_key::HardwareKeyProtector) instead.

use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use zeroize::Zeroizing;

use super::keyring_thread::off_runtime;

// The keyring slot is only constructed by production builds (tests use
// `MemorySlot`), hence the test-only dead-code expectations below.
/// OS credential-store service name for the wrapping key. Distinct from the
/// `termiHub` service used by OS-keychain credential storage.
#[cfg_attr(
    test,
    expect(dead_code, reason = "tests use MemorySlot, never the OS keyring")
)]
const KEYRING_SERVICE: &str = "termiHub-biometric-unlock";
/// OS credential-store account name for the wrapping key.
#[cfg_attr(
    test,
    expect(dead_code, reason = "tests use MemorySlot, never the OS keyring")
)]
const KEYRING_ACCOUNT: &str = "master-password-store";
/// Where the wrapping key is kept. Abstracted so tests never touch the real
/// OS credential store.
pub trait SecretSlot: Send + Sync {
    /// Read the stored secret, `None` when there is none.
    fn read(&self) -> Result<Option<Zeroizing<String>>>;
    /// Store (or replace) the secret.
    fn write(&self, value: &str) -> Result<()>;
    /// Delete the secret. Deleting a missing secret is not an error.
    fn delete(&self) -> Result<()>;
}

impl<T: SecretSlot + ?Sized> SecretSlot for Arc<T> {
    fn read(&self) -> Result<Option<Zeroizing<String>>> {
        (**self).read()
    }

    fn write(&self, value: &str) -> Result<()> {
        (**self).write(value)
    }

    fn delete(&self) -> Result<()> {
        (**self).delete()
    }
}

/// [`SecretSlot`] in the native OS credential store via `keyring`.
#[derive(Default)]
#[cfg_attr(
    test,
    expect(dead_code, reason = "tests use MemorySlot, never the OS keyring")
)]
pub struct KeyringSlot {
    entry: Mutex<Option<Arc<keyring::Entry>>>,
}

impl KeyringSlot {
    #[cfg_attr(
        test,
        expect(dead_code, reason = "tests use MemorySlot, never the OS keyring")
    )]
    fn entry(&self) -> Result<Arc<keyring::Entry>> {
        let mut guard = self.entry.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = guard.as_ref() {
            return Ok(entry.clone());
        }
        let entry = Arc::new(
            keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
                .context("Failed to open the OS credential store entry for biometric unlock")?,
        );
        *guard = Some(entry.clone());
        Ok(entry)
    }
}

// Every keyring call runs through `off_runtime`: these are reached from async
// commands (change master password, store switch, reset), and on Linux a
// keyring call on a Tokio worker panics (see `keyring_thread`).
impl SecretSlot for KeyringSlot {
    fn read(&self) -> Result<Option<Zeroizing<String>>> {
        let entry = self.entry()?;
        match off_runtime(|| entry.get_password()) {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e).context("Failed to read the biometric unlock key"),
        }
    }

    fn write(&self, value: &str) -> Result<()> {
        let entry = self.entry()?;
        off_runtime(|| entry.set_password(value))
            .context("Failed to store the biometric unlock key")
    }

    fn delete(&self) -> Result<()> {
        let entry = self.entry()?;
        match off_runtime(|| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e).context("Failed to delete the biometric unlock key"),
        }
    }
}

/// In-memory [`SecretSlot`] for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemorySlot {
    value: Mutex<Option<String>>,
    /// When set, `write` fails (to exercise rollback).
    pub fail_writes: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl MemorySlot {
    /// Whether a secret is currently stored.
    pub fn has_value(&self) -> bool {
        self.value.lock().unwrap().is_some()
    }

    /// Replace the stored secret directly (simulates tampering / loss).
    pub fn overwrite(&self, value: Option<&str>) {
        *self.value.lock().unwrap() = value.map(str::to_string);
    }
}

#[cfg(test)]
impl SecretSlot for MemorySlot {
    fn read(&self) -> Result<Option<Zeroizing<String>>> {
        Ok(self.value.lock().unwrap().clone().map(Zeroizing::new))
    }

    fn write(&self, value: &str) -> Result<()> {
        if self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            anyhow::bail!("simulated write failure");
        }
        *self.value.lock().unwrap() = Some(value.to_string());
        Ok(())
    }

    fn delete(&self) -> Result<()> {
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}
