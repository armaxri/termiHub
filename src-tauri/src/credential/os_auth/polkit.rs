//! Linux verifier: polkit re-authentication (#3535).
//!
//! Linux has no per-user "confirm it is you" API like LocalAuthentication or
//! Windows Hello, but polkit can ask the session's authentication agent (the
//! GNOME Shell / KDE / … password dialog) to authenticate the user for a
//! registered action. termiHub ships one action, [`ACTION_ID`], whose only
//! default is `allow_active = auth_self`:
//!
//! - `auth_self` asks for the **user's own** password (not an administrator's);
//! - it is not `auth_self_keep`, so polkit retains nothing and **every** export
//!   prompts again;
//! - inactive and remote sessions are refused outright (`no`).
//!
//! The action file (`packaging/linux/com.termihub.app.policy`) is installed to
//! `/usr/share/polkit-1/actions/` by the `.deb` and `.rpm` packages. AppImage
//! and portable builds cannot install it, so there the verifier reports
//! "unavailable" and export stays blocked — fail closed.
//!
//! The check itself goes through the polkit D-Bus API (`CheckAuthorization`
//! with `AllowUserInteraction`), with termiHub's own system-bus connection as
//! the subject (the race-free subject polkit recommends). The transport lives
//! behind [`PolkitAuthority`] so the result mapping is unit-tested without a
//! system bus; the real implementation is [`dbus::DbusAuthority`].

use std::collections::HashMap;

use super::{OsAuthCapability, OsAuthError, OsAuthPurpose, OsAuthSuccess, OsUserVerifier};

#[cfg(target_os = "linux")]
#[cfg_attr(test, allow(dead_code))]
pub mod dbus;

/// The polkit action termiHub checks before a keychain export. Must match the
/// `<action id>` in `packaging/linux/com.termihub.app.policy`.
pub const ACTION_ID: &str = "com.termihub.app.reauthenticate";

/// User-facing name of the mechanism.
const METHOD_LABEL: &str = "your account password";

/// Why the verifier is unavailable when the action file is not installed.
pub const NOT_INSTALLED_REASON: &str =
    "termiHub's polkit action is not installed. Install termiHub from the .deb or .rpm package \
     (AppImage and portable builds cannot register it), or use Master Password storage to \
     export credentials.";

/// Why the verifier is unavailable when no polkit agent answered.
pub const NO_AGENT_REASON: &str =
    "No polkit authentication agent is running in this session, so termiHub cannot ask for your \
     password. Log in to a desktop session with a polkit agent (GNOME, KDE, …), or use Master \
     Password storage to export credentials.";

/// Why biometric purposes are unavailable on Linux.
pub const NO_BIOMETRIC_REASON: &str =
    "Biometric unlock is not supported on Linux; polkit verifies your password, not a biometric.";

/// The `polkit.dismissed` detail polkit sets when the user closed the dialog.
const DISMISSED_DETAIL: &str = "polkit.dismissed";

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

/// Map a `CheckAuthorization` result to the fail-closed taxonomy. Only an
/// explicit `is_authorized` is a success.
pub fn map_result(result: &AuthorizationResult) -> Result<OsAuthSuccess, OsAuthError> {
    if result.is_authorized {
        Ok(OsAuthSuccess {
            enrollment_fingerprint: None,
        })
    } else if result.details.contains_key(DISMISSED_DETAIL) {
        Err(OsAuthError::Cancelled)
    } else if result.is_challenge {
        Err(OsAuthError::Unavailable(NO_AGENT_REASON.to_string()))
    } else {
        Err(OsAuthError::Failed(
            "polkit did not authorize the export.".to_string(),
        ))
    }
}

fn map_authority_error(error: AuthorityError) -> OsAuthError {
    match error {
        AuthorityError::ActionNotRegistered => {
            OsAuthError::Unavailable(NOT_INSTALLED_REASON.to_string())
        }
        AuthorityError::ServiceUnavailable(reason) => OsAuthError::Unavailable(reason),
        AuthorityError::TimedOut => OsAuthError::Failed(
            "The polkit password prompt timed out and was cancelled.".to_string(),
        ),
        AuthorityError::Other(reason) => OsAuthError::Other(reason),
    }
}

/// Verifier backed by polkit.
pub struct PolkitVerifier<A: PolkitAuthority> {
    authority: A,
}

impl<A: PolkitAuthority> PolkitVerifier<A> {
    /// A verifier that talks to polkit through `authority`.
    pub fn new(authority: A) -> Self {
        Self { authority }
    }
}

