//! [`PolkitAuthority`] over the polkit D-Bus API (`zbus`, blocking).
//!
//! The subject of every check is termiHub's own system-bus connection
//! (`system-bus-name`), which polkit resolves to this process, its user and
//! its login session without the PID-reuse race of a `unix-process` subject.
//! The session's polkit agent (GNOME Shell, KDE's polkit agent, …) shows the
//! password dialog.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use zbus::blocking::connection::Builder;
use zbus::blocking::Connection;
use zbus::zvariant::Value;

use super::{classify_dbus_error, AuthorityError, AuthorizationResult, PolkitAuthority};

const DESTINATION: &str = "org.freedesktop.PolicyKit1";
const PATH: &str = "/org/freedesktop/PolicyKit1/Authority";
const INTERFACE: &str = "org.freedesktop.PolicyKit1.Authority";

/// `CheckAuthorizationFlags.AllowUserInteraction`.
const ALLOW_USER_INTERACTION: u32 = 1;

/// Upper bound on how long a prompt may stay open before it is cancelled
/// (same bound as the macOS verifier).
const PROMPT_TIMEOUT: Duration = Duration::from_secs(300);

/// Unique suffix for polkit cancellation ids within this process.
static NEXT_CHECK: AtomicU64 = AtomicU64::new(0);

/// One `EnumerateActions` entry: `(ssssssuuua{ss})`.
type ActionDescription = (
    String,
    String,
    String,
    String,
    String,
    String,
    u32,
    u32,
    u32,
    HashMap<String, String>,
);

/// polkit over the system bus. Connects per call so a restarted polkit or
/// bus never leaves a stale connection behind.
pub struct DbusAuthority;

fn connect() -> Result<Connection, AuthorityError> {
    Builder::system()
        .and_then(|builder| builder.method_timeout(PROMPT_TIMEOUT).build())
        .map_err(|e| {
            AuthorityError::ServiceUnavailable(format!("cannot reach the system bus ({e})"))
        })
}

fn map_zbus_error(error: zbus::Error) -> AuthorityError {
    match error {
        zbus::Error::MethodError(name, message, _) => {
            classify_dbus_error(name.as_str(), message.as_deref().unwrap_or(""))
        }
        zbus::Error::InputOutput(io) if io.kind() == std::io::ErrorKind::TimedOut => {
            AuthorityError::TimedOut
        }
        other => AuthorityError::Other(other.to_string()),
    }
}

impl PolkitAuthority for DbusAuthority {
    fn is_action_registered(&self, action_id: &str) -> Result<bool, AuthorityError> {
        let connection = connect()?;
        let reply = connection
            .call_method(
                Some(DESTINATION),
                PATH,
                Some(INTERFACE),
                "EnumerateActions",
                &"",
            )
            .map_err(map_zbus_error)?;
        let actions: Vec<ActionDescription> = reply
            .body()
            .deserialize()
            .map_err(|e| AuthorityError::Other(e.to_string()))?;
        Ok(actions.iter().any(|action| action.0 == action_id))
    }

    fn check_authorization(&self, action_id: &str) -> Result<AuthorizationResult, AuthorityError> {
        let connection = connect()?;
        let bus_name = connection
            .unique_name()
            .ok_or_else(|| AuthorityError::Other("no unique system-bus name".to_string()))?
            .to_string();
        let mut subject_details: HashMap<&str, Value<'_>> = HashMap::new();
        subject_details.insert("name", Value::from(bus_name.as_str()));
        let subject = ("system-bus-name", subject_details);
        let details: HashMap<&str, &str> = HashMap::new();
        let cancellation_id = format!(
            "termihub-{}-{}",
            std::process::id(),
            NEXT_CHECK.fetch_add(1, Ordering::Relaxed)
        );

        let reply = connection.call_method(
            Some(DESTINATION),
            PATH,
            Some(INTERFACE),
            "CheckAuthorization",
            &(
                subject,
                action_id,
                details,
                ALLOW_USER_INTERACTION,
                cancellation_id.as_str(),
            ),
        );
        let reply = match reply {
            Ok(reply) => reply,
            Err(error) => {
                let error = map_zbus_error(error);
                if error == AuthorityError::TimedOut {
                    // Dismiss the still-open dialog; best effort — the check
                    // has already failed closed.
                    let _ = connection.call_method(
                        Some(DESTINATION),
                        PATH,
                        Some(INTERFACE),
                        "CancelCheckAuthorization",
                        &cancellation_id.as_str(),
                    );
                }
                return Err(error);
            }
        };
        let (is_authorized, is_challenge, details): (bool, bool, HashMap<String, String>) = reply
            .body()
            .deserialize()
            .map_err(|e| AuthorityError::Other(e.to_string()))?;
        Ok(AuthorizationResult {
            is_authorized,
            is_challenge,
            details,
        })
    }
}
