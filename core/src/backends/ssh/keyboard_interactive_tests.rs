//! Tests for the keyboard-interactive exchange (#3371), driven against the
//! in-process russh server in [`ki_test_server`](super::super::ki_test_server).

use super::*;
use crate::backends::ssh::ki_test_server::{
    connect, PasswordPolicy, Round, Script, ScriptedPrompter,
};

fn ctx(password: Option<&str>) -> KiContext<'_> {
    KiContext {
        host: "bastion.test",
        port: 2222,
        username: "alice",
        password,
    }
}

fn script(rounds: Vec<Round>) -> Script {
    Script {
        rounds,
        password: PasswordPolicy::Disabled,
    }
}

fn prompt(text: &str, echo: bool) -> KbdInteractivePrompt {
    KbdInteractivePrompt {
        prompt: text.to_string(),
        echo,
    }
}

// ── Auto-answer heuristic ──────────────────────────────────────────

#[test]
fn heuristic_answers_a_single_masked_password_prompt_in_round_one() {
    assert!(is_auto_answerable_password_round(
        1,
        &[prompt("Password: ", false)]
    ));
    assert!(is_auto_answerable_password_round(
        1,
        &[prompt("alice@host's password:", false)]
    ));
    assert!(is_auto_answerable_password_round(
        1,
        &[prompt("Enter passphrase for key:", false)]
    ));
}

#[test]
fn heuristic_never_answers_otp_or_echoed_or_later_prompts() {
    // One-time codes / tokens / verification prompts.
    for text in [
        "Verification code: ",
        "OTP password: ",
        "One-time password: ",
        "Token password:",
        "PIN + password:",
    ] {
        assert!(
            !is_auto_answerable_password_round(1, &[prompt(text, false)]),
            "must not auto-answer {text:?}"
        );
    }
    // Password-change prompts.
    assert!(!is_auto_answerable_password_round(
        1,
        &[prompt("New password: ", false)]
    ));
    assert!(!is_auto_answerable_password_round(
        1,
        &[prompt("Retype password: ", false)]
    ));
    // Echo on → not a secret prompt.
    assert!(!is_auto_answerable_password_round(
        1,
        &[prompt("Password: ", true)]
    ));
    // Not round one.
    assert!(!is_auto_answerable_password_round(
        2,
        &[prompt("Password: ", false)]
    ));
    // More than one prompt.
    assert!(!is_auto_answerable_password_round(
        1,
        &[prompt("Password: ", false), prompt("Password: ", false)]
    ));
    // Not a password prompt at all.
    assert!(!is_auto_answerable_password_round(
        1,
        &[prompt("Username: ", false)]
    ));
}

// ── Exchanges against the in-process server ───────────────────────

/// A single OTP round is routed to the prompter with name, instructions and
/// echo flags intact, and the answer authenticates.
#[tokio::test]
async fn single_otp_round_is_prompted_and_succeeds() {
    let mut round = Round::new(vec![("Verification code: ", false)], vec!["123456"]);
    round.name = "Duo";
    round.instructions = "Enter the code from your authenticator app.";
    let (mut session, observed) = connect(script(vec![round])).await;
    let prompter = ScriptedPrompter::new(vec![Some(vec!["123456"])]);

    run_keyboard_interactive(&mut session, &ctx(None), KiMode::Explicit, Some(&prompter))
        .await
        .expect("authenticated");

    let seen = prompter.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].name, "Duo");
    assert_eq!(
        seen[0].instructions,
        "Enter the code from your authenticator app."
    );
    assert_eq!(seen[0].prompts, vec![prompt("Verification code: ", false)]);
    assert_eq!(seen[0].round, 1);
    assert_eq!(seen[0].host, "bastion.test");
    assert_eq!(seen[0].port, 2222);
    assert_eq!(seen[0].username, "alice");
    assert_eq!(observed.lock().unwrap().responses, vec![vec!["123456"]]);
}

/// Multiple rounds, multiple prompts per round, mixed echo flags.
#[tokio::test]
async fn multi_round_multi_prompt_exchange_succeeds() {
    let rounds = vec![
        Round::new(
            vec![("Username hint: ", true), ("Password: ", false)],
            vec!["alice", "s3cret"],
        ),
        Round::new(vec![("Verification code: ", false)], vec!["654321"]),
    ];
    let (mut session, observed) = connect(script(rounds)).await;
    let prompter = ScriptedPrompter::new(vec![Some(vec!["alice", "s3cret"]), Some(vec!["654321"])]);

    run_keyboard_interactive(&mut session, &ctx(None), KiMode::Explicit, Some(&prompter))
        .await
        .expect("authenticated");

    let seen = prompter.seen();
    assert_eq!(seen.len(), 2);
    assert_eq!(
        seen[0].prompts,
        vec![prompt("Username hint: ", true), prompt("Password: ", false)]
    );
    assert_eq!(seen[1].round, 2);
    assert_eq!(observed.lock().unwrap().responses.len(), 2);
}

