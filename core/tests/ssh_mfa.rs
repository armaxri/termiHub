#![cfg(feature = "ssh")]
//! SSH two-factor (partial success → keyboard-interactive) integration tests
//! (SSH-MFA-01 through SSH-MFA-05, #3384).
//!
//! Runs against the `ssh-mfa` Docker fixture (default port 2216), a real OpenSSH
//! with `AuthenticationMethods password,keyboard-interactive
//! publickey,keyboard-interactive` and a fixed one-time code (`424242`). A
//! correct password or key there is a genuine **partial success**
//! (`USERAUTH_FAILURE` with `partial_success = 1`), which the in-process russh
//! test server cannot produce (russh clears the flag). These tests are what prove
//! the client takes the `KiMode::SecondFactor` path end to end:
//!
//! - a mistyped code after an accepted password/key is the typed
//!   `SecondFactorFailed` (only `SecondFactor` mode reports that when the user
//!   answered the very first keyboard-interactive round — the password-fallback
//!   path would report `AuthFailed`), and
//! - a key-configured connection continues into keyboard-interactive at all
//!   (without partial success a refused key is a plain rejection).
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d ssh-mfa`
//! Skips gracefully if the container is not running (hard-fails under
//! `TERMIHUB_REQUIRE_DOCKER=1`).

mod common;

use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use common::{port_ssh_mfa, require_docker, ssh_exec, ssh_key_config, ssh_password_config};
use termihub_core::backends::ssh::auth::connect_and_authenticate;
use termihub_core::backends::ssh::keyboard_interactive::{
    set_keyboard_interactive_prompter, KbdInteractiveAnswer, KbdInteractiveRequest,
    KeyboardInteractivePrompter,
};
use termihub_core::config::SshConfig;
use termihub_core::errors::SessionError;
use zeroize::Zeroizing;

/// The fixture's fixed one-time code (see `tests/docker/ssh-mfa`).
const FIXTURE_OTP: &str = "424242";
/// The prompt text the fixture's PAM module asks.
const OTP_PROMPT: &str = "Verification code: ";

/// The process-wide prompter, answering every prompt with the armed answer and
/// recording each request it was shown.
#[derive(Default)]
struct FixturePrompter {
    answer: Mutex<Option<String>>,
    seen: Mutex<Vec<KbdInteractiveRequest>>,
}

impl FixturePrompter {
    fn arm(&self, answer: &str) {
        *self.answer.lock().unwrap() = Some(answer.to_string());
        self.seen.lock().unwrap().clear();
    }

    fn take_seen(&self) -> Vec<KbdInteractiveRequest> {
        std::mem::take(&mut *self.seen.lock().unwrap())
    }
}

#[async_trait]
impl KeyboardInteractivePrompter for FixturePrompter {
    async fn prompt(&self, request: &KbdInteractiveRequest) -> KbdInteractiveAnswer {
        self.seen.lock().unwrap().push(request.clone());
        match self.answer.lock().unwrap().clone() {
            Some(answer) => KbdInteractiveAnswer::Responses(
                request
                    .prompts
                    .iter()
                    .map(|_| Zeroizing::new(answer.clone()))
                    .collect(),
            ),
            None => KbdInteractiveAnswer::Cancelled,
        }
    }
}

/// The prompter is a process-wide `OnceLock`, so register one shared instance.
fn prompter() -> Arc<FixturePrompter> {
    static PROMPTER: OnceLock<Arc<FixturePrompter>> = OnceLock::new();
    PROMPTER
        .get_or_init(|| {
            let prompter = Arc::new(FixturePrompter::default());
            assert!(
                set_keyboard_interactive_prompter(prompter.clone()),
                "no other prompter may be registered in this test binary"
            );
            prompter
        })
        .clone()
}

/// The prompter's armed answer is shared, so the tests must not interleave.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Connect with `config`, answering every keyboard-interactive prompt with
/// `answer`. Returns the outcome (with a `whoami` on success) and the prompts
/// the user was shown.
async fn connect_answering(
    config: &SshConfig,
    answer: &str,
) -> (Result<String, SessionError>, Vec<KbdInteractiveRequest>) {
    let _serial = SERIAL.lock().await;
    let prompter = prompter();
    prompter.arm(answer);
    let outcome = match connect_and_authenticate(config).await {
        Ok((session, _)) => Ok(ssh_exec(&session, "whoami")
            .await
            .expect("whoami after two-factor login")),
        Err(e) => Err(e),
    };
    (outcome, prompter.take_seen())
}

/// Exactly one keyboard-interactive round was shown: the masked OTP prompt.
fn assert_only_otp_prompted(seen: &[KbdInteractiveRequest]) {
    assert_eq!(seen.len(), 1, "exactly one prompt round, got {seen:?}");
    assert_eq!(seen[0].round, 1);
    assert_eq!(seen[0].prompts.len(), 1, "got {:?}", seen[0].prompts);
    assert_eq!(seen[0].prompts[0].prompt, OTP_PROMPT);
    assert!(!seen[0].prompts[0].echo, "the OTP prompt must be masked");
}

// ── SSH-MFA-01: password (partial success) + correct OTP ─────────────

#[tokio::test]
async fn ssh_mfa_01_password_partial_success_then_otp() {
    require_docker!(port_ssh_mfa());

    let (outcome, seen) =
        connect_answering(&ssh_password_config(port_ssh_mfa()), FIXTURE_OTP).await;

    let whoami = outcome.expect("SSH-MFA-01: password + OTP should authenticate");
    assert!(whoami.contains("testuser"), "got {whoami:?}");
    // The saved password answered the password method; only the OTP is asked.
    assert_only_otp_prompted(&seen);
}

// ── SSH-MFA-02: password (partial success) + wrong OTP ───────────────

#[tokio::test]
async fn ssh_mfa_02_password_partial_success_wrong_otp_is_second_factor_failed() {
    require_docker!(port_ssh_mfa());

    let (outcome, seen) = connect_answering(&ssh_password_config(port_ssh_mfa()), "000000").await;

    // `SecondFactorFailed` (not `AuthFailed`) proves the client saw the partial
    // success and ran keyboard-interactive in `KiMode::SecondFactor`: the saved
    // password was accepted, so the frontend must not discard it.
    let err = outcome.expect_err("SSH-MFA-02: a wrong OTP must be rejected");
    assert!(
        matches!(err, SessionError::SecondFactorFailed),
        "expected SecondFactorFailed, got {err:?}"
    );
    assert_only_otp_prompted(&seen);
}

// ── SSH-MFA-03: public key (partial success) + correct OTP ───────────

#[tokio::test]
async fn ssh_mfa_03_key_partial_success_then_otp() {
    require_docker!(port_ssh_mfa());

    let (outcome, seen) =
        connect_answering(&ssh_key_config(port_ssh_mfa(), "ed25519"), FIXTURE_OTP).await;

    // A key-configured connection only continues into keyboard-interactive on a
    // partial success; otherwise a refused key is a plain `AuthFailed`.
    let whoami = outcome.expect("SSH-MFA-03: key + OTP should authenticate");
    assert!(whoami.contains("testuser"), "got {whoami:?}");
    assert_only_otp_prompted(&seen);
}

// ── SSH-MFA-04: public key (partial success) + wrong OTP ─────────────

#[tokio::test]
async fn ssh_mfa_04_key_partial_success_wrong_otp_is_second_factor_failed() {
    require_docker!(port_ssh_mfa());

    let (outcome, seen) =
        connect_answering(&ssh_key_config(port_ssh_mfa(), "ed25519"), "000000").await;

    let err = outcome.expect_err("SSH-MFA-04: a wrong OTP must be rejected");
    assert!(
        matches!(err, SessionError::SecondFactorFailed),
        "expected SecondFactorFailed, got {err:?}"
    );
    assert_only_otp_prompted(&seen);
}

// ── SSH-MFA-05: wrong password → no second factor ────────────────────

#[tokio::test]
async fn ssh_mfa_05_wrong_password_is_auth_failed_without_prompt() {
    require_docker!(port_ssh_mfa());

    let mut config = ssh_password_config(port_ssh_mfa());
    config.password = Some("wrongpass".to_string());
    let (outcome, seen) = connect_answering(&config, FIXTURE_OTP).await;

    // No partial success, and the server does not offer keyboard-interactive
    // before a first factor succeeded: the typed credential rejection, with no
    // OTP prompt ever shown.
    let err = outcome.expect_err("SSH-MFA-05: a wrong password must be rejected");
    assert!(
        matches!(err, SessionError::AuthFailed),
        "expected AuthFailed, got {err:?}"
    );
    assert!(seen.is_empty(), "no prompt expected, got {seen:?}");
}
