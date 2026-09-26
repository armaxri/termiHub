//! SSH `keyboard-interactive` authentication (RFC 4256) — OTP / 2FA / PAM
//! challenge prompts answered through an in-app dialog (#3371, PARITY-010).
//!
//! ## When it runs
//!
//! [`auth`](super::auth) drives keyboard-interactive in three situations:
//!
//! 1. **Explicitly** — the connection's `authMethod` is
//!    [`AUTH_METHOD_KEYBOARD_INTERACTIVE`].
//! 2. **As a second factor** — the primary method (key / agent / password)
//!    returned *partial success* and the server lists `keyboard-interactive` as
//!    a remaining method (sshd `AuthenticationMethods publickey,keyboard-interactive`).
//! 3. **As a password fallback** — `password` auth was refused and the server
//!    offers `keyboard-interactive` (typical for `PasswordAuthentication no`
//!    with PAM, or PAM stacks that add an OTP after the password).
//!
//! ## How prompts reach the user
//!
//! Exactly like host-key verification ([`host_key`](super::host_key)), the host
//! application registers one process-wide [`KeyboardInteractivePrompter`] at
//! startup via [`set_keyboard_interactive_prompter`]. The desktop's prompter
//! emits an event and awaits the dialog's answer; headless paths (the remote
//! agent, bare-`core` tests) register none, in which case only the auto-answer
//! heuristic below can respond and any other prompt fails the connect cleanly.
//!
//! ## Auto-answer heuristic (documented contract)
//!
//! A configured password is sent **without asking** only when *all* hold:
//!
//! - it is the **first** info-request round of this keyboard-interactive
//!   exchange,
//! - the round carries **exactly one** prompt,
//! - that prompt has **echo off**,
//! - its text looks like a password prompt (contains "password" or
//!   "passphrase", case-insensitive), and
//! - it does **not** look like a one-time-code / new-password prompt (no
//!   "code", "otp", "token", "verification", "one-time", "pin", "new",
//!   "retype", "again", "confirm").
//!
//! Every other prompt — in particular any OTP / verification-code prompt — is
//! always shown to the user. An empty round (zero prompts, which OpenSSH sends
//! after a PAM conversation finishes) is answered with an empty response list
//! without prompting.
//!
//! ## Which factor failed (#3376)
//!
//! A rejection is the typed [`SessionError::AuthFailed`] (the frontend may then
//! discard the saved credential) only when the saved credential may be what was
//! wrong. A user-typed answer rejected **after** an earlier factor was accepted
//! — the primary method's partial success, or an auto-answered password round
//! the server moved past — is [`SessionError::SecondFactorFailed`] instead, so a
//! mistyped one-time code never costs the user their saved password.
//!
//! ## Secrets
//!
//! Responses are never logged. The copies termiHub holds are wrapped in
//! [`Zeroizing`] and wiped once sent; the copy handed to russh for encryption is
//! owned by russh from that point on.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use russh::client::KeyboardInteractiveAuthResponse;
use russh::MethodKind;
use zeroize::Zeroizing;

use crate::errors::SessionError;

use super::prompt_clock::excluded_from_connect_timeout;

/// The `authMethod` value selecting keyboard-interactive as the primary method.
pub const AUTH_METHOD_KEYBOARD_INTERACTIVE: &str = "keyboard-interactive";

/// How long a single prompt may stay unanswered before the connect fails.
///
/// Prompt time is excluded from the connect timeout
/// ([`prompt_clock`](super::prompt_clock)), so this is the only bound on how
/// long the user may take to fetch a one-time code.
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(300);

/// Upper bound on info-request rounds in one exchange, so a misbehaving server
/// cannot keep the client prompting forever.
pub const MAX_ROUNDS: u32 = 16;

/// One prompt of an info-request round.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KbdInteractivePrompt {
    /// The prompt text as sent by the server (e.g. `"Verification code: "`).
    pub prompt: String,
    /// Whether the user's input may be shown while typing. `false` = mask it.
    pub echo: bool,
}

/// An info-request round the user must answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KbdInteractiveRequest {
    /// Host being authenticated to (for a jump-host hop: that hop).
    pub host: String,
    /// Port of that host.
    pub port: u16,
    /// Username being authenticated.
    pub username: String,
    /// Server-supplied challenge name (often empty).
    pub name: String,
    /// Server-supplied instruction text (often empty).
    pub instructions: String,
    /// The prompts to answer, in order.
    pub prompts: Vec<KbdInteractivePrompt>,
    /// 1-based round number within this exchange.
    pub round: u32,
}

/// The user's reply to a [`KbdInteractiveRequest`].
pub enum KbdInteractiveAnswer {
    /// One response per prompt, in order.
    Responses(Vec<Zeroizing<String>>),
    /// The user dismissed the dialog.
    Cancelled,
}

