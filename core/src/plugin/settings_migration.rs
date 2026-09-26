//! Plugin settings migration on update (PROD-051 / PLG-012).
//!
//! A plugin's user settings live in the host's `plugin-settings.json`, keyed by
//! plugin id and then by the setting names the manifest declares under
//! `settings`. They are **not** versioned by the plugin; the contract is that the
//! manifest's declared `settings` schema *is* the version. When an installed
//! plugin is replaced by a different version, [`migrate_settings`] reconciles the
//! stored values against the **new** schema:
//!
//! * a stored value whose key is still declared and whose value still fits the
//!   declared type (and `enum`, when present) is **kept**;
//! * a stored value whose key is no longer declared, or whose type / allowed
//!   values changed so it no longer fits, is **dropped** — the new version's
//!   declared `default` then applies.
//!
//! So a plugin author who needs to change a setting's meaning or type should
//! introduce a **new key** (the old one is dropped, the new one starts at its
//! default) rather than reinterpret an existing one.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::manifest::{PluginSettingSchema, SettingType};

/// The result of reconciling stored settings against a new manifest schema.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SettingsMigration {
    /// The settings that carry over to the new version.
    pub kept: Map<String, Value>,
    /// The keys that were dropped (sorted), because they are no longer declared
    /// or no longer fit their declared type / allowed values.
    pub dropped: Vec<String>,
}

/// Whether `value` fits the declared `schema`.
fn fits(schema: &PluginSettingSchema, value: &Value) -> bool {
    match (schema.setting_type, value) {
        (SettingType::String, Value::String(s)) => schema
            .allowed_values
            .as_ref()
            .is_none_or(|allowed| allowed.iter().any(|a| a == s)),
        (SettingType::Number, Value::Number(_)) | (SettingType::Boolean, Value::Bool(_)) => true,
        _ => false,
    }
}

/// Reconcile a plugin's `stored` settings against the `schema` declared by the
/// version being installed. See the [module docs](self) for the contract.
#[must_use]
pub fn migrate_settings(
    stored: Map<String, Value>,
    schema: Option<&BTreeMap<String, PluginSettingSchema>>,
) -> SettingsMigration {
    let mut out = SettingsMigration::default();
    for (key, value) in stored {
        match schema.and_then(|s| s.get(&key)) {
            Some(declared) if fits(declared, &value) => {
                out.kept.insert(key, value);
            }
            _ => out.dropped.push(key),
        }
    }
    out.dropped.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> BTreeMap<String, PluginSettingSchema> {
        serde_json::from_value(json!({
            "prefix": { "type": "string", "default": "", "description": "d" },
            "mode": { "type": "string", "default": "a", "description": "d", "enum": ["a", "b"] },
            "limit": { "type": "number", "default": 5, "description": "d" },
            "verbose": { "type": "boolean", "default": false, "description": "d" }
        }))
        .unwrap()
    }

    fn stored(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn keeps_values_that_still_fit_the_new_schema() {
        let s = schema();
        let m = migrate_settings(
            stored(json!({ "prefix": ">", "mode": "b", "limit": 9, "verbose": true })),
            Some(&s),
        );
        assert_eq!(m.kept.len(), 4);
        assert!(m.dropped.is_empty());
    }

    #[test]
    fn drops_removed_keys_and_type_or_enum_mismatches() {
        let s = schema();
        let m = migrate_settings(
            stored(json!({
                "prefix": 3,
                "mode": "gone",
                "limit": "9",
                "verbose": true,
                "removed": "x"
            })),
            Some(&s),
        );
        assert_eq!(m.kept, stored(json!({ "verbose": true })));
        assert_eq!(m.dropped, vec!["limit", "mode", "prefix", "removed"]);
    }

    #[test]
    fn a_version_without_settings_drops_everything() {
        let m = migrate_settings(stored(json!({ "prefix": ">" })), None);
        assert!(m.kept.is_empty());
        assert_eq!(m.dropped, vec!["prefix"]);
    }
}