/// The configured password answers the first-round password prompt; the OTP
/// round that follows still goes to the user.
#[tokio::test]
async fn password_is_auto_answered_but_otp_is_prompted() {
    let rounds = vec![
        Round::new(vec![("Password: ", false)], vec!["hunter2"]),
        Round::new(vec![("Verification code: ", false)], vec!["000111"]),
    ];
    let (mut session, observed) = connect(script(rounds)).await;
    let prompter = ScriptedPrompter::new(vec![Some(vec!["000111"])]);

    run_keyboard_interactive(
        &mut session,
        &ctx(Some("hunter2")),
        KiMode::Explicit,
        Some(&prompter),
    )
    .await
    .expect("authenticated");

    let seen = prompter.seen();
    assert_eq!(seen.len(), 1, "only the OTP round is shown to the user");
    assert_eq!(seen[0].prompts, vec![prompt("Verification code: ", false)]);
    assert_eq!(
        observed.lock().unwrap().responses,
        vec![vec!["hunter2".to_string()], vec!["000111".to_string()]]
    );
}

/// A configured password is never used for an OTP prompt.
#[tokio::test]
async fn otp_prompt_is_never_auto_answered() {
    let rounds = vec![Round::new(
        vec![("Verification code: ", false)],
        vec!["999"],
    )];
    let (mut session, _observed) = connect(script(rounds)).await;
    let prompter = ScriptedPrompter::new(vec![Some(vec!["999"])]);

    run_keyboard_interactive(
        &mut session,
        &ctx(Some("hunter2")),
        KiMode::Explicit,
        Some(&prompter),
    )
    .await
    .expect("authenticated");
    assert_eq!(prompter.seen().len(), 1);
}

/// Dismissing the dialog is a typed cancel, not an auth failure.
#[tokio::test]
async fn cancel_is_a_typed_auth_cancelled() {
    let rounds = vec![Round::new(vec![("Verification code: ", false)], vec!["1"])];
    let (mut session, _observed) = connect(script(rounds)).await;
    let prompter = ScriptedPrompter::new(vec![None]);

    let err = run_keyboard_interactive(&mut session, &ctx(None), KiMode::Explicit, Some(&prompter))
        .await
        .expect_err("cancelled");
    assert!(matches!(err, SessionError::AuthCancelled), "got {err:?}");
}

/// A wrong answer is a genuine rejection → the typed `AuthFailed`.
#[tokio::test]
async fn wrong_answer_is_auth_failed() {
    let rounds = vec![Round::new(
        vec![("Verification code: ", false)],
        vec!["right"],
    )];
    let (mut session, _observed) = connect(script(rounds)).await;
    let prompter = ScriptedPrompter::new(vec![Some(vec!["wrong"])]);

    let err = run_keyboard_interactive(&mut session, &ctx(None), KiMode::Explicit, Some(&prompter))
        .await
        .expect_err("rejected");
    assert!(matches!(err, SessionError::AuthFailed), "got {err:?}");
}

// ── Which factor failed (#3376) ────────────────────────────────────

/// The configured password was auto-answered and accepted (the server moved on
/// to an OTP round); a wrong user-typed code is a second-factor failure, not a
/// credential rejection, so the saved password is not discarded.
#[tokio::test]
async fn wrong_otp_after_auto_answered_password_is_second_factor_failed() {
    let rounds = vec![
        Round::new(vec![("Password: ", false)], vec!["hunter2"]),
        Round::new(vec![("Verification code: ", false)], vec!["000111"]),
    ];
    let (mut session, observed) = connect(script(rounds)).await;
    let prompter = ScriptedPrompter::new(vec![Some(vec!["999999"])]);

    let err = run_keyboard_interactive(
        &mut session,
        &ctx(Some("hunter2")),
        KiMode::PasswordFallback,
        Some(&prompter),
    )
    .await
    .expect_err("rejected");
    assert!(
        matches!(err, SessionError::SecondFactorFailed),
        "got {err:?}"
    );
    assert_eq!(observed.lock().unwrap().responses.len(), 2);
}

/// The same holds for the explicit keyboard-interactive method.
#[tokio::test]
async fn wrong_otp_after_auto_answered_password_explicit_is_second_factor_failed() {
    let rounds = vec![
        Round::new(vec![("Password: ", false)], vec!["hunter2"]),
        Round::new(vec![("Verification code: ", false)], vec!["000111"]),
    ];
    let (mut session, _observed) = connect(script(rounds)).await;
    let prompter = ScriptedPrompter::new(vec![Some(vec!["999999"])]);

    let err = run_keyboard_interactive(
        &mut session,
        &ctx(Some("hunter2")),
        KiMode::Explicit,
        Some(&prompter),
    )
    .await
    .expect_err("rejected");
    assert!(
        matches!(err, SessionError::SecondFactorFailed),
        "got {err:?}"
    );
}