impl std::fmt::Debug for KbdInteractiveAnswer {
    /// Never print responses — they are secrets.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Responses(r) => write!(f, "Responses(<{} redacted>)", r.len()),
            Self::Cancelled => write!(f, "Cancelled"),
        }
    }
}

/// Asks the user to answer a keyboard-interactive round.
///
/// Called on the connecting task; implementations may block on a dialog. The
/// wait is excluded from the connect timeout and bounded by [`PROMPT_TIMEOUT`].
#[async_trait]
pub trait KeyboardInteractivePrompter: Send + Sync {
    /// Ask the user; return their responses or [`KbdInteractiveAnswer::Cancelled`].
    async fn prompt(&self, request: &KbdInteractiveRequest) -> KbdInteractiveAnswer;
}

static PROMPTER: OnceLock<Arc<dyn KeyboardInteractivePrompter>> = OnceLock::new();

/// Register the process-wide prompter. Returns `false` if one was already
/// registered (first registration wins).
pub fn set_keyboard_interactive_prompter(prompter: Arc<dyn KeyboardInteractivePrompter>) -> bool {
    PROMPTER.set(prompter).is_ok()
}

/// The registered prompter, or `None` on headless paths.
pub fn keyboard_interactive_prompter() -> Option<Arc<dyn KeyboardInteractivePrompter>> {
    PROMPTER.get().cloned()
}

/// Why keyboard-interactive is being attempted — decides how a situation with
/// no way to answer is reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KiMode {
    /// `authMethod` is keyboard-interactive.
    Explicit,
    /// The primary method partially succeeded; this is the second factor.
    SecondFactor,
    /// `password` was refused; the server offers keyboard-interactive instead.
    PasswordFallback,
}

/// Identity and optional password for one keyboard-interactive exchange.
pub(crate) struct KiContext<'a> {
    pub host: &'a str,
    pub port: u16,
    pub username: &'a str,
    /// Configured password, used only by the auto-answer heuristic.
    pub password: Option<&'a str>,
}

/// Whether a round may be answered automatically with the configured password.
/// See the module docs for the exact contract.
pub fn is_auto_answerable_password_round(round: u32, prompts: &[KbdInteractivePrompt]) -> bool {
    if round != 1 || prompts.len() != 1 {
        return false;
    }
    let p = &prompts[0];
    if p.echo {
        return false;
    }
    let text = p.prompt.to_lowercase();
    let looks_like_password = text.contains("password") || text.contains("passphrase");
    const NOT_A_PLAIN_PASSWORD: [&str; 10] = [
        "code",
        "otp",
        "token",
        "verification",
        "one-time",
        "pin",
        "new",
        "retype",
        "again",
        "confirm",
    ];
    looks_like_password && !NOT_A_PLAIN_PASSWORD.iter().any(|w| text.contains(w))
}

/// Whether the server lists keyboard-interactive among the remaining methods.
pub(crate) fn offers_keyboard_interactive(remaining: &russh::MethodSet) -> bool {
    remaining.contains(&MethodKind::KeyboardInteractive)
}

/// Who answered a keyboard-interactive round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Answerer {
    /// The configured (saved) password, via the auto-answer heuristic.
    SavedPassword,
    /// The user, through the prompter dialog.
    User,
}

/// Tracks which authentication factor a server rejection refers to (#3376).
///
/// A rejection must only surface as [`SessionError::AuthFailed`] — which lets
/// the frontend discard the saved credential — when the saved credential may be
/// what was wrong. Once an earlier factor has been **accepted** and the user then
/// types a later answer (typically a one-time code) that is rejected, the
/// failure is [`SessionError::SecondFactorFailed`] instead:
///
/// - In [`KiMode::SecondFactor`] the primary method (password / key / agent)
///   already returned partial success, so it counts as accepted from the start.
/// - An auto-answered saved-password round counts as accepted once the server
///   **moves on** to another info-request round instead of failing.
///
/// Limitation: a PAM stack that defers the password verdict until after the
/// OTP ("fail late") is indistinguishable from an accepted password; such a
/// rejection is reported as a second-factor failure, which errs on the side of
/// keeping the saved password rather than destroying it.
struct FactorTracker {
    /// An earlier factor is known to have been accepted.
    earlier_factor_accepted: bool,
    /// Who answered the most recent non-empty round, pending the server's verdict.
    pending: Option<Answerer>,
    /// The user typed an answer after an earlier factor was accepted.
    user_answered_after_acceptance: bool,
}

impl FactorTracker {
    fn new(mode: KiMode) -> Self {
        Self {
            earlier_factor_accepted: mode == KiMode::SecondFactor,
            pending: None,
            user_answered_after_acceptance: false,
        }
    }

    /// The server sent another info-request round: the previous answers were
    /// not rejected.
    fn server_moved_on(&mut self) {
        if self.pending.take() == Some(Answerer::SavedPassword) {
            self.earlier_factor_accepted = true;
        }
    }