impl<A: PolkitAuthority> OsUserVerifier for PolkitVerifier<A> {
    fn capability(&self, purpose: OsAuthPurpose) -> OsAuthCapability {
        if purpose.is_biometric() {
            return OsAuthCapability::unavailable(METHOD_LABEL, NO_BIOMETRIC_REASON);
        }
        match self.authority.is_action_registered(ACTION_ID) {
            Ok(true) => OsAuthCapability::available(METHOD_LABEL),
            Ok(false) => OsAuthCapability::unavailable(METHOD_LABEL, NOT_INSTALLED_REASON),
            Err(error) => {
                OsAuthCapability::unavailable(METHOD_LABEL, map_authority_error(error).to_string())
            }
        }
    }

    fn verify(
        &self,
        purpose: OsAuthPurpose,
        _reason: &str,
        _owner_window: Option<isize>,
    ) -> Result<OsAuthSuccess, OsAuthError> {
        // The prompt text comes from the installed policy file; polkit only
        // honours a caller-supplied message from privileged callers.
        if purpose.is_biometric() {
            return Err(OsAuthError::Unavailable(NO_BIOMETRIC_REASON.to_string()));
        }
        let result = self
            .authority
            .check_authorization(ACTION_ID)
            .map_err(map_authority_error)?;
        map_result(&result)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// Scripted polkit authority.
    struct FakeAuthority {
        registered: Result<bool, AuthorityError>,
        check: Result<AuthorizationResult, AuthorityError>,
        checks: Mutex<Vec<String>>,
    }

    impl FakeAuthority {
        fn new(
            registered: Result<bool, AuthorityError>,
            check: Result<AuthorizationResult, AuthorityError>,
        ) -> Self {
            Self {
                registered,
                check,
                checks: Mutex::new(Vec::new()),
            }
        }
    }

    impl PolkitAuthority for FakeAuthority {
        fn is_action_registered(&self, _action_id: &str) -> Result<bool, AuthorityError> {
            self.registered.clone()
        }

        fn check_authorization(
            &self,
            action_id: &str,
        ) -> Result<AuthorizationResult, AuthorityError> {
            self.checks.lock().unwrap().push(action_id.to_string());
            self.check.clone()
        }
    }

    fn result(authorized: bool, challenge: bool, details: &[(&str, &str)]) -> AuthorizationResult {
        AuthorizationResult {
            is_authorized: authorized,
            is_challenge: challenge,
            details: details
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    fn verifier(
        registered: Result<bool, AuthorityError>,
        check: Result<AuthorizationResult, AuthorityError>,
    ) -> PolkitVerifier<FakeAuthority> {
        PolkitVerifier::new(FakeAuthority::new(registered, check))
    }

    #[test]
    fn authorized_is_the_only_success() {
        let v = verifier(Ok(true), Ok(result(true, false, &[])));
        assert_eq!(
            v.verify(OsAuthPurpose::ReauthExport, "export", None),
            Ok(OsAuthSuccess {
                enrollment_fingerprint: None
            })
        );
        assert_eq!(
            v.authority.checks.lock().unwrap().as_slice(),
            [ACTION_ID.to_string()]
        );
    }

    #[test]
    fn dismissed_dialog_is_cancelled() {
        let v = verifier(
            Ok(true),
            Ok(result(false, false, &[("polkit.dismissed", "true")])),
        );
        assert_eq!(
            v.verify(OsAuthPurpose::ReauthExport, "export", None),
            Err(OsAuthError::Cancelled)
        );
    }

    #[test]
    fn challenge_without_agent_is_unavailable() {
        let v = verifier(Ok(true), Ok(result(false, true, &[])));
        assert_eq!(
            v.verify(OsAuthPurpose::ReauthExport, "export", None),
            Err(OsAuthError::Unavailable(NO_AGENT_REASON.to_string()))
        );
    }

    #[test]
    fn plain_denial_fails() {
        let v = verifier(Ok(true), Ok(result(false, false, &[])));
        assert!(matches!(
            v.verify(OsAuthPurpose::ReauthExport, "export", None),
            Err(OsAuthError::Failed(_))
        ));
    }

    #[test]
    fn authorized_wins_over_other_details() {
        // polkit never sets both, but an explicit authorization is the only
        // success signal and must be honoured regardless of extra details.
        assert!(map_result(&result(true, false, &[("polkit.dismissed", "true")])).is_ok());
    }

    #[test]
    fn unregistered_action_is_unavailable() {
        let v = verifier(Ok(false), Err(AuthorityError::ActionNotRegistered));
        let cap = v.capability(OsAuthPurpose::ReauthExport);
        assert!(!cap.available);
        assert_eq!(cap.reason.as_deref(), Some(NOT_INSTALLED_REASON));
        assert_eq!(
            v.verify(OsAuthPurpose::ReauthExport, "export", None),
            Err(OsAuthError::Unavailable(NOT_INSTALLED_REASON.to_string()))
        );
    }

    #[test]
    fn registered_action_is_available() {
        let v = verifier(Ok(true), Ok(result(true, false, &[])));
        let cap = v.capability(OsAuthPurpose::ReauthExport);
        assert!(cap.available);
        assert_eq!(cap.method_label, METHOD_LABEL);
        assert_eq!(cap.reason, None);
    }

    #[test]
    fn polkit_unreachable_is_unavailable() {
        let err = AuthorityError::ServiceUnavailable("polkit is not available (x)".to_string());
        let v = verifier(Err(err.clone()), Err(err));
        let cap = v.capability(OsAuthPurpose::ReauthExport);
        assert!(!cap.available);
        assert_eq!(
            cap.reason.as_deref(),
            Some("System authentication is not available: polkit is not available (x)")
        );
        assert!(matches!(
            v.verify(OsAuthPurpose::ReauthExport, "export", None),
            Err(OsAuthError::Unavailable(_))
        ));
    }

    #[test]
    fn timeout_and_other_errors_refuse() {
        let v = verifier(Ok(true), Err(AuthorityError::TimedOut));
        assert!(matches!(
            v.verify(OsAuthPurpose::ReauthExport, "export", None),
            Err(OsAuthError::Failed(_))
        ));
        let v = verifier(Ok(true), Err(AuthorityError::Other("boom".to_string())));
        assert_eq!(
            v.verify(OsAuthPurpose::ReauthExport, "export", None),
            Err(OsAuthError::Other("boom".to_string()))
        );
    }

    #[test]
    fn biometric_purposes_never_reach_polkit() {
        let v = verifier(Ok(true), Ok(result(true, false, &[])));
        for purpose in [
            OsAuthPurpose::EnableBiometricUnlock,
            OsAuthPurpose::BiometricUnlock,
        ] {
            assert!(!v.capability(purpose).available);
            assert_eq!(
                v.verify(purpose, "unlock", None),
                Err(OsAuthError::Unavailable(NO_BIOMETRIC_REASON.to_string()))
            );
        }
        assert!(v.authority.checks.lock().unwrap().is_empty());
    }

    #[test]
    fn classifies_dbus_errors() {
        assert_eq!(
            classify_dbus_error(
                "org.freedesktop.PolicyKit1.Error.Failed",
                "Action com.termihub.app.reauthenticate is not registered"
            ),
            AuthorityError::ActionNotRegistered
        );
        assert!(matches!(
            classify_dbus_error("org.freedesktop.DBus.Error.ServiceUnknown", "no polkit"),
            AuthorityError::ServiceUnavailable(_)
        ));
        assert!(matches!(
            classify_dbus_error("org.freedesktop.DBus.Error.NameHasNoOwner", ""),
            AuthorityError::ServiceUnavailable(_)
        ));
        assert_eq!(
            classify_dbus_error("org.freedesktop.PolicyKit1.Error.Cancelled", "cancelled"),
            AuthorityError::TimedOut
        );
        assert_eq!(
            classify_dbus_error("org.freedesktop.PolicyKit1.Error.Failed", "weird"),
            AuthorityError::Other("org.freedesktop.PolicyKit1.Error.Failed: weird".to_string())
        );
    }

    /// The shipped policy file must declare exactly [`ACTION_ID`] and must make
    /// polkit prompt for the user's own password on **every** check.
    #[test]
    fn shipped_policy_file_reprompts_every_time() {
        let policy = include_str!("../../../packaging/linux/com.termihub.app.policy");
        assert!(policy.contains(&format!("<action id=\"{ACTION_ID}\">")));
        assert_eq!(policy.matches("<action id=").count(), 1);
        assert!(policy.contains("<allow_active>auth_self</allow_active>"));
        assert!(policy.contains("<allow_inactive>no</allow_inactive>"));
        assert!(policy.contains("<allow_any>no</allow_any>"));
        assert!(
            !policy.contains("_keep<"),
            "authorization must never be retained"
        );
        assert!(!policy.contains(">auth_admin"));
        assert!(!policy.contains(">yes<"));
    }

    /// The .deb and .rpm bundles must install the policy file where polkit
    /// looks for actions.
    #[test]
    fn linux_packages_install_the_policy_file() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../../tauri.conf.json")).unwrap();
        for package in ["deb", "rpm"] {
            let source = &config["bundle"]["linux"][package]["files"]
                ["/usr/share/polkit-1/actions/com.termihub.app.policy"];
            assert_eq!(
                source.as_str(),
                Some("packaging/linux/com.termihub.app.policy"),
                "{package} bundle must install the polkit action"
            );
        }
    }
}
