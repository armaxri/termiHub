//! Optional telnet auto-login: send the configured username and password when
//! the server's login and password prompts appear.
//!
//! Telnet has no authentication protocol of its own — a server just prints a
//! prompt and reads a line. [`AutoLogin`] is a small, pure state machine fed
//! with the (already IAC-filtered) server output; it returns the bytes to send
//! and gives up — leaving the session fully interactive — as soon as anything
//! unexpected happens:
//!
//! ```text
//! AwaitLogin ──login prompt──▶ send username ──▶ AwaitPassword ──password prompt──▶ send password ──▶ Done
//!     │                                              │
//!     ├─password prompt (password-only device)──▶ send password ──▶ Done
//!     └─timeout / no username ──▶ Done              └─timeout / login prompt again (rejected) ──▶ Done
//! ```
//!
//! The password is sent **in cleartext** — telnet has no encryption. It is
//! never logged: [`AutoLoginConfig`]'s `Debug` redacts it, and the state
//! machine drops the whole config (and with it the password) once it is done.

use std::fmt;
use std::time::{Duration, Instant};

use super::negotiation::escape_iac;

/// Default login-prompt patterns (case-insensitive, `|`-separated).
pub const DEFAULT_LOGIN_PROMPT: &str = "login:|username:|user name:";
/// Default password-prompt pattern (case-insensitive, `|`-separated).
pub const DEFAULT_PASSWORD_PROMPT: &str = "password:";
/// Default time to wait for each prompt before giving up (seconds).
pub const DEFAULT_AUTO_LOGIN_TIMEOUT_SECS: u64 = 10;

/// How much recent output is kept for prompt matching. Prompts are matched
/// against the end of the output, so only a short tail is needed.
const TAIL_LIMIT: usize = 256;

/// Line terminator sent after the username and password: telnet's canonical
/// end-of-line is `CR LF` (RFC 854).
const EOL: &[u8] = b"\r\n";

/// Configuration for [`AutoLogin`].
#[derive(Clone)]
pub struct AutoLoginConfig {
    /// Username sent at the login prompt. Empty = stop at the login prompt.
    pub username: String,
    /// Password sent at the password prompt. `None` = stop there.
    pub password: Option<String>,
    /// Lower-cased, trimmed login-prompt patterns.
    login_prompts: Vec<String>,
    /// Lower-cased, trimmed password-prompt patterns.
    password_prompts: Vec<String>,
    /// How long to wait for each expected prompt.
    pub timeout: Duration,
}

impl AutoLoginConfig {
    /// Build a config. `login_prompt` / `password_prompt` are `|`-separated,
    /// case-insensitive patterns; blank values fall back to the defaults.
    pub fn new(
        username: String,
        password: Option<String>,
        login_prompt: &str,
        password_prompt: &str,
        timeout: Duration,
    ) -> Self {
        Self {
            username,
            password: password.filter(|p| !p.is_empty()),
            login_prompts: parse_prompts(login_prompt, DEFAULT_LOGIN_PROMPT),
            password_prompts: parse_prompts(password_prompt, DEFAULT_PASSWORD_PROMPT),
            timeout,
        }
    }
}

impl fmt::Debug for AutoLoginConfig {
    /// Redacts the password — this struct must be safe to log.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AutoLoginConfig")
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("login_prompts", &self.login_prompts)
            .field("password_prompts", &self.password_prompts)
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// Split a `|`-separated prompt list into lower-cased, trimmed, non-empty
/// patterns, falling back to `default` when none remain.
fn parse_prompts(raw: &str, default: &str) -> Vec<String> {
    let split = |s: &str| -> Vec<String> {
        s.split('|')
            .map(|p| p.trim().to_lowercase())
            .filter(|p| !p.is_empty())
            .collect()
    };
    let parsed = split(raw);
    if parsed.is_empty() {
        split(default)
    } else {
        parsed
    }
}

/// Why auto-login stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Username and/or password were sent.
    Completed,
    /// An expected prompt did not appear in time.
    TimedOut,
    /// A prompt appeared that auto-login cannot answer (no username/password
    /// configured, or the login prompt reappeared after sending credentials —
    /// i.e. the login was rejected; retrying could lock the account).
    Abandoned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    AwaitLogin,
    AwaitPassword,
    Done(Outcome),
}

