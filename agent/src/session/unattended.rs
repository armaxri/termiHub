//! Unattended agent-hosted connects (#3877): a `connection.create` with
//! `unattended: true` — a desktop's scheduled run connecting a saved target
//! with nobody at the keyboard — must **never prompt** the desktop.
//!
//! The connect runs inside core's
//! [`run_unattended`](termihub_core::backends::ssh::unattended::run_unattended)
//! scope, wherever the session lives:
//!
//! - an **in-process** session connects in this worker process;
//! - a **daemon-backed** session connects in its session daemon, which the
//!   worker tells about the mode through [`UNATTENDED_ENV`].
//!
//! Inside the scope core never relays a keyboard-interactive / one-time-code
//! round, never accepts a host key that is not already trusted, and never
//! sends an empty password or loads an encrypted key without its passphrase.
//! Each of those fails fast with its typed `ConnectFailureKind`
//! (`interaction_required`, `host_key_untrusted`), relayed to the desktop in
//! the `connection.create` error `data` like every other typed connect
//! failure; a rejected credential stays `auth_failed`.

use termihub_core::backends::ssh::unattended::{is_unattended, run_unattended};
use termihub_core::connection::ConnectionType;
use termihub_core::errors::SessionError;

/// Env var telling a session daemon to connect unattended (`"1"`).
///
/// Non-secret. With an attended launch the variable is explicitly removed, so
/// a value inherited from the worker's own environment can never turn an
/// attended connect into an unattended one (or the other way round).
pub const UNATTENDED_ENV: &str = "TERMIHUB_UNATTENDED";

/// Connect `connection` with `settings`, unattended when `unattended`.
///
/// The single place both the in-process path and the session daemon connect
/// through, so the two can never disagree about the mode.
pub async fn connect(
    connection: &mut dyn ConnectionType,
    settings: serde_json::Value,
    unattended: bool,
) -> Result<(), SessionError> {
    if unattended {
        run_unattended(async {
            debug_assert!(is_unattended());
            connection.connect(settings).await
        })
        .await
    } else {
        connection.connect(settings).await
    }
}

/// Export the unattended mode to a session daemon launch, or clear it.
pub fn export(command: &mut std::process::Command, unattended: bool) {
    if unattended {
        command.env(UNATTENDED_ENV, "1");
    } else {
        command.env_remove(UNATTENDED_ENV);
    }
}

/// Whether this session daemon was launched for an unattended connect.
///
/// Only the exact value `"1"` counts, so an unexpected value connects attended
/// — the pre-#3877 behavior — rather than guessing.
pub fn from_env() -> bool {
    parse(std::env::var(UNATTENDED_ENV).ok().as_deref())
}

fn parse(raw: Option<&str>) -> bool {
    raw == Some("1")
}

#[cfg(test)]
#[path = "unattended_tests.rs"]
mod tests;
