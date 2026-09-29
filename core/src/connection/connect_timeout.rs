//! The unified **connect-timeout** connection setting (PARITY-006, #2901).
//!
//! Every connection type with a configurable connect timeout exposes it under
//! **one** settings key, [`CONNECT_TIMEOUT_KEY`] (`"connectTimeoutSecs"`) — SSH,
//! telnet and FTP alike.
//!
//! FTP historically stored the value under its own `timeoutSecs` key
//! ([`LEGACY_FTP_TIMEOUT_KEY`]). Unlike the reconnect/save-password renames,
//! `timeoutSecs` is a generic name another connection type (notably a plugin
//! type) may legitimately use for something else, so the rename is **scoped to
//! the FTP type** ([`FTP_TYPE_ID`]) and needs the connection's type id:
//! [`normalize_connection_settings`] is the type-aware entry point every
//! persisted-definition read path calls. Only the new key is ever written.

use serde_json::Value;

/// The unified settings key for the connect timeout, in seconds.
pub const CONNECT_TIMEOUT_KEY: &str = "connectTimeoutSecs";

/// FTP's historical connect-timeout key, accepted on read and rewritten to
/// [`CONNECT_TIMEOUT_KEY`].
pub const LEGACY_FTP_TIMEOUT_KEY: &str = "timeoutSecs";

/// The built-in FTP connection type id.
pub const FTP_TYPE_ID: &str = "ftp";

/// Rewrite FTP's legacy `timeoutSecs` entry in an FTP settings bag to the
/// unified `connectTimeoutSecs` key, in place.
///
/// - The user's legacy value is preserved verbatim under the new key.
/// - If the bag already carries `connectTimeoutSecs`, that value wins and the
///   legacy entry is simply dropped (the new key is authoritative).
/// - A bag without the legacy key, or a non-object value, is left untouched.
///
/// Returns `true` when the bag was changed.
pub fn normalize_ftp_connect_timeout(settings: &mut Value) -> bool {
    let _ = settings;
    false
}

/// Apply every **type-scoped** legacy-key rename to a connection's settings
/// bag, in place. Currently that is FTP's `timeoutSecs` → `connectTimeoutSecs`;
/// every other type id (including plugin types) is left untouched.
///
/// Returns `true` when the bag was changed.
pub fn normalize_connection_settings(type_id: &str, settings: &mut Value) -> bool {
    let _ = (type_id, settings);
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_value_is_preserved_under_new_key() {
        let mut v = json!({ "host": "h", "timeoutSecs": 45 });
        assert!(normalize_ftp_connect_timeout(&mut v));
        assert_eq!(v, json!({ "host": "h", "connectTimeoutSecs": 45 }));
    }

    #[test]
    fn new_key_wins_over_legacy_key() {
        let mut v = json!({ "connectTimeoutSecs": 12, "timeoutSecs": 45 });
        assert!(normalize_ftp_connect_timeout(&mut v));
        assert_eq!(v, json!({ "connectTimeoutSecs": 12 }));
    }

    #[test]
    fn bag_without_legacy_key_is_untouched() {
        let mut v = json!({ "host": "h", "connectTimeoutSecs": 12 });
        assert!(!normalize_ftp_connect_timeout(&mut v));
        assert_eq!(v, json!({ "host": "h", "connectTimeoutSecs": 12 }));

        let mut v = json!({ "host": "h" });
        assert!(!normalize_ftp_connect_timeout(&mut v));
        assert_eq!(v, json!({ "host": "h" }));
    }

    #[test]
    fn non_object_is_untouched() {
        let mut v = json!(null);
        assert!(!normalize_ftp_connect_timeout(&mut v));
        assert_eq!(v, json!(null));
    }

    #[test]
    fn non_numeric_legacy_value_is_carried_over_verbatim() {
        // Whatever the user had is moved, never dropped — the typed parse
        // (not this rename) decides whether it is valid.
        let mut v = json!({ "timeoutSecs": "60" });
        assert!(normalize_ftp_connect_timeout(&mut v));
        assert_eq!(v, json!({ "connectTimeoutSecs": "60" }));
    }

    #[test]
    fn connection_settings_rename_is_scoped_to_ftp() {
        let mut ftp = json!({ "timeoutSecs": 45 });
        assert!(normalize_connection_settings(FTP_TYPE_ID, &mut ftp));
        assert_eq!(ftp, json!({ "connectTimeoutSecs": 45 }));

        // A plugin (or any other) type's own `timeoutSecs` must never be touched.
        for type_id in ["plugin:acme:thing", "ssh", "telnet", "http", "sftp"] {
            let mut other = json!({ "timeoutSecs": 45 });
            assert!(!normalize_connection_settings(type_id, &mut other));
            assert_eq!(other, json!({ "timeoutSecs": 45 }), "{type_id}");
        }
    }
}
