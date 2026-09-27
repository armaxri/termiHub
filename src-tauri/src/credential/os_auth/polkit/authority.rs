//! The polkit transport contract: the `CheckAuthorization` answer, the
//! transport error taxonomy, the [`PolkitAuthority`] trait and D-Bus error
//! classification.
//!
//! Deliberately free of any other termiHub dependency so the real D-Bus
//! implementation (`dbus.rs`) can be compiled on its own by the headless
//! polkit integration probe (`tests/docker/polkit`, #3553), which includes this
//! file and `dbus.rs` by path.

use std::collections::HashMap;

/// The answer of `org.freedesktop.PolicyKit1.Authority.CheckAuthorization`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthorizationResult {
    /// `true` only when polkit authorized the subject.
    pub is_authorized: bool,
    /// `true` when authorization needs a challenge that did not happen
    /// (with `AllowUserInteraction` set, this means no agent was available).
    pub is_challenge: bool,
    /// Extra details, e.g. `polkit.dismissed`.
    pub details: HashMap<String, String>,
}

/// Why talking to polkit failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorityError {
    /// The action is not registered (the policy file is not installed).
    ActionNotRegistered,
    /// polkit or the system bus is not reachable.
    ServiceUnavailable(String),
    /// The prompt stayed open longer than the timeout and was cancelled.
    TimedOut,
    /// Any other polkit / D-Bus error.
    Other(String),
}

/// The polkit calls the verifier needs. Implemented over D-Bus on Linux and
/// by a scripted fake in unit tests.
pub trait PolkitAuthority: Send + Sync {
    /// Whether `action_id` is registered with polkit. Never prompts.
    fn is_action_registered(&self, action_id: &str) -> Result<bool, AuthorityError>;

    /// Check `action_id` for this process, letting the polkit agent prompt.
    /// Blocks until the user answers (bounded by an implementation timeout).
    fn check_authorization(&self, action_id: &str) -> Result<AuthorizationResult, AuthorityError>;
}

/// Classify a D-Bus error returned by a polkit call.
///
/// polkit reports an unknown action as `org.freedesktop.PolicyKit1.Error.Failed`
/// with a message like "Action … is not registered"; a missing polkit daemon
/// surfaces as `ServiceUnknown` / `NameHasNoOwner` from the bus.
pub fn classify_dbus_error(name: &str, message: &str) -> AuthorityError {
    if message.contains("is not registered") {
        AuthorityError::ActionNotRegistered
    } else if matches!(
        name,
        "org.freedesktop.DBus.Error.ServiceUnknown"
            | "org.freedesktop.DBus.Error.NameHasNoOwner"
            | "org.freedesktop.DBus.Error.NoServer"
            | "org.freedesktop.DBus.Error.Spawn.ServiceNotFound"
    ) {
        AuthorityError::ServiceUnavailable(format!("polkit is not available ({message})"))
    } else if name == "org.freedesktop.PolicyKit1.Error.Cancelled" {
        AuthorityError::TimedOut
    } else if message.is_empty() {
        AuthorityError::Other(name.to_string())
    } else {
        AuthorityError::Other(format!("{name}: {message}"))
    }
}
