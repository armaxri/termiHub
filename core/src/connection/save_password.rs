//! The unified **save password** connection setting (#3818).
//!
//! Every connection type that can keep its password in the desktop credential
//! store exposes the choice under **one** settings key, [`SAVE_PASSWORD_KEY`]
//! (`"savePassword"`) — SSH, Telnet, agents and the remote-desktop (VNC/RDP)
//! types alike. The desktop only ever routes a password into the credential
//! store when this key is `true`.
//!
//! The remote-desktop schema used to offer a separate `saveToStore` key
//! ([`LEGACY_SAVE_TO_STORE_KEY`]) that no code read, so a direct VNC/RDP
//! password was never saved. The legacy key is **accepted on read** wherever a
//! connection's settings bag is deserialized (see
//! [`settings_bag`](super::auto_reconnect::settings_bag)) and rewritten by
//! [`normalize_save_password`]; only the unified key is ever written.

use serde_json::Value;

/// The unified settings key for "keep this password in the credential store".
pub const SAVE_PASSWORD_KEY: &str = "savePassword";

/// The legacy remote-desktop key, accepted on read and rewritten to
/// [`SAVE_PASSWORD_KEY`].
pub const LEGACY_SAVE_TO_STORE_KEY: &str = "saveToStore";

/// Rewrite a legacy `saveToStore` entry in a connection settings bag to the
/// unified `savePassword` key, in place.
///
/// Either flag set to `true` means the user asked for the password to be kept,
/// so the result is `savePassword: true` when **either** key was `true`;
/// otherwise the unified key keeps its own value, or takes the legacy value
/// when it had none. A bag without the legacy key, or a non-object value, is
/// left untouched.
///
/// Returns `true` when the bag was changed.
pub fn normalize_save_password(settings: &mut Value) -> bool {
    let _ = settings;
    false
}

/// Whether a connection settings bag opts into keeping its password in the
/// credential store (either key, for a bag not normalized yet).
pub fn save_password_enabled(settings: &Value) -> bool {
    let _ = settings;
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_true_becomes_save_password() {
        let mut v = json!({ "host": "h", "saveToStore": true });
        assert!(normalize_save_password(&mut v));
        assert_eq!(v, json!({ "host": "h", "savePassword": true }));
    }

    #[test]
    fn legacy_false_becomes_save_password_false() {
        let mut v = json!({ "saveToStore": false });
        assert!(normalize_save_password(&mut v));
        assert_eq!(v, json!({ "savePassword": false }));
    }

    #[test]
    fn either_flag_true_wins() {
        let mut v = json!({ "savePassword": false, "saveToStore": true });
        assert!(normalize_save_password(&mut v));
        assert_eq!(v, json!({ "savePassword": true }));

        let mut v = json!({ "savePassword": true, "saveToStore": false });
        assert!(normalize_save_password(&mut v));
        assert_eq!(v, json!({ "savePassword": true }));
    }

    #[test]
    fn bag_without_legacy_key_is_untouched() {
        let mut v = json!({ "host": "h", "savePassword": true });
        assert!(!normalize_save_password(&mut v));
        assert_eq!(v, json!({ "host": "h", "savePassword": true }));

        let mut v = json!(null);
        assert!(!normalize_save_password(&mut v));
        assert_eq!(v, json!(null));
    }

    #[test]
    fn enabled_reads_either_key() {
        assert!(save_password_enabled(&json!({ "savePassword": true })));
        assert!(save_password_enabled(&json!({ "saveToStore": true })));
        assert!(!save_password_enabled(&json!({ "savePassword": false })));
        assert!(!save_password_enabled(&json!({})));
        assert!(!save_password_enabled(&json!({ "savePassword": "yes" })));
    }
}
