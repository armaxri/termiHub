//! Scriptable [`HardwareKeyProtector`] for unit tests.

use std::collections::VecDeque;
use std::sync::Mutex;

use rand::rngs::OsRng;
use rand::RngCore;
use zeroize::Zeroizing;

use super::{HardwareKeyProtector, HwKeyError, WrappingKey, WRAPPING_KEY_LEN};

/// Which protector call happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HwCall {
    Create,
    Release,
    Delete,
}

/// An in-memory "OS-enforced" key store whose availability, prompting and
/// answers are scripted by the test.
///
/// `create` / `release` pop the next scripted error, if any; otherwise they
/// succeed (create stores a fresh random key, release returns it or
/// [`HwKeyError::Missing`]). Every prompted call is recorded.
pub struct MockHwKey {
    available: Mutex<Result<(), HwKeyError>>,
    create_prompts: bool,
    key: Mutex<Option<[u8; WRAPPING_KEY_LEN]>>,
    create_errors: Mutex<VecDeque<HwKeyError>>,
    release_errors: Mutex<VecDeque<HwKeyError>>,
    calls: Mutex<Vec<HwCall>>,
}

impl MockHwKey {
    /// An available protector; `create_prompts` mirrors Windows Hello (true)
    /// or the macOS keychain (false).
    pub fn available(create_prompts: bool) -> Self {
        Self {
            available: Mutex::new(Ok(())),
            create_prompts,
            key: Mutex::new(None),
            create_errors: Mutex::new(VecDeque::new()),
            release_errors: Mutex::new(VecDeque::new()),
            calls: Mutex::new(Vec::new()),
        }
    }

    /// An unavailable protector (e.g. an unsigned macOS build).
    pub fn unavailable() -> Self {
        let mock = Self::available(false);
        mock.set_available(false);
        mock
    }

    /// Flip availability (e.g. the build gained the entitlement).
    pub fn set_available(&self, available: bool) {
        *self.available.lock().unwrap() = if available {
            Ok(())
        } else {
            Err(HwKeyError::Unavailable("mock: missing entitlement".into()))
        };
    }

    /// Make the next `create` fail with `error`.
    pub fn fail_next_create(&self, error: HwKeyError) {
        self.create_errors.lock().unwrap().push_back(error);
    }

    /// Make the next `release` fail with `error`.
    pub fn fail_next_release(&self, error: HwKeyError) {
        self.release_errors.lock().unwrap().push_back(error);
    }

    /// Whether a key is held.
    pub fn has_key(&self) -> bool {
        self.key.lock().unwrap().is_some()
    }

    /// Drop the key (simulates the OS invalidating it on an enrollment change).
    pub fn forget_key(&self) {
        *self.key.lock().unwrap() = None;
    }

    /// Every create/release/delete call so far.
    pub fn calls(&self) -> Vec<HwCall> {
        self.calls.lock().unwrap().clone()
    }

    fn record(&self, call: HwCall) {
        self.calls.lock().unwrap().push(call);
    }
}

impl HardwareKeyProtector for MockHwKey {
    fn probe(&self) -> Result<(), HwKeyError> {
        self.available.lock().unwrap().clone()
    }

    fn create_prompts(&self) -> bool {
        self.create_prompts
    }

    fn create(&self, _reason: &str, _owner: Option<isize>) -> Result<WrappingKey, HwKeyError> {
        self.record(HwCall::Create);
        self.probe()?;
        if let Some(error) = self.create_errors.lock().unwrap().pop_front() {
            return Err(error);
        }
        let mut key = [0u8; WRAPPING_KEY_LEN];
        OsRng.fill_bytes(&mut key);
        *self.key.lock().unwrap() = Some(key);
        Ok(Zeroizing::new(key))
    }

    fn release(&self, _reason: &str, _owner: Option<isize>) -> Result<WrappingKey, HwKeyError> {
        self.record(HwCall::Release);
        self.probe()?;
        if let Some(error) = self.release_errors.lock().unwrap().pop_front() {
            return Err(error);
        }
        match *self.key.lock().unwrap() {
            Some(key) => Ok(Zeroizing::new(key)),
            None => Err(HwKeyError::Missing),
        }
    }

    fn delete(&self) -> Result<(), HwKeyError> {
        self.record(HwCall::Delete);
        *self.key.lock().unwrap() = None;
        Ok(())
    }
}