/// The auto-answered password itself is rejected: that IS a stored-credential
/// failure, so it stays the typed `AuthFailed` (discard allowed).
#[tokio::test]
async fn rejected_auto_answered_password_is_auth_failed() {
    let rounds = vec![
        Round::new(vec![("Password: ", false)], vec!["correct"]),
        Round::new(vec![("Verification code: ", false)], vec!["000111"]),
    ];
    let (mut session, observed) = connect(script(rounds)).await;
    let prompter = ScriptedPrompter::new(vec![]);

    let err = run_keyboard_interactive(
        &mut session,
        &ctx(Some("stale")),
        KiMode::PasswordFallback,
        Some(&prompter),
    )
    .await
    .expect_err("rejected");
    assert!(matches!(err, SessionError::AuthFailed), "got {err:?}");
    assert!(
        prompter.seen().is_empty(),
        "the OTP round was never reached"
    );
    assert_eq!(observed.lock().unwrap().responses.len(), 1);
}

/// After a primary method's partial success, a wrong typed answer is always a
/// second-factor failure — the primary credential was accepted.
#[tokio::test]
async fn wrong_answer_in_second_factor_mode_is_second_factor_failed() {
    let rounds = vec![Round::new(
        vec![("Verification code: ", false)],
        vec!["right"],
    )];
    let (mut session, _observed) = connect(script(rounds)).await;
    let prompter = ScriptedPrompter::new(vec![Some(vec!["wrong"])]);

    let err = run_keyboard_interactive(
        &mut session,
        &ctx(None),
        KiMode::SecondFactor,
        Some(&prompter),
    )
    .await
    .expect_err("rejected");
    assert!(
        matches!(err, SessionError::SecondFactorFailed),
        "got {err:?}"
    );
}

/// With no prompter (headless), an unanswerable prompt fails clearly — and in
/// password-fallback mode keeps the plain credential-rejection outcome.
#[tokio::test]
async fn no_prompter_fails_cleanly_per_mode() {
    let rounds = || vec![Round::new(vec![("Verification code: ", false)], vec!["1"])];

    let (mut session, _o) = connect(script(rounds())).await;
    let err = run_keyboard_interactive(&mut session, &ctx(None), KiMode::Explicit, None)
        .await
        .expect_err("no prompter");
    assert!(
        matches!(&err, SessionError::SpawnFailed(m) if m.contains("keyboard-interactive")),
        "got {err:?}"
    );

    let (mut session, _o) = connect(script(rounds())).await;
    let err = run_keyboard_interactive(&mut session, &ctx(None), KiMode::PasswordFallback, None)
        .await
        .expect_err("no prompter");
    assert!(matches!(err, SessionError::AuthFailed), "got {err:?}");
}

/// A prompter returning the wrong number of answers is refused before
/// anything is sent.
#[tokio::test]
async fn answer_count_mismatch_is_refused() {
    let rounds = vec![Round::new(
        vec![("Code A: ", false), ("Code B: ", false)],
        vec!["a", "b"],
    )];
    let (mut session, observed) = connect(script(rounds)).await;
    let prompter = ScriptedPrompter::new(vec![Some(vec!["a"])]);

    let err = run_keyboard_interactive(&mut session, &ctx(None), KiMode::Explicit, Some(&prompter))
        .await
        .expect_err("mismatch");
    assert!(matches!(err, SessionError::SpawnFailed(_)), "got {err:?}");
    assert!(observed.lock().unwrap().responses.is_empty());
}

/// An empty info-request round (OpenSSH sends one after PAM finishes) is
/// answered without bothering the user.
#[tokio::test]
async fn empty_round_is_answered_silently() {
    let rounds = vec![
        Round::new(vec![("Verification code: ", false)], vec!["42"]),
        Round::new(vec![], vec![]),
    ];
    let (mut session, observed) = connect(script(rounds)).await;
    let prompter = ScriptedPrompter::new(vec![Some(vec!["42"])]);

    run_keyboard_interactive(&mut session, &ctx(None), KiMode::Explicit, Some(&prompter))
        .await
        .expect("authenticated");
    assert_eq!(prompter.seen().len(), 1);
    assert_eq!(observed.lock().unwrap().responses.len(), 2);
}

/// The answer type never prints its secrets.
#[test]
fn answer_debug_is_redacted() {
    let a = KbdInteractiveAnswer::Responses(vec![Zeroizing::new("topsecret".to_string())]);
    let s = format!("{a:?}");
    assert!(!s.contains("topsecret"), "{s}");
}
