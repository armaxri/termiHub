//! Scriptable [`OsUserVerifier`] for unit tests.

use std::collections::VecDeque;
use std::sync::Mutex;

use super::{OsAuthCapability, OsAuthError, OsAuthPurpose, OsAuthSuccess, OsUserVerifier};

/// What the mock does on the next `verify` call.
#[derive(Debug, Clone)]
pub enum MockOutcome {
    /// Succeed, reporting this enrollment fingerprint for biometric purposes.
    Success(Option<[u8; 32]>),
    /// Fail with this error.
    Error(OsAuthError),
}

/// A verifier whose availability and answers are scripted by the test.
///
/// `verify` pops the next scripted outcome; with none left it **fails**
/// (never succeeds by default), mirroring the fail-closed contract.
pub struct MockVerifier {
    available: bool,
    outcomes: Mutex<VecDeque<MockOutcome>>,
    calls: Mutex<Vec<(OsAuthPurpose, String)>>,
}

impl MockVerifier {
    /// An available verifier with the given scripted outcomes.
    pub fn new(outcomes: impl IntoIterator<Item = MockOutcome>) -> Self {
        Self {
            available: true,
            outcomes: Mutex::new(outcomes.into_iter().collect()),
            calls: Mutex::new(Vec::new()),
        }
    }

    /// An available verifier that succeeds `n` times with `fingerprint`.
    pub fn succeeding(n: usize, fingerprint: Option<[u8; 32]>) -> Self {
        Self::new(std::iter::repeat_n(MockOutcome::Success(fingerprint), n))
    }

    /// A verifier that reports itself unavailable and always refuses.
    pub fn unavailable() -> Self {
        Self {
            available: false,
            outcomes: Mutex::new(VecDeque::new()),
            calls: Mutex::new(Vec::new()),
        }
    }

    /// Queue another outcome.
    pub fn push(&self, outcome: MockOutcome) {
        self.outcomes.lock().unwrap().push_back(outcome);
    }

    /// Every `verify` call made so far, as `(purpose, reason)`.
    pub fn calls(&self) -> Vec<(OsAuthPurpose, String)> {
        self.calls.lock().unwrap().clone()
    }
}

impl OsUserVerifier for MockVerifier {
    fn capability(&self, _purpose: OsAuthPurpose) -> OsAuthCapability {
        if self.available {
            OsAuthCapability::available("Mock ID")
        } else {
            OsAuthCapability::unavailable("Mock ID", "mock verifier is unavailable")
        }
    }

    fn verify(
        &self,
        purpose: OsAuthPurpose,
        reason: &str,
        _owner_window: Option<isize>,
    ) -> Result<OsAuthSuccess, OsAuthError> {
        self.calls
            .lock()
            .unwrap()
            .push((purpose, reason.to_string()));
        if !self.available {
            return Err(OsAuthError::Unavailable(
                "mock verifier is unavailable".to_string(),
            ));
        }
        match self.outcomes.lock().unwrap().pop_front() {
            Some(MockOutcome::Success(fingerprint)) => Ok(OsAuthSuccess {
                enrollment_fingerprint: if purpose.is_biometric() {
                    fingerprint
                } else {
                    None
                },
            }),
            Some(MockOutcome::Error(e)) => Err(e),
            None => Err(OsAuthError::Failed("no scripted outcome".to_string())),
        }
    }
}
