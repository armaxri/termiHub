//! Unattended SSH connects (#3527): a connect that must **never prompt**.
//!
//! A scheduled run may connect a saved target on its own, with nobody at the
//! keyboard. Such a connect can use only what needs no answer: stored
//! credentials or key auth, and a host key that is already trusted. Whenever
//! the attended flow would ask the user — an unknown or changed host key, a
//! keyboard-interactive / one-time-code round — the unattended connect fails
//! fast with a typed [`ConnectFailureKind`]
//! instead:
//!
//! - an untrusted host key → [`HostKeyUntrusted`](crate::errors::ConnectFailureKind::HostKeyUntrusted);
//! - a keyboard-interactive round the saved password cannot answer →
//!   [`InteractionRequired`](crate::errors::ConnectFailureKind::InteractionRequired).
//!
//! - a password auth with no password, or an encrypted key with no
//!   passphrase → [`InteractionRequired`](crate::errors::ConnectFailureKind::InteractionRequired)
//!   too (#3877): the attended flow would have asked for the secret.
//!
//! The same scope runs agent-side for an agent-hosted connect whose
//! `connection.create` carries `unattended: true` (#3877): in the agent's own
//! process for an in-process session, or in the session daemon.
//!
//! The mode is a **task-local scope** set around the connect with
//! [`run_unattended`], so it reaches the auth code without threading a flag
//! through every connection type and call site — the same shape as the
//! keyboard-interactive prompt owner. The host-key check runs inside russh's
//! spawned session task, where a task-local is not visible, so the SSH handler
//! reads the mode when it is built (on the connecting task) and carries it.

use std::future::Future;

use crate::errors::{ConnectFailureKind, SessionError};

tokio::task_local! {
    /// Set while an unattended connect runs on this task.
    static UNATTENDED: ();
}

/// Run `fut` as an unattended connect: nothing it connects may prompt.
pub async fn run_unattended<F: Future>(fut: F) -> F::Output {
    UNATTENDED.scope((), fut).await
}

/// Whether the current task runs inside [`run_unattended`].
pub fn is_unattended() -> bool {
    UNATTENDED.try_with(|_| ()).is_ok()
}

/// The typed refusal of an unattended connect whose password auth has no
/// password to send (#3877): the attended flow would have asked for it.
pub(crate) fn password_required(host: &str) -> SessionError {
    SessionError::classified(
        ConnectFailureKind::InteractionRequired,
        format!("No password is stored for {host}, and an unattended connect cannot ask for one"),
    )
}

/// The typed refusal of an unattended connect whose private key is encrypted
/// and has no stored passphrase (#3877).
pub(crate) fn passphrase_required(key_path: &str) -> SessionError {
    SessionError::classified(
        ConnectFailureKind::InteractionRequired,
        format!(
            "The key {key_path} needs a passphrase, and an unattended connect cannot ask for one"
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scope_is_visible_inside_and_not_outside() {
        assert!(!is_unattended());
        assert!(run_unattended(async { is_unattended() }).await);
        assert!(!is_unattended());
    }

    #[tokio::test]
    async fn scope_does_not_leak_into_spawned_tasks() {
        let inner = run_unattended(async { tokio::spawn(async { is_unattended() }).await })
            .await
            .expect("join");
        assert!(!inner, "a spawned task must not inherit the scope");
    }
}
