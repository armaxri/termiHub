//! The unified **auto-reconnect** connection setting (PARITY-008).
//!
//! Every connection type that supports automatically recovering a dropped
//! connection exposes it under **one** settings key, [`AUTO_RECONNECT_KEY`]
//! (`"autoReconnect"`), which **defaults to on** ([`AUTO_RECONNECT_DEFAULT`]).
//! An absent key therefore means "on".
//!
//! Historically SSH used a separate `resilientReconnect` key that defaulted to
//! *off*, while the graphical backends used `autoReconnect` defaulting to *on*.
//! The legacy key ([`LEGACY_RESILIENT_RECONNECT_KEY`]) is still **accepted on
//! read** everywhere a connection's settings bag is deserialized — the desktop
//! `connections.json` / external files / imports, the agent's persisted
//! connection definitions and the agent wire DTOs — so mixed desktop/agent
//! versions interoperate. Only the new key is ever written.
//!
//! Settings bags are opaque JSON (`serde_json::Value`), so a plain
//! `#[serde(alias)]` cannot express this; [`normalize_auto_reconnect`] is the
//! equivalent rename-on-read, and [`settings_bag`] / [`optional_settings_bag`]
//! package it as `#[serde(with = "...")]` modules for struct fields holding a bag.

use serde_json::Value;

/// The unified settings key for automatic reconnect.
pub const AUTO_RECONNECT_KEY: &str = "autoReconnect";

/// The legacy SSH-only key, accepted on read and rewritten to
/// [`AUTO_RECONNECT_KEY`].
pub const LEGACY_RESILIENT_RECONNECT_KEY: &str = "resilientReconnect";

/// Auto-reconnect is on unless the user explicitly turned it off.
pub const AUTO_RECONNECT_DEFAULT: bool = true;

/// Rewrite a legacy `resilientReconnect` entry in a connection settings bag to
/// the unified `autoReconnect` key, in place.
///
/// - The user's explicit legacy value (`true` *or* `false`) is preserved under
///   the new key.
/// - If the bag already carries `autoReconnect`, that value wins and the legacy
///   entry is simply dropped (the new key is authoritative).
/// - A bag with neither key is left untouched — absence means "on".
/// - A non-object value is left untouched.
///
/// Returns `true` when the bag was changed.
pub fn normalize_auto_reconnect(settings: &mut Value) -> bool {
    let Some(map) = settings.as_object_mut() else {
        return false;
    };
    let Some(legacy) = map.remove(LEGACY_RESILIENT_RECONNECT_KEY) else {
        return false;
    };
    if !map.contains_key(AUTO_RECONNECT_KEY) {
        map.insert(AUTO_RECONNECT_KEY.to_string(), legacy);
    }
    true
}

/// Whether auto-reconnect is enabled for a connection settings bag.
///
/// Reads [`AUTO_RECONNECT_KEY`], falling back to the legacy key for a bag that
/// has not been normalized yet, and to [`AUTO_RECONNECT_DEFAULT`] when neither
/// is present (or the value is not a boolean).
pub fn auto_reconnect_enabled(settings: &Value) -> bool {
    settings
        .get(AUTO_RECONNECT_KEY)
        .or_else(|| settings.get(LEGACY_RESILIENT_RECONNECT_KEY))
        .and_then(Value::as_bool)
        .unwrap_or(AUTO_RECONNECT_DEFAULT)
}

/// The connection types whose terminal tabs can auto-reconnect into the same
/// tab after a drop (#5390). The graphical types (RDP/VNC) run their own
/// reconnect loop and read [`auto_reconnect_enabled`] directly.
pub const TERMINAL_AUTO_RECONNECT_TYPES: &[&str] = &["ssh", "serial", "telnet"];

/// The per-type default for [`AUTO_RECONNECT_KEY`] (#5390): what an absent key
/// means for a connection of `type_id`.
///
/// - **`telnet` is off** — telnet is usually a short, interactive hop to a
///   network device, so retrying a closed session unasked is surprising. It is
///   opt-in per connection.
/// - **Every other type is on** ([`AUTO_RECONNECT_DEFAULT`]): SSH and the
///   graphical types as before (PARITY-008), and **`serial`**, which reopens its
///   port after a USB adapter drops — Tera Term's COM-port auto-reconnect.
///
/// Telnet never auto-reconnected before #5390, so its new default keeps every
/// existing telnet connection's behaviour; SSH keeps its default, and an
/// explicit choice always wins over the default.
pub fn auto_reconnect_default_for(type_id: &str) -> bool {
    match type_id {
        "telnet" => false,
        _ => AUTO_RECONNECT_DEFAULT,
    }
}

/// Whether auto-reconnect is enabled for a connection of `type_id` with
/// `settings`: the explicit [`AUTO_RECONNECT_KEY`] (or the legacy key) when it
/// is a boolean, else [`auto_reconnect_default_for`] the type (#5390).
///
/// Twin of the frontend's `isAutoReconnectEnabled(settings, type)`.
pub fn auto_reconnect_enabled_for(type_id: &str, settings: &Value) -> bool {
    settings
        .get(AUTO_RECONNECT_KEY)
        .or_else(|| settings.get(LEGACY_RESILIENT_RECONNECT_KEY))
        .and_then(Value::as_bool)
        .unwrap_or_else(|| auto_reconnect_default_for(type_id))
}

/// `#[serde(with = "...")]` module for a connection settings bag field
/// (`serde_json::Value`): serializes unchanged and applies
/// [`normalize_auto_reconnect`] and
/// [`normalize_save_password`](crate::connection::save_password::normalize_save_password)
/// on deserialize, so the legacy keys are accepted on read (the serde-alias
/// equivalent for an opaque bag).
pub mod settings_bag {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use serde_json::Value;