/// Prompt-driven auto-login state machine. See the module docs.
#[derive(Debug)]
pub struct AutoLogin {
    /// Dropped (with the password) as soon as the machine is done.
    config: Option<AutoLoginConfig>,
    stage: Stage,
    deadline: Instant,
    /// Lower-cased tail of recent output used for prompt matching.
    tail: String,
}

impl AutoLogin {
    /// Start waiting for the login prompt at `now`.
    pub fn new(config: AutoLoginConfig, now: Instant) -> Self {
        let deadline = now + config.timeout;
        Self {
            config: Some(config),
            stage: Stage::AwaitLogin,
            deadline,
            tail: String::new(),
        }
    }

    /// `Some(outcome)` once auto-login has stopped.
    pub fn outcome(&self) -> Option<Outcome> {
        match self.stage {
            Stage::Done(outcome) => Some(outcome),
            _ => None,
        }
    }

    /// Whether auto-login has stopped.
    pub fn is_done(&self) -> bool {
        self.outcome().is_some()
    }

    /// Check the prompt timeout. Returns `true` if auto-login just gave up.
    pub fn on_tick(&mut self, now: Instant) -> bool {
        if !self.is_done() && now >= self.deadline {
            self.finish(Outcome::TimedOut);
            return true;
        }
        false
    }

    /// Feed server output. Returns the bytes to send (username or password
    /// line, IAC-escaped), if a prompt was just matched.
    pub fn on_output(&mut self, data: &[u8], now: Instant) -> Option<Vec<u8>> {
        if self.on_tick(now) || self.is_done() {
            return None;
        }
        self.push_tail(data);
        let config = self.config.as_ref()?;
        let at_login = ends_with_any(&self.tail, &config.login_prompts);
        let at_password = ends_with_any(&self.tail, &config.password_prompts);

        match (self.stage, at_login, at_password) {
            (Stage::AwaitLogin, _, true) | (Stage::AwaitPassword, _, true) => {
                let line = config.password.as_deref().map(line_bytes);
                match line {
                    Some(bytes) => {
                        self.finish(Outcome::Completed);
                        Some(bytes)
                    }
                    None => {
                        self.finish(Outcome::Abandoned);
                        None
                    }
                }
            }
            (Stage::AwaitLogin, true, false) => {
                if config.username.is_empty() {
                    self.finish(Outcome::Abandoned);
                    return None;
                }
                let bytes = line_bytes(&config.username);
                if config.password.is_none() {
                    // Nothing more to send — the user types the password.
                    self.finish(Outcome::Completed);
                } else {
                    self.stage = Stage::AwaitPassword;
                    self.deadline = now + config.timeout;
                    self.tail.clear();
                }
                Some(bytes)
            }
            // Login prompt again after we sent the username: rejected.
            (Stage::AwaitPassword, true, false) => {
                self.finish(Outcome::Abandoned);
                None
            }
            _ => None,
        }
    }

    fn finish(&mut self, outcome: Outcome) {
        self.stage = Stage::Done(outcome);
        // Drop the credentials as soon as they are no longer needed.
        self.config = None;
        self.tail.clear();
    }

    fn push_tail(&mut self, data: &[u8]) {
        self.tail
            .push_str(&String::from_utf8_lossy(data).to_lowercase());
        if self.tail.len() > TAIL_LIMIT {
            let mut cut = self.tail.len() - TAIL_LIMIT;
            while !self.tail.is_char_boundary(cut) {
                cut += 1;
            }
            self.tail.drain(..cut);
        }
    }
}

/// Whether the output (ignoring trailing whitespace) ends with any pattern.
fn ends_with_any(tail: &str, patterns: &[String]) -> bool {
    let trimmed = tail.trim_end();
    patterns.iter().any(|p| trimmed.ends_with(p.as_str()))
}

/// `value` + `CR LF`, IAC-escaped for the telnet stream.
fn line_bytes(value: &str) -> Vec<u8> {
    let mut bytes = escape_iac(value.as_bytes());
    bytes.extend_from_slice(EOL);
    bytes
}

#[cfg(test)]
#[path = "auto_login_tests.rs"]
mod tests;