    /// Record who is answering the current (non-empty) round.
    fn answered(&mut self, by: Answerer) {
        if by == Answerer::User && self.earlier_factor_accepted {
            self.user_answered_after_acceptance = true;
        }
        self.pending = Some(by);
    }

    /// The typed error for a server rejection at this point of the exchange.
    fn rejection(&self) -> SessionError {
        if self.earlier_factor_accepted && self.user_answered_after_acceptance {
            SessionError::SecondFactorFailed
        } else {
            SessionError::AuthFailed
        }
    }
}

fn protocol_error(e: russh::Error) -> SessionError {
    SessionError::SpawnFailed(format!("Keyboard-interactive auth failed: {e}"))
}

/// Run a full keyboard-interactive exchange on `session`.
///
/// Returns `Ok(())` on success, [`SessionError::AuthFailed`] when the server
/// rejects the answers, [`SessionError::SecondFactorFailed`] when it rejects a
/// user-typed answer after an earlier factor was accepted (see
/// [`FactorTracker`]), [`SessionError::AuthCancelled`] when the user cancels,
/// and a `SpawnFailed` for protocol errors, timeouts, or a prompt that cannot
/// be answered in this context (no prompter registered).
pub(crate) async fn run_keyboard_interactive<H>(
    session: &mut russh::client::Handle<H>,
    ctx: &KiContext<'_>,
    mode: KiMode,
    prompter: Option<&dyn KeyboardInteractivePrompter>,
) -> Result<(), SessionError>
where
    H: russh::client::Handler,
{
    let mut response = session
        .authenticate_keyboard_interactive_start(ctx.username, None)
        .await
        .map_err(protocol_error)?;
    let mut round: u32 = 0;
    let mut factors = FactorTracker::new(mode);

    loop {
        let (name, instructions, prompts) = match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(factors.rejection());
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => (name, instructions, prompts),
        };
        factors.server_moved_on();

        round += 1;
        if round > MAX_ROUNDS {
            return Err(SessionError::SpawnFailed(format!(
                "Keyboard-interactive auth exceeded {MAX_ROUNDS} prompt rounds"
            )));
        }

        let prompts: Vec<KbdInteractivePrompt> = prompts
            .into_iter()
            .map(|p| KbdInteractivePrompt {
                prompt: p.prompt,
                echo: p.echo,
            })
            .collect();

        let answers: Vec<Zeroizing<String>> = if prompts.is_empty() {
            Vec::new()
        } else if let Some(password) = ctx
            .password
            .filter(|_| is_auto_answerable_password_round(round, &prompts))
        {
            tracing::debug!(
                host = %ctx.host,
                round,
                "answering keyboard-interactive password prompt with the configured password"
            );
            factors.answered(Answerer::SavedPassword);
            vec![Zeroizing::new(password.to_string())]
        } else {
            let Some(prompter) = prompter else {
                return Err(match mode {
                    // Keep the pre-keyboard-interactive outcome of a refused
                    // password: a plain credential rejection.
                    KiMode::PasswordFallback => SessionError::AuthFailed,
                    KiMode::Explicit | KiMode::SecondFactor => SessionError::SpawnFailed(
                        "The server requires interactive authentication \
                         (keyboard-interactive), but no prompt is available here"
                            .to_string(),
                    ),
                });
            };
            let request = KbdInteractiveRequest {
                host: ctx.host.to_string(),
                port: ctx.port,
                username: ctx.username.to_string(),
                name,
                instructions,
                prompts,
                round,
            };
            let answer = excluded_from_connect_timeout(tokio::time::timeout(
                PROMPT_TIMEOUT,
                prompter.prompt(&request),
            ))
            .await
            .map_err(|_| {
                SessionError::SpawnFailed(format!(
                    "Keyboard-interactive prompt was not answered within {}s",
                    PROMPT_TIMEOUT.as_secs()
                ))
            })?;
            match answer {
                KbdInteractiveAnswer::Cancelled => return Err(SessionError::AuthCancelled),
                KbdInteractiveAnswer::Responses(r) if r.len() == request.prompts.len() => {
                    factors.answered(Answerer::User);
                    r
                }
                KbdInteractiveAnswer::Responses(r) => {
                    return Err(SessionError::SpawnFailed(format!(
                        "Keyboard-interactive answer count mismatch: {} prompts, {} responses",
                        request.prompts.len(),
                        r.len()
                    )));
                }
            }
        };

        // russh takes owned `String`s; our `answers` are wiped when dropped at
        // the end of this iteration.
        let wire: Vec<String> = answers.iter().map(|a| a.as_str().to_owned()).collect();
        response = session
            .authenticate_keyboard_interactive_respond(wire)
            .await
            .map_err(protocol_error)?;
    }
}

#[cfg(test)]
#[path = "keyboard_interactive_tests.rs"]
mod tests;