    /// Serialize the bag unchanged.
    pub fn serialize<S: Serializer>(value: &Value, serializer: S) -> Result<S::Ok, S::Error> {
        value.serialize(serializer)
    }

    /// Deserialize the bag, rewriting the legacy reconnect and save keys.
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Value, D::Error> {
        let mut value = Value::deserialize(deserializer)?;
        super::normalize_auto_reconnect(&mut value);
        crate::connection::save_password::normalize_save_password(&mut value);
        Ok(value)
    }
}

/// Like [`settings_bag`] for an optional bag (`Option<serde_json::Value>`).
pub mod optional_settings_bag {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use serde_json::Value;

    /// Serialize the optional bag unchanged.
    pub fn serialize<S: Serializer>(
        value: &Option<Value>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(serializer)
    }

    /// Deserialize the optional bag, rewriting the legacy reconnect and save keys.
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Value>, D::Error> {
        let mut value = Option::<Value>::deserialize(deserializer)?;
        if let Some(v) = value.as_mut() {
            super::normalize_auto_reconnect(v);
            crate::connection::save_password::normalize_save_password(v);
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_false_is_preserved_under_new_key() {
        let mut v = json!({ "host": "h", "resilientReconnect": false });
        assert!(normalize_auto_reconnect(&mut v));
        assert_eq!(v, json!({ "host": "h", "autoReconnect": false }));
    }

    #[test]
    fn legacy_true_is_preserved_under_new_key() {
        let mut v = json!({ "resilientReconnect": true });
        assert!(normalize_auto_reconnect(&mut v));
        assert_eq!(v, json!({ "autoReconnect": true }));
    }

    #[test]
    fn absent_key_is_left_absent_and_means_on() {
        let mut v = json!({ "host": "h" });
        assert!(!normalize_auto_reconnect(&mut v));
        assert_eq!(v, json!({ "host": "h" }));
        assert!(auto_reconnect_enabled(&v));
    }

    #[test]
    fn new_key_wins_over_legacy_key() {
        let mut v = json!({ "autoReconnect": false, "resilientReconnect": true });
        assert!(normalize_auto_reconnect(&mut v));
        assert_eq!(v, json!({ "autoReconnect": false }));
    }

    #[test]
    fn non_object_is_untouched() {
        let mut v = json!(null);
        assert!(!normalize_auto_reconnect(&mut v));
        assert_eq!(v, json!(null));
    }

    #[test]
    fn enabled_reads_new_then_legacy_then_default() {
        assert!(!auto_reconnect_enabled(&json!({ "autoReconnect": false })));
        assert!(auto_reconnect_enabled(&json!({ "autoReconnect": true })));
        assert!(!auto_reconnect_enabled(
            &json!({ "resilientReconnect": false })
        ));
        assert!(auto_reconnect_enabled(&json!({})));
        assert!(auto_reconnect_enabled(&json!({ "autoReconnect": "x" })));
    }

    #[test]
    fn per_type_defaults_serial_on_telnet_off_ssh_unchanged() {
        assert!(auto_reconnect_default_for("serial"));
        assert!(!auto_reconnect_default_for("telnet"));
        assert!(auto_reconnect_default_for("ssh"));
        assert!(auto_reconnect_enabled_for(
            "serial",
            &json!({ "port": "/dev/ttyUSB0" })
        ));
        assert!(!auto_reconnect_enabled_for(
            "telnet",
            &json!({ "host": "h" })
        ));
        assert!(auto_reconnect_enabled_for("ssh", &json!({ "host": "h" })));
    }

    #[test]
    fn explicit_choice_wins_over_the_per_type_default() {
        assert!(auto_reconnect_enabled_for(
            "telnet",
            &json!({ "autoReconnect": true })
        ));
        assert!(!auto_reconnect_enabled_for(
            "serial",
            &json!({ "autoReconnect": false })
        ));
        // An existing SSH connection keeps its choice, legacy key included.
        assert!(!auto_reconnect_enabled_for(
            "ssh",
            &json!({ "autoReconnect": false })
        ));
        assert!(!auto_reconnect_enabled_for(
            "ssh",
            &json!({ "resilientReconnect": false })
        ));
    }

    #[derive(serde::Deserialize, serde::Serialize)]
    struct Holder {
        #[serde(with = "settings_bag")]
        config: Value,
        #[serde(default, with = "optional_settings_bag")]
        extra: Option<Value>,
    }

    #[test]
    fn deserialize_hooks_accept_the_legacy_key() {
        let h: Holder = serde_json::from_value(json!({
            "config": { "resilientReconnect": false },
            "extra": { "resilientReconnect": true }
        }))
        .unwrap();
        assert_eq!(h.config, json!({ "autoReconnect": false }));
        assert_eq!(h.extra, Some(json!({ "autoReconnect": true })));

        // Only the new key is written back out.
        let out = serde_json::to_value(&h).unwrap();
        assert_eq!(
            out,
            json!({ "config": { "autoReconnect": false }, "extra": { "autoReconnect": true } })
        );

        let h: Holder = serde_json::from_value(json!({ "config": {} })).unwrap();
        assert_eq!(h.extra, None);
    }

    #[test]
    fn deserialize_hooks_accept_the_legacy_save_to_store_key() {
        let h: Holder = serde_json::from_value(json!({
            "config": { "saveToStore": true },
            "extra": { "saveToStore": true, "savePassword": false }
        }))
        .unwrap();
        assert_eq!(h.config, json!({ "savePassword": true }));
        assert_eq!(h.extra, Some(json!({ "savePassword": true })));
    }
}
