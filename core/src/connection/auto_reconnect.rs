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

/// `#[serde(with = "...")]` module for a connection settings bag field
/// (`serde_json::Value`): serializes unchanged and applies
/// [`normalize_auto_reconnect`] on deserialize, so the legacy key is accepted on
/// read (the serde-alias equivalent for an opaque bag).
pub mod settings_bag {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use serde_json::Value;

    /// Serialize the bag unchanged.
    pub fn serialize<S: Serializer>(value: &Value, serializer: S) -> Result<S::Ok, S::Error> {
        value.serialize(serializer)
    }

    /// Deserialize the bag, rewriting the legacy reconnect key.
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Value, D::Error> {
        let mut value = Value::deserialize(deserializer)?;
        super::normalize_auto_reconnect(&mut value);
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

    /// Deserialize the optional bag, rewriting the legacy reconnect key.
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Value>, D::Error> {
        let mut value = Option::<Value>::deserialize(deserializer)?;
        if let Some(v) = value.as_mut() {
            super::normalize_auto_reconnect(v);
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
}
